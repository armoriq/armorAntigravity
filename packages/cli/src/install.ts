import rules from "@armorantigravity/mcp/rules/armoriq.md" with { type: "text" };
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { isEmptyObjectAt, removeMember, setMember, type Json, type JsonObject } from "./jsonc.ts";
import { renderUnit, serviceFor, startService, stopService, type Run, type Service } from "./service.ts";

export const PRODUCT = "armorantigravity";
export type Channel = "stable" | "dev";
export const DEFAULT_BACKENDS: Readonly<Record<Channel, string>> = { stable: "https://api.armoriq.ai", dev: "https://staging-api.armoriq.io" };
export const BINARIES = ["armoriq-agd", "agd-hook", "armorantigravity"] as const;

const EVENTS = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);
// Seconds. agd-hook gives up on its own after 3 s to start the daemon plus 10 s for an answer.
const HOOK_TIMEOUT = 30;
const HOOKS_KEY = ["armoriq"];
const MCP_KEY = ["mcpServers", "armoriq"];
const SOCKET_WAIT_MS = 10_000;
// In every version of the rule this installer or dev-install wrote.
const RULE_MARKER = "ArmorIQ intent enforcement";

export interface Layout {
  readonly home: string;
  readonly geminiConfig: string;
  readonly hooksFile: string;
  readonly mcpFile: string;
  readonly rulesFile: string;
  readonly dataDir: string;
  readonly binDir: string;
  readonly configFile: string;
  readonly manifestFile: string;
  readonly socket: string;
  readonly lockFile: string;
}

export function layout(home: string): Layout {
  const geminiConfig = path.join(home, ".gemini", "config");
  const dataDir = path.join(home, ".armoriq", PRODUCT);
  const socket = path.join(dataDir, "agd.sock");
  return {
    home,
    geminiConfig,
    hooksFile: path.join(geminiConfig, "hooks.json"),
    mcpFile: path.join(geminiConfig, "mcp_config.json"),
    rulesFile: path.join(geminiConfig, "rules", "armoriq.md"),
    dataDir,
    binDir: path.join(dataDir, "bin"),
    configFile: path.join(dataDir, "config.json"),
    manifestFile: path.join(dataDir, "install.json"),
    socket,
    lockFile: `${socket}.lock`,
  };
}

// `original` is the file as it was before the first install, minus any ArmorIQ entry an earlier
// dev-install left; null when the file did not exist. `written` is what this installer last wrote,
// so an untouched file is restored byte for byte and an edited one gets only our entry removed.
type FileRecord = { original: string | null; written: string };
export interface Manifest {
  readonly v: 1;
  version: string;
  channel: Channel;
  backend: string;
  files: Record<string, FileRecord>;
  createdDirs: string[];
  service: Service | null;
}

export interface Deps {
  readonly run: Run;
  readonly log: (line: string) => void;
  readonly platform: NodeJS.Platform;
  // Service label override, so a sandboxed install never touches the real one.
  readonly serviceLabel: string | null;
  readonly socketWaitMs?: number;
}

export interface InstallOptions {
  readonly home: string;
  readonly sourceDir: string;
  readonly version: string;
  readonly channel: Channel;
  readonly backend: string;
}

export interface InstallResult {
  readonly changed: string[];
  readonly service: Service | null;
  readonly daemonUp: boolean;
  // Config files agy cannot load: it parses both as strict JSON and skips a file with comments
  // or trailing commas entirely (agy 1.4.5: "invalid character '/' looking for beginning of value").
  readonly notStrictJson: string[];
}

export function hooksValue(binDir: string): JsonObject {
  const hook = path.join(binDir, "agd-hook");
  const hooks: JsonObject = {};
  for (const event of EVENTS) {
    const entry: JsonObject = { type: "command", command: `${shellQuote(hook)} ${event}`, timeout: HOOK_TIMEOUT };
    hooks[event] = TOOL_EVENTS.has(event) ? [{ matcher: "*", hooks: [entry] }] : [entry];
  }
  return hooks;
}

export function mcpValue(binDir: string): JsonObject {
  return { command: path.join(binDir, "armorantigravity"), args: ["mcp"] };
}

export function normalizeBackend(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`backend must be an http(s) URL, got ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/+$/, "") !== "") {
    throw new Error(`backend must be an http(s) origin such as ${DEFAULT_BACKENDS.stable}, got ${url}`);
  }
  return parsed.origin;
}

// Throws before anything is written when a config file cannot be edited safely.
export function preflight(home: string): void {
  const l = layout(home);
  for (const file of [l.hooksFile, l.mcpFile]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    // A dry run of both edits install and uninstall make.
    const [key, value] = file === l.hooksFile ? [HOOKS_KEY, hooksValue(l.binDir)] : [MCP_KEY, mcpValue(l.binDir)];
    try {
      setMember(removeOurs(text, key), key, value);
      removeOurs(setMember(text, key, value), key);
    } catch (error) {
      throw new Error(`${file} cannot be edited safely (${error instanceof Error ? error.message : String(error)}); fix it and re-run. Nothing was changed.`);
    }
  }
  if (existsSync(l.manifestFile)) readManifest(l.manifestFile);
}

export async function install(opts: InstallOptions, deps: Deps): Promise<InstallResult> {
  const l = layout(opts.home);
  const backend = normalizeBackend(opts.backend);
  for (const name of BINARIES) if (!existsSync(path.join(opts.sourceDir, name))) throw new Error(`${name} is missing from ${opts.sourceDir}`);
  preflight(opts.home);

  const previous = existsSync(l.manifestFile) ? readManifest(l.manifestFile) : null;
  const manifest: Manifest = previous ?? { v: 1, version: opts.version, channel: opts.channel, backend, files: {}, createdDirs: [], service: null };
  const changed: string[] = [];

  ensureDir(manifest, l.binDir);
  for (const name of BINARIES) if (copyBinary(path.join(opts.sourceDir, name), path.join(l.binDir, name))) changed.push(path.join(l.binDir, name));

  const config = readConfigFile(l.configFile);
  const nextConfig = { ...config, backendUrl: backend, channel: opts.channel };
  if (JSON.stringify(nextConfig) !== JSON.stringify(config) || !existsSync(l.configFile)) {
    writeAtomic(l.configFile, `${JSON.stringify(nextConfig, null, 2)}\n`);
    changed.push(l.configFile);
  }

  ensureDir(manifest, l.geminiConfig);
  if (editConfig(manifest, l.hooksFile, HOOKS_KEY, hooksValue(l.binDir))) changed.push(l.hooksFile);
  if (editConfig(manifest, l.mcpFile, MCP_KEY, mcpValue(l.binDir))) changed.push(l.mcpFile);
  ensureDir(manifest, path.dirname(l.rulesFile));
  const rulesBefore = existsSync(l.rulesFile) ? readFileSync(l.rulesFile, "utf8") : null;
  if (!manifest.files[l.rulesFile]) {
    manifest.files[l.rulesFile] = { original: rulesBefore !== null && !rulesBefore.includes(RULE_MARKER) ? rulesBefore : null, written: rules };
  }
  if (rulesBefore !== rules) {
    writeAtomic(l.rulesFile, rules);
    changed.push(l.rulesFile);
  }

  const devManifest = path.join(l.dataDir, "dev-install.json");
  if (existsSync(devManifest)) {
    unlinkSync(devManifest);
    deps.log(`took over the dev-install in ${opts.home}; scripts/dev-install.ts --uninstall no longer applies`);
  }

  const service = serviceFor(deps.platform, opts.home, deps.serviceLabel);
  if (previous?.service && previous.service.unitPath !== service?.unitPath) removeService(previous.service, deps.run);
  // A daemon started by an older hook or binary keeps the socket until it exits.
  if (service) stopService(service, deps.run);
  await stopDaemon(l, deps.run, deps.log);
  if (service) {
    ensureDir(manifest, path.dirname(service.unitPath));
    const unit = renderUnit(service, opts.home, path.join(l.binDir, "armoriq-agd"));
    if (!existsSync(service.unitPath) || readFileSync(service.unitPath, "utf8") !== unit) {
      writeAtomic(service.unitPath, unit);
      changed.push(service.unitPath);
    }
    startService(service, deps.run);
  } else {
    deps.log(`no service manager for ${deps.platform}; agd-hook starts armoriq-agd on first use`);
  }

  Object.assign(manifest, { version: opts.version, channel: opts.channel, backend, service });
  writeAtomic(l.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const daemonUp = service ? await waitForSocket(l.socket, deps.socketWaitMs ?? SOCKET_WAIT_MS) : false;
  const notStrictJson = [l.hooksFile, l.mcpFile].filter((f) => !isStrictJson(readFileSync(f, "utf8")));
  return { changed, service, daemonUp, notStrictJson };
}

function isStrictJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export interface UninstallOptions {
  readonly home: string;
  readonly purge: boolean;
}

export async function uninstall(opts: UninstallOptions, deps: Deps): Promise<string[]> {
  const l = layout(opts.home);
  const manifest = existsSync(l.manifestFile) ? readManifest(l.manifestFile) : null;
  const removed: string[] = [];

  // Hooks go first, so a running Antigravity cannot start the daemon again once it is stopped.
  for (const [file, key] of [[l.hooksFile, HOOKS_KEY], [l.mcpFile, MCP_KEY]] as const) {
    if (!existsSync(file)) continue;
    const record = manifest?.files[file];
    const current = readFileSync(file, "utf8");
    if (record && current === record.written) {
      if (record.original === null) unlinkSync(file);
      else writeAtomic(file, record.original);
      removed.push(`${record.original === null ? "removed" : "restored"} ${file}`);
      continue;
    }
    let next: string;
    try {
      next = removeOurs(current, key);
    } catch (error) {
      deps.log(`left ${file} unchanged: ${error instanceof Error ? error.message : String(error)}; remove its armoriq entry by hand`);
      continue;
    }
    if (next === current) continue;
    if (record?.original === null && isEmptyObjectAt(next, [])) {
      unlinkSync(file);
      removed.push(`removed ${file}`);
    } else {
      writeAtomic(file, next);
      removed.push(`removed the armoriq entry from ${file}`);
    }
  }

  const service = manifest?.service ?? serviceFor(deps.platform, opts.home, deps.serviceLabel);
  if (service) {
    if (existsSync(service.unitPath)) removed.push(`removed ${service.unitPath}`);
    removeService(service, deps.run);
  }
  await stopDaemon(l, deps.run, deps.log);

  const rulesOriginal = manifest?.files[l.rulesFile]?.original ?? null;
  if (rulesOriginal !== null) {
    writeAtomic(l.rulesFile, rulesOriginal);
    removed.push(`restored ${l.rulesFile}`);
  }
  for (const file of rulesOriginal === null ? [l.rulesFile, l.manifestFile] : [l.manifestFile]) {
    if (existsSync(file)) {
      unlinkSync(file);
      removed.push(`removed ${file}`);
    }
  }
  if (existsSync(l.binDir)) {
    rmSync(l.binDir, { recursive: true, force: true });
    removed.push(`removed ${l.binDir}`);
  }
  if (opts.purge && existsSync(l.dataDir)) {
    rmSync(l.dataDir, { recursive: true, force: true });
    removed.push(`removed ${l.dataDir}`);
  }
  for (const dir of [...(manifest?.createdDirs ?? [])].reverse()) {
    if (!dir.startsWith(opts.home + path.sep) || !existsSync(dir)) continue;
    if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir);
  }
  return removed;
}

function removeOurs(text: string, key: readonly string[]): string {
  let next = removeMember(text, key);
  const parent = key.slice(0, -1);
  if (next !== text && parent.length > 0 && isEmptyObjectAt(next, parent)) next = removeMember(next, parent);
  return next;
}

function editConfig(manifest: Manifest, file: string, key: readonly string[], value: Json): boolean {
  const exists = existsSync(file);
  const current = exists ? readFileSync(file, "utf8") : null;
  const record = manifest.files[file];
  // Edited, replaced or deleted since our last write: re-baseline on what is there now.
  if (!record || current !== record.written) {
    manifest.files[file] = { original: current === null ? null : removeOurs(current, key), written: current ?? "" };
  }
  const next = setMember(current ?? "", key, value);
  const entry = manifest.files[file];
  if (entry) entry.written = next;
  if (next === current) return false;
  writeAtomic(file, next);
  return true;
}

function readConfigFile(file: string): JsonObject {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

export function readManifest(file: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null || !("v" in raw) || raw.v !== 1) throw new Error(`${file} is not an ArmorAntigravity install manifest`);
  const m = raw as Manifest;
  if (typeof m.files !== "object" || m.files === null || !Array.isArray(m.createdDirs)) throw new Error(`${file} is malformed`);
  return m;
}

function removeService(service: Service, run: Run): void {
  stopService(service, run);
  if (existsSync(service.unitPath)) unlinkSync(service.unitPath);
  if (service.kind === "systemd") run(["systemctl", "--user", "daemon-reload"]);
}

// The daemon writes its pid into the lock it holds. The pid is checked against the process name
// first, because a stale lock file can name a pid the system has since reused.
export async function stopDaemon(l: Layout, run: Run, log: (line: string) => void): Promise<void> {
  if (!existsSync(l.lockFile)) return;
  const pid = Number.parseInt(readFileSync(l.lockFile, "utf8"), 10);
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return;
  const command = run(["ps", "-o", "command=", "-p", String(pid)]).output;
  if (!command.includes("armoriq-agd")) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  log(`stopped armoriq-agd (pid ${pid})`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForSocket(socket: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await connects(socket)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(100);
  }
}

function connects(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => resolve(false));
  });
}

function ensureDir(manifest: Manifest, dir: string): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    mkdirSync(d, { mode: 0o700 });
    if (!manifest.createdDirs.includes(d)) manifest.createdDirs.push(d);
  }
}

function copyBinary(from: string, to: string): boolean {
  if (existsSync(to) && realpathSync(from) === realpathSync(to)) return false;
  if (existsSync(to) && sameBytes(from, to)) return false;
  const tmp = `${to}.tmp-${process.pid}`;
  copyFileSync(from, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, to);
  return true;
}

function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return Bun.hash(readFileSync(a)) === Bun.hash(readFileSync(b));
}

// Same-directory rename, keeping the target's mode and following a symlinked config to its target.
function writeAtomic(file: string, text: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : 0o600;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.armorantigravity-${process.pid}`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
