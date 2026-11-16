import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyStagedUpdate,
  archiveName,
  compareVersions,
  createUpdater,
  isNewerVersion,
  parseVersion,
  platformTag,
  readUpdateStatus,
  type CheckResult,
  type UpdaterOptions,
} from "../src/update.ts";
import { sandboxHome } from "./sandbox.ts";

const PLATFORM = platformTag();
const ARCHIVE = archiveName(PLATFORM);
const quiet = { info() {}, warn() {}, error() {} };
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

let sandbox: ReturnType<typeof sandboxHome>;
let dataDir: string;
let binDir: string;
let releases: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: string[] = [];

// Shaped like a real release archive: two node wrappers with the unbound NODE="" line, their bundles
// and agd-hook, hashed into a real SHA256SUMS and served over real HTTP.
const MEMBERS = ["armorantigravity", "armoriq-agd", "agd-hook", "cli.js", "agd.js"];
function buildRelease(version: string): void {
  const stage = path.join(releases, `stage-${version}`);
  mkdirSync(stage, { recursive: true });
  for (const name of MEMBERS) {
    const body = name.endsWith(".js") ? `console.log("${name} ${version}");\n` : name === "agd-hook" ? `#!/bin/sh\n# agd-hook ${version}\n` : `#!/bin/sh\nNODE=""\n# ${name} ${version}\n`;
    writeFileSync(path.join(stage, name), body, { mode: 0o755 });
  }
  const archive = path.join(releases, ARCHIVE);
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, ...MEMBERS]);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  writeFileSync(path.join(releases, "SHA256SUMS"), `${sha256(archive)}  ${ARCHIVE}\n`);
}

function serve(handler?: (url: URL) => Response | null | Promise<Response | null>): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      const custom = await handler?.(url);
      if (custom) return custom;
      if (url.pathname === "/releases/latest" || url.pathname === "/releases/tags/dev-latest") {
        const dev = url.pathname.endsWith("dev-latest");
        const tag = dev ? "dev-latest" : readFileSync(path.join(releases, "TAG"), "utf8").trim();
        const base = `http://127.0.0.1:${server?.port}/download`;
        return Response.json({
          tag_name: tag,
          name: dev ? "dev-latest (0.1.0, abc1234)" : tag,
          assets: [ARCHIVE, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `${base}/${name}` })),
        });
      }
      const file = path.join(releases, path.basename(url.pathname));
      return existsSync(file) ? new Response(readFileSync(file)) : new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const tag = (value: string) => writeFileSync(path.join(releases, "TAG"), `${value}\n`);

function updater(opts: Partial<UpdaterOptions> & { apiUrl: string }) {
  return createUpdater({ log: quiet, env: {}, channel: "stable", dataDir, binDir, currentVersion: "0.1.0", ...opts });
}

const OLD_ARCHIVE_SHA = "1".repeat(64);
const writeReceipt = (archiveSha: string) => writeFileSync(path.join(dataDir, "release.sha256"), `${archiveSha}\n`);

beforeEach(() => {
  sandbox = sandboxHome();
  dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  binDir = path.join(dataDir, "bin");
  releases = path.join(sandbox.home, "releases");
  mkdirSync(releases, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeReceipt(OLD_ARCHIVE_SHA);
  requests = [];
});

afterEach(() => {
  server?.stop(true);
  server = null;
  sandbox.cleanup();
});

test("parses and orders release tags, and treats a malformed tag as no update", () => {
  expect(parseVersion("v1.2.3")).toEqual({ parts: [1, 2, 3], prerelease: [] });
  expect(parseVersion("1.2.3-dev.g4318160")).toEqual({ parts: [1, 2, 3], prerelease: ["dev", "g4318160"] });
  for (const bad of ["", "v1.2", "1.2.3.4", "latest", "dev-latest", "v1.2.x", "v1.2.3-"]) expect(parseVersion(bad)).toBeNull();

  const cmp = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);
  expect(cmp("0.1.0", "0.1.0")).toBe(0);
  expect(cmp("0.2.0", "0.1.9")).toBe(1);
  expect(cmp("0.1.0", "0.1.1")).toBe(-1);
  expect(cmp("1.0.0", "0.9.9")).toBe(1);
  expect(cmp("0.2.0", "0.2.0-dev.g1")).toBe(1);
  expect(cmp("0.2.0-dev.2", "0.2.0-dev.10")).toBe(-1);

  expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
  expect(isNewerVersion("v0.1.0", "0.1.0")).toBe(false);
  expect(isNewerVersion("v0.0.9", "0.1.0")).toBe(false);
  expect(isNewerVersion("dev-latest", "0.1.0")).toBe(false);
  expect(isNewerVersion("v0.2.0", "not-a-version")).toBe(false);
  expect(isNewerVersion("v0.2.0-dev.g1", "0.2.0")).toBe(false);
});

test("the opt-out answers before any network call", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  const result = await updater({ apiUrl: `${url}`, env: { ARMORANTIGRAVITY_NO_AUTO_UPDATE: "1" } }).check();
  expect(result).toEqual({ kind: "opted_out" });
  expect(requests).toEqual([]);
  expect(existsSync(path.join(dataDir, "update.json"))).toBe(false);
});

test("an install the installer never recorded is not updated", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  rmSync(path.join(dataDir, "release.sha256"));
  expect(await updater({ apiUrl: url }).check()).toEqual({ kind: "not_installed" });
  expect(requests).toEqual([]);
});

test("the dev channel follows dev-latest by archive hash, not version", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.1.0");
  let clock = 1;
  const u = updater({ apiUrl: url, channel: "dev", now: () => clock, intervalMs: 10 });
  expect(await u.check()).toEqual({ kind: "staged", version: "dev-latest (0.1.0, abc1234)" });
  expect(requests).toEqual(["/releases/tags/dev-latest", "/download/SHA256SUMS", `/download/${ARCHIVE}`]);

  clock += 10;
  requests = [];
  expect(await u.check()).toEqual({ kind: "no_update", latest: "dev-latest (0.1.0, abc1234)" });
  expect(requests).toEqual(["/releases/tags/dev-latest", "/download/SHA256SUMS"]);

  expect(applyStagedUpdate({ log: quiet, env: {}, channel: "dev", dataDir, binDir, currentVersion: "0.1.0", nodePath: "/opt/node/bin/node" })).toBe("dev-latest (0.1.0, abc1234)");
  clock += 10;
  requests = [];
  expect(await u.check()).toEqual({ kind: "no_update", latest: "dev-latest (0.1.0, abc1234)" });
  expect(requests).not.toContain(`/download/${ARCHIVE}`);
});

test("a stable install never stages the dev build, and a staged update for the other channel is discarded", async () => {
  const url = serve();
  tag("v0.1.0");
  buildRelease("0.1.0");
  expect((await updater({ apiUrl: url }).check()).kind).toBe("no_update");
  expect(requests).toEqual(["/releases/latest"]);

  expect((await updater({ apiUrl: url, channel: "dev", intervalMs: 0 }).check()).kind).toBe("staged");
  expect(applyStagedUpdate({ log: quiet, env: {}, channel: "stable", dataDir, binDir, currentVersion: "0.1.0" })).toBeNull();
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
  expect(existsSync(path.join(binDir, "armoriq-agd"))).toBe(false);
});

test("downloads, verifies and stages a newer release, then suppresses the next check for the interval", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  let clock = 1_000_000;
  const u = updater({ apiUrl: url, now: () => clock, intervalMs: 86_400_000 });

  expect(await u.check()).toEqual({ kind: "staged", version: "v0.9.0" });
  const staged = path.join(dataDir, "staged", ARCHIVE);
  expect(sha256(staged)).toBe(sha256(path.join(releases, ARCHIVE)));
  expect(readUpdateStatus(dataDir)).toEqual({ lastCheckedAt: 1_000_000, lastSeenVersion: "v0.9.0", stagedVersion: "v0.9.0" });
  const after = [...requests];
  expect(after).toEqual(["/releases/latest", "/download/SHA256SUMS", `/download/${ARCHIVE}`]);

  clock += 86_399_999;
  expect(await u.check()).toEqual({ kind: "too_soon", nextCheckAt: 1_000_000 + 86_400_000 });
  expect(requests).toEqual(after);

  clock += 2;
  expect(await u.check()).toEqual({ kind: "no_update", latest: "v0.9.0" });
  expect(requests.length).toBe(after.length + 1);
});

test("a release at or below the running version is not downloaded", async () => {
  const url = serve();
  tag("v0.1.0");
  buildRelease("0.1.0");
  expect(await updater({ apiUrl: url }).check()).toEqual({ kind: "no_update", latest: "v0.1.0" });
  expect(requests).toEqual(["/releases/latest"]);
});

test("a checksum mismatch rejects the update and stages nothing", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  writeFileSync(path.join(releases, "SHA256SUMS"), `${"0".repeat(64)}  ${ARCHIVE}\n`);

  const result = await updater({ apiUrl: url }).check();
  expect(result.kind).toBe("rejected");
  expect(result.kind === "rejected" && result.reason).toContain(`checksum mismatch for ${ARCHIVE}`);
  expect(existsSync(path.join(dataDir, "staged", ARCHIVE))).toBe(false);
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
});

test("SHA256SUMS without an entry for this platform rejects the update", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  writeFileSync(path.join(releases, "SHA256SUMS"), `${"0".repeat(64)}  armorantigravity-plan9-mips.tar.gz\n`);
  const result = await updater({ apiUrl: url }).check();
  expect(result).toEqual({ kind: "rejected", latest: "v0.9.0", reason: `SHA256SUMS has no entry for ${ARCHIVE}` });
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
});

test("a check that times out is swallowed and still backs off", async () => {
  const url = serve(async (u) => (u.pathname === "/releases/latest" ? (await Bun.sleep(2_000), new Response("late")) : null));
  let clock = 5_000;
  const u = updater({ apiUrl: url, timeoutMs: 100, now: () => clock, intervalMs: 60_000 });
  const result = await u.check();
  expect(result.kind).toBe("unreachable");
  expect(readUpdateStatus(dataDir).lastCheckedAt).toBe(5_000);
  clock += 1_000;
  expect((await u.check()).kind).toBe("too_soon");
});

test("a refused connection is swallowed", async () => {
  const result = await updater({ apiUrl: "http://127.0.0.1:1/nothing" }).check();
  expect(result.kind).toBe("unreachable");
  expect(result.kind === "unreachable" && result.reason).not.toBe("");
});

test("a releases API answer without a tag is not an update", async () => {
  const url = serve((u) => (u.pathname === "/releases/latest" ? Response.json({ message: "Not Found" }) : null));
  expect((await updater({ apiUrl: url }).check()).kind).toBe("unreachable");
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
});

test("applies every archive member, binds the wrappers to the running node, and writes the installer's receipt", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  for (const name of MEMBERS) writeFileSync(path.join(binDir, name), "#!/bin/sh\n# old\n", { mode: 0o755 });
  expect((await updater({ apiUrl: url }).check()).kind).toBe("staged");

  const applied = applyStagedUpdate({ log: quiet, env: {}, channel: "stable", dataDir, binDir, currentVersion: "0.1.0", nodePath: "/Users/a b/node" });
  expect(applied).toBe("v0.9.0");
  for (const name of MEMBERS) {
    const file = path.join(binDir, name);
    expect(readFileSync(file, "utf8")).toContain(`${name} 0.9.0`);
    expect(statSync(file).mode & 0o777).toBe(0o755);
  }
  expect(readFileSync(path.join(binDir, "armoriq-agd"), "utf8")).toStartWith("#!/bin/sh\nNODE='/Users/a b/node'\n");
  expect(readFileSync(path.join(binDir, "agd-hook"), "utf8")).not.toContain("NODE=");
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
  expect(existsSync(path.join(dataDir, "staged", ARCHIVE))).toBe(false);
  expect(readdirSync(path.join(dataDir, "staged"))).toEqual([]);

  // Byte for byte what the installer's installed_fingerprint prints, so its next run skips the download.
  const fingerprint = [`${sha256(path.join(releases, ARCHIVE))}\n`, ...["armorantigravity", "armoriq-agd", "agd-hook"].map((n) => `${sha256(path.join(binDir, n))}  ${n}\n`)].join("");
  expect(readFileSync(path.join(dataDir, "release.sha256"), "utf8")).toBe(fingerprint);
  expect(applyStagedUpdate({ log: quiet, env: {}, channel: "stable", dataDir, binDir, currentVersion: "0.9.0" })).toBeNull();
});

test("a staged archive that changed on disk is discarded instead of applied", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  expect((await updater({ apiUrl: url }).check()).kind).toBe("staged");
  const staged = path.join(dataDir, "staged", ARCHIVE);
  writeFileSync(staged, "tampered");

  expect(applyStagedUpdate({ log: quiet, env: {}, channel: "stable", dataDir, binDir, currentVersion: "0.1.0" })).toBeNull();
  expect(existsSync(path.join(binDir, "armorantigravity"))).toBe(false);
  expect(readUpdateStatus(dataDir).stagedVersion).toBeNull();
  expect(existsSync(staged)).toBe(false);
});

test("the opt-out also stops a staged update from being applied", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  expect((await updater({ apiUrl: url }).check()).kind).toBe("staged");
  expect(applyStagedUpdate({ log: quiet, env: { ARMORANTIGRAVITY_NO_AUTO_UPDATE: "1" }, channel: "stable", dataDir, binDir, currentVersion: "0.1.0" })).toBeNull();
  expect(readUpdateStatus(dataDir).stagedVersion).toBe("v0.9.0");
});

test("start() checks after its delay and stop() ends the schedule", async () => {
  const url = serve();
  tag("v0.1.0");
  buildRelease("0.1.0");
  const u = updater({ apiUrl: url, pollMs: 50, firstCheckDelayMs: 20, intervalMs: 0 });
  u.start();
  expect(requests).toEqual([]);
  await Bun.sleep(150);
  expect(requests.length).toBeGreaterThan(1);
  const seen: CheckResult = await u.check();
  expect(seen.kind).toBe("no_update");
  await u.stop();
  const after = requests.length;
  await Bun.sleep(150);
  expect(requests.length).toBe(after);
});

test("ARMORANTIGRAVITY_UPDATE_API_URL redirects the check", async () => {
  const url = serve();
  tag("v0.9.0");
  buildRelease("0.9.0");
  const u = createUpdater({ log: quiet, env: { ARMORANTIGRAVITY_UPDATE_API_URL: url }, channel: "stable", dataDir, binDir, currentVersion: "0.1.0" });
  expect((await u.check()).kind).toBe("staged");
  expect(requests[0]).toBe("/releases/latest");
});
