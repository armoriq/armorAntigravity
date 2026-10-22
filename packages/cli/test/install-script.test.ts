import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = path.resolve(import.meta.dir, "..", "..", "..", "install_armorantigravity.sh");
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ARCHIVE = `armorantigravity-${os}-${arch}.tar.gz`;

let root: string;
let home: string;
let release: string;

// Stand-ins for the compiled binaries: the CLI records how the script called it.
function buildRelease(): void {
  const stage = path.join(root, "stage");
  mkdirSync(stage);
  writeFileSync(path.join(stage, "armorantigravity"), `#!/bin/sh\necho "release-cli $*" >> "${root}/calls"\n`, { mode: 0o755 });
  for (const name of ["armoriq-agd", "agd-hook"]) writeFileSync(path.join(stage, name), "#!/bin/sh\n", { mode: 0o755 });
  Bun.spawnSync(["tar", "-czf", path.join(release, ARCHIVE), "-C", stage, "armoriq-agd", "agd-hook", "armorantigravity"]);
  const sum = createHash("sha256").update(readFileSync(path.join(release, ARCHIVE))).digest("hex");
  writeFileSync(path.join(release, "SHA256SUMS"), `${sum}  ${ARCHIVE}\n`);
}

function runScript(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root, ARMORANTIGRAVITY_RELEASE_URL: pathToFileURL(release).href, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}
const calls = () => {
  try {
    return readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agy-script-"));
  home = path.join(root, "home");
  release = path.join(root, "release");
  mkdirSync(home);
  mkdirSync(release);
  buildRelease();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("verifies the archive and runs the stable install from it", () => {
  const { code, out } = runScript([]);
  expect(code).toBe(0);
  expect(out).toContain(`verified ${ARCHIVE}`);
  expect(calls()).toEqual(["release-cli install --channel stable"]);
});

test("the dev channel passes the backend and login flags through", () => {
  const { code } = runScript(["--skip-login"], { ARMORANTIGRAVITY_CHANNEL: "dev", ARMORIQ_BACKEND_URL: "https://staging-api.armoriq.io" });
  expect(code).toBe(0);
  expect(calls()).toEqual(["release-cli install --channel dev --backend https://staging-api.armoriq.io --skip-login"]);
});

test("refuses an archive whose checksum does not match", () => {
  writeFileSync(path.join(release, "SHA256SUMS"), `${"0".repeat(64)}  ${ARCHIVE}\n`);
  const { code, out } = runScript([]);
  expect(code).toBe(1);
  expect(out).toContain(`checksum mismatch for ${ARCHIVE}`);
  expect(calls()).toEqual([]);
});

test("refuses a release with no checksum for this platform", () => {
  writeFileSync(path.join(release, "SHA256SUMS"), `${"0".repeat(64)}  armorantigravity-plan9-mips.tar.gz\n`);
  const { code, out } = runScript([]);
  expect(code).toBe(1);
  expect(out).toContain(`SHA256SUMS has no entry for ${ARCHIVE}`);
  expect(calls()).toEqual([]);
});

test("uninstall runs the installed CLI without downloading", () => {
  const bin = path.join(home, ".armoriq", "armorantigravity", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "armorantigravity"), `#!/bin/sh\necho "installed-cli $*" >> "${root}/calls"\n`, { mode: 0o755 });
  rmSync(release, { recursive: true });
  const { code } = runScript(["--uninstall", "--purge", "--logout"]);
  expect(code).toBe(0);
  expect(calls()).toEqual(["installed-cli uninstall --purge --logout"]);
});

test("uninstall falls back to the release CLI when nothing is installed", () => {
  expect(runScript(["--uninstall"]).code).toBe(0);
  expect(calls()).toEqual(["release-cli uninstall"]);
});

test("rejects uninstall flags without --uninstall and unknown channels", () => {
  expect(runScript(["--purge"]).code).toBe(2);
  expect(runScript([], { ARMORANTIGRAVITY_CHANNEL: "beta" }).code).toBe(2);
  expect(calls()).toEqual([]);
});
