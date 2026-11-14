// Builds the release archives install_armorantigravity.sh downloads: one armorantigravity-<platform>.tar.gz
// per target holding armoriq-agd, agd-hook, armorantigravity and the two node bundles the wrappers run,
// plus SHA256SUMS over every archive in --out.
// Usage: bun scripts/build-release.ts [--target darwin-arm64 ...] [--out dist/release] [--sums-only]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compileHook, type HookTarget } from "./build-hook.ts";
import { buildAll } from "./build-js.ts";
import { BUNDLES } from "../packages/cli/src/wrapper.ts";

const REPO = path.resolve(import.meta.dir, "..");
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
// Nothing here embeds a runtime any more. agd-hook is C (scripts/build-hook.ts), and the CLI and daemon
// are node bundles behind a wrapper (scripts/build-js.ts), which took the download from 60 MB to under
// one. See armoriq/armorAntigravity#165.
const ARCHIVE_FILES = ["armorantigravity", "armoriq-agd", "agd-hook", ...BUNDLES.map((b) => b.script)] as const;

const { values } = parseArgs({
  options: { target: { type: "string", multiple: true }, out: { type: "string" }, "sums-only": { type: "boolean" } },
  strict: true,
});
const out = path.resolve(values.out ?? path.join(REPO, "dist", "release"));
mkdirSync(out, { recursive: true });

if (!values["sums-only"]) {
  for (const platform of values.target ?? PLATFORMS) {
    if (!(PLATFORMS as readonly string[]).includes(platform)) fail(`unknown target ${platform}; expected one of ${PLATFORMS.join(", ")}`);
    const stage = path.join(out, platform);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    buildAll(stage);
    compileHook(platform as HookTarget, path.join(stage, "agd-hook"));
    const archive = path.join(out, `armorantigravity-${platform}.tar.gz`);
    run(["tar", "-czf", archive, "-C", stage, ...ARCHIVE_FILES]);
    rmSync(stage, { recursive: true, force: true });
    console.log(`built ${archive}`);
  }
}

const archives = readdirSync(out).filter((f) => /^armorantigravity-.+\.tar\.gz$/.test(f)).sort();
if (archives.length === 0) fail(`no archives in ${out}`);
const sums = archives.map((f) => `${createHash("sha256").update(readFileSync(path.join(out, f))).digest("hex")}  ${f}\n`).join("");
writeFileSync(path.join(out, "SHA256SUMS"), sums);
process.stdout.write(sums);

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) fail(`${cmd.join(" ")} exited with ${result.exitCode}`);
}

function fail(message: string): never {
  console.error(`build-release: ${message}`);
  process.exit(1);
}
