import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import type { Log } from "./log.ts";
import type { Env } from "./paths.ts";

export const REPO = "armoriq/armorAntigravity";
export const GITHUB_API = `https://api.github.com/repos/${REPO}`;
export const NO_AUTO_UPDATE_ENV = "ARMORANTIGRAVITY_NO_AUTO_UPDATE";
// Repository API base to read releases from, for a mirror or an end-to-end test of the real binary.
export const API_URL_ENV = "ARMORANTIGRAVITY_UPDATE_API_URL";
// The rolling prerelease every push to dev replaces. Dev installs follow it; stable installs follow
// releases/latest, which never returns a prerelease.
export const DEV_TAG = "dev-latest";
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 5_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
// The installer writes its receipt only after `armorantigravity install` has started the daemon, so
// the first check waits for it instead of finding the install unrecorded.
const FIRST_CHECK_DELAY_MS = 60_000;
const POLL_MS = 15 * 60 * 1000;
// Exit code the daemon uses after applying a staged update, so KeepAlive and Restart=on-failure
// start the replaced binary. A zero exit would leave the old process gone and nothing restarted.
export const RESTART_EXIT_CODE = 75;
// The order the installer hashes them in; the receipt must match it byte for byte. The archive also
// carries the node bundles these wrappers run.
export const ARCHIVE_BINARIES = ["armorantigravity", "armoriq-agd", "agd-hook"] as const;
const RECEIPT = "release.sha256";

export type CheckResult =
  | { readonly kind: "opted_out" }
  | { readonly kind: "not_installed" }
  | { readonly kind: "too_soon"; readonly nextCheckAt: number }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "no_update"; readonly latest: string }
  | { readonly kind: "rejected"; readonly latest: string; readonly reason: string }
  | { readonly kind: "staged"; readonly version: string };

interface Staged {
  readonly version: string;
  readonly channel: Config["channel"];
  readonly archive: string;
  readonly sha256: string;
  readonly stagedAt: number;
}

interface UpdateState {
  readonly lastCheckedAt: number;
  readonly lastSeenVersion: string | null;
  readonly staged: Staged | null;
}

const EMPTY_STATE: UpdateState = { lastCheckedAt: 0, lastSeenVersion: null, staged: null };

interface Version {
  readonly parts: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export function parseVersion(tag: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((id) => id === "")) return null;
  return { parts: [major, minor, patch], prerelease };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const [x, y] = [a.prerelease[i], b.prerelease[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// A tag neither side can parse is never an update: an unreadable release must not trigger a download.
export function isNewerVersion(candidate: string, current: string): boolean {
  const [a, b] = [parseVersion(candidate), parseVersion(current)];
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

export function platformTag(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu) throw new Error(`no release archive for ${platform}-${arch}`);
  return `${os}-${cpu}`;
}

export const archiveName = (platform: string) => `armorantigravity-${platform}.tar.gz`;

const sha256 = (data: Uint8Array | Buffer) => createHash("sha256").update(data).digest("hex");

function sumFor(sums: string, archive: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (!hash || !name) continue;
    if (name === archive || name === `*${archive}`) return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  }
  return null;
}

type Asset = { readonly name: string; readonly url: string };

interface Release {
  readonly tag: string;
  readonly name: string | null;
  readonly assets: readonly Asset[];
}

function parseRelease(raw: unknown): Release | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tag = "tag_name" in raw && typeof raw.tag_name === "string" ? raw.tag_name : null;
  if (!tag) return null;
  const name = "name" in raw && typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : null;
  const list = "assets" in raw && Array.isArray(raw.assets) ? raw.assets : [];
  const assets: Asset[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = "name" in entry && typeof entry.name === "string" ? entry.name : null;
    const url = "browser_download_url" in entry && typeof entry.browser_download_url === "string" ? entry.browser_download_url : null;
    if (name && url) assets.push({ name, url });
  }
  return { tag, name, assets };
}

// The archive hash the installer or the last applied update recorded. Without it the install was not
// made from a release archive, such as a source checkout, and is never replaced.
export function installedArchiveSha(dataDir: string): string | null {
  try {
    const first = readFileSync(path.join(dataDir, RECEIPT), "utf8").split("\n")[0]?.trim() ?? "";
    return /^[0-9a-f]{64}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

export interface UpdaterOptions {
  readonly log: Log;
  readonly env: Env;
  readonly channel: Config["channel"];
  readonly dataDir: string;
  readonly binDir: string;
  readonly currentVersion?: string;
  readonly apiUrl?: string;
  readonly platform?: string;
  readonly now?: () => number;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly intervalMs?: number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly firstCheckDelayMs?: number;
}

export interface Updater {
  check(): Promise<CheckResult>;
  start(): void;
  stop(): Promise<void>;
}

export const optedOut = (env: Env): boolean => {
  const value = env[NO_AUTO_UPDATE_ENV]?.trim() ?? "";
  return value !== "" && value !== "0";
};

export function createUpdater(opts: UpdaterOptions): Updater {
  const { log, env, dataDir, binDir } = opts;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const apiUrl = (opts.apiUrl ?? (env[API_URL_ENV]?.trim() || GITHUB_API)).replace(/\/+$/, "");
  const current = opts.currentVersion ?? pkg.version;
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const stateFile = path.join(dataDir, "update.json");
  const stagedDir = path.join(dataDir, "staged");
  const stopping = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<CheckResult> | null = null;

  const signal = (ms: number) => AbortSignal.any([stopping.signal, AbortSignal.timeout(ms)]);

  async function get(url: string, ms: number): Promise<Response> {
    const res = await doFetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": `armorantigravity/${current}` }, signal: signal(ms) });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res;
  }

  async function run(): Promise<CheckResult> {
    if (optedOut(env)) return { kind: "opted_out" };
    const installed = installedArchiveSha(dataDir);
    if (!installed) return { kind: "not_installed" };
    const state = readState(stateFile);
    const at = now();
    if (state.lastCheckedAt > 0 && at < state.lastCheckedAt + intervalMs) return { kind: "too_soon", nextCheckAt: state.lastCheckedAt + intervalMs };
    // Persisted before the request, so a hung or failing check still backs off for a full interval.
    writeState(stateFile, { ...state, lastCheckedAt: at });

    let platform: string;
    try {
      platform = opts.platform ?? platformTag();
    } catch (error) {
      return { kind: "unreachable", reason: String(error) };
    }
    const archive = archiveName(platform);
    const dev = opts.channel === "dev";
    const staged = state.staged?.channel === opts.channel ? state.staged : null;

    let release: Release | null;
    try {
      release = parseRelease(await (await get(dev ? `${apiUrl}/releases/tags/${DEV_TAG}` : `${apiUrl}/releases/latest`, timeoutMs)).json());
    } catch (error) {
      log.info("update check failed", { error: String(error) });
      return { kind: "unreachable", reason: String(error) };
    }
    if (!release) return { kind: "unreachable", reason: "the releases API answered without a tag_name" };
    // dev-latest keeps one tag across builds, so its title, which names the version and commit, is the label.
    const label = dev ? (release.name ?? release.tag) : release.tag;
    writeState(stateFile, { ...readState(stateFile), lastSeenVersion: label });
    if (!dev) {
      const floor = staged && isNewerVersion(staged.version, current) ? staged.version : current;
      if (!isNewerVersion(release.tag, floor)) return { kind: "no_update", latest: label };
    }

    const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
    const archiveAsset = release.assets.find((a) => a.name === archive);
    if (!sumsAsset || !archiveAsset) return { kind: "rejected", latest: label, reason: `release ${release.tag} has no ${sumsAsset ? archive : "SHA256SUMS"}` };

    let bytes: Uint8Array;
    let want: string | null;
    try {
      want = sumFor(await (await get(sumsAsset.url, timeoutMs)).text(), archive);
      if (!want) return { kind: "rejected", latest: label, reason: `SHA256SUMS has no entry for ${archive}` };
      // A dev build is identified by its archive hash: the version stays the same across many pushes.
      if (want === installed || want === staged?.sha256) return { kind: "no_update", latest: label };
      bytes = new Uint8Array(await (await get(archiveAsset.url, downloadTimeoutMs)).arrayBuffer());
    } catch (error) {
      log.info("update download failed", { error: String(error) });
      return { kind: "unreachable", reason: String(error) };
    }

    const got = sha256(bytes);
    if (got !== want) {
      log.warn("staged update rejected: checksum mismatch", { version: label, expected: want, got });
      return { kind: "rejected", latest: label, reason: `checksum mismatch for ${archive}: expected ${want}, got ${got}` };
    }

    const target = path.join(stagedDir, archive);
    mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, target);
    writeState(stateFile, { ...readState(stateFile), staged: { version: label, channel: opts.channel, archive: target, sha256: want, stagedAt: now() } });
    log.info("update staged; it is applied once no session is open, or at the next daemon start", { version: label, from: current, channel: opts.channel });
    return { kind: "staged", version: label };
  }

  return {
    check: () => (inflight ??= run().finally(() => (inflight = null))),

    start() {
      if (timer || optedOut(env)) return;
      const tick = () => void this.check().catch(() => {});
      timer = setTimeout(() => {
        tick();
        timer = setInterval(tick, opts.pollMs ?? POLL_MS);
        timer.unref?.();
      }, opts.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
      timer.unref?.();
    },

    async stop() {
      clearTimeout(timer);
      clearInterval(timer);
      timer = undefined;
      stopping.abort();
      await inflight?.catch(() => {});
    },
  };
}

export interface ApplyOptions {
  readonly log: Log;
  readonly env: Env;
  readonly channel: Config["channel"];
  readonly dataDir: string;
  readonly binDir: string;
  readonly currentVersion?: string;
  // The interpreter the archive's node wrappers are bound to. The installer binds them to the node
  // that ran it; the daemon runs under that same node, so an update keeps it.
  readonly nodePath?: string;
}

// Runs at daemon start, before the socket exists, so no session can be interrupted. Returns the
// version moved into place, or null when there is nothing to apply.
export function applyStagedUpdate(opts: ApplyOptions): string | null {
  const { log, dataDir, binDir } = opts;
  if (optedOut(opts.env)) return null;
  const current = opts.currentVersion ?? pkg.version;
  const stateFile = path.join(dataDir, "update.json");
  const state = readState(stateFile);
  const staged = state.staged;
  if (!staged) return null;
  // Cleared first: an apply that cannot finish must not be retried on every start.
  writeState(stateFile, { ...state, staged: null });
  const discard = () => rmSync(staged.archive, { force: true });
  const wanted =
    staged.channel === opts.channel && staged.sha256 !== installedArchiveSha(dataDir) && (staged.channel === "dev" || isNewerVersion(staged.version, current));
  if (!wanted) {
    discard();
    return null;
  }

  const unpack = path.join(dataDir, "staged", `apply-${process.pid}`);
  try {
    const got = sha256(readFileSync(staged.archive));
    if (got !== staged.sha256) {
      log.warn("staged update discarded: checksum mismatch", { version: staged.version, expected: staged.sha256, got });
      return null;
    }
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true, mode: 0o700 });
    execFileSync("tar", ["-xzf", staged.archive, "-C", unpack], { stdio: ["ignore", "ignore", "pipe"] });
    const files = readdirSync(unpack).filter((name) => statSync(path.join(unpack, name)).isFile());
    const missing = ARCHIVE_BINARIES.filter((name) => !files.includes(name));
    if (missing.length > 0) throw new Error(`the archive has no ${missing.join(", ")}`);
    const node = opts.nodePath ?? process.execPath;
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    // Bundles first and the entry points last, so nothing new starts against an old bundle.
    const ordered = [...files.filter((name) => !(ARCHIVE_BINARIES as readonly string[]).includes(name)), ...ARCHIVE_BINARIES];
    for (const name of ordered) {
      const from = path.join(unpack, name);
      const text = readFileSync(from, "utf8");
      if (text.startsWith("#!/bin/sh\n") && /^NODE=""$/m.test(text)) writeFileSync(from, text.replace(/^NODE=""$/m, `NODE=${shellQuote(node)}`));
      chmodSync(from, 0o755);
      renameSync(from, path.join(binDir, name));
    }
    writeReceipt(dataDir, binDir, staged.sha256);
    log.info("staged update applied", { version: staged.version, from: current });
    return staged.version;
  } catch (error) {
    log.error("staged update could not be applied", { version: staged.version, error: String(error) });
    return null;
  } finally {
    rmSync(unpack, { recursive: true, force: true });
    discard();
  }
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// The same fingerprint the installer writes, so a later installer run sees the new
// binaries as already downloaded and verified instead of fetching the archive again.
function writeReceipt(dataDir: string, binDir: string, archiveSha: string): void {
  const lines = [`${archiveSha}\n`];
  for (const name of ARCHIVE_BINARIES) lines.push(`${sha256(readFileSync(path.join(binDir, name)))}  ${name}\n`);
  writeFileSync(path.join(dataDir, RECEIPT), lines.join(""), { mode: 0o600 });
}

export interface UpdateStatus {
  readonly lastCheckedAt: number;
  readonly lastSeenVersion: string | null;
  readonly stagedVersion: string | null;
}

export function readUpdateStatus(dataDir: string): UpdateStatus {
  const state = readState(path.join(dataDir, "update.json"));
  return { lastCheckedAt: state.lastCheckedAt, lastSeenVersion: state.lastSeenVersion, stagedVersion: state.staged?.version ?? null };
}

function readState(file: string): UpdateState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
    const lastCheckedAt = "lastCheckedAt" in raw && typeof raw.lastCheckedAt === "number" && Number.isFinite(raw.lastCheckedAt) ? raw.lastCheckedAt : 0;
    const lastSeenVersion = "lastSeenVersion" in raw && typeof raw.lastSeenVersion === "string" ? raw.lastSeenVersion : null;
    return { lastCheckedAt, lastSeenVersion, staged: parseStaged("staged" in raw ? raw.staged : null) };
  } catch {
    return EMPTY_STATE;
  }
}

function parseStaged(raw: unknown): Staged | null {
  if (typeof raw !== "object" || raw === null) return null;
  const version = "version" in raw && typeof raw.version === "string" ? raw.version : null;
  const archive = "archive" in raw && typeof raw.archive === "string" ? raw.archive : null;
  const channel = "channel" in raw && raw.channel === "dev" ? "dev" : "stable";
  const hash = "sha256" in raw && typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/.test(raw.sha256) ? raw.sha256 : null;
  const stagedAt = "stagedAt" in raw && typeof raw.stagedAt === "number" ? raw.stagedAt : 0;
  if (!version || !archive || !hash || !existsSync(archive)) return null;
  return { version, channel, archive, sha256: hash, stagedAt };
}

function writeState(file: string, state: UpdateState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}
