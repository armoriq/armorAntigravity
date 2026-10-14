// Installs this checkout into an agy home for local testing; the real installer is #49.
// Usage: bun scripts/dev-install.ts --home <dir> --backend <url>
//        bun scripts/dev-install.ts --home <dir> --uninstall
// Builds armoriq-agd and agd-hook, registers the hook for all five events in ~/.gemini/config/hooks.json,
// the armoriq MCP server in ~/.gemini/config/mcp_config.json, the always-on rule in ~/.gemini/config/rules,
// and points the daemon at the backend in ~/.armoriq/armorantigravity/config.json. A manifest records what
// it created and the values it replaced, so --uninstall removes only that.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO = path.resolve(import.meta.dir, "..");
const EVENTS = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);
// Seconds. agd-hook gives up on its own after 3 s to start the daemon plus 10 s for an answer.
const HOOK_TIMEOUT = 30;
const KEY = "armoriq";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
// `created` is where the key path stopped existing before install, so uninstall removes exactly that subtree.
type KeyEdit = { file: string; key: string[]; had: boolean; previous: Json; created: number };
type Manifest = { v: 1; created: string[]; keys: KeyEdit[] };

const { values } = parseArgs({ options: { home: { type: "string" }, backend: { type: "string" }, uninstall: { type: "boolean" } }, strict: true });
const home = path.resolve(values.home ?? homedir());
const geminiConfig = path.join(home, ".gemini", "config");
const dataDir = path.join(home, ".armoriq", "armorantigravity");
const manifestPath = path.join(dataDir, "dev-install.json");

if (values.uninstall) uninstall();
else install(values.backend ?? fail("--backend <url> is required"));

function install(backend: string): void {
  if (!/^https?:\/\/[^\s]+$/.test(backend)) fail(`--backend must be an http(s) URL, got ${backend}`);
  const daemon = build("daemon", "armoriq-agd");
  const hook = build("hook", "agd-hook");
  const manifest = readManifest() ?? { v: 1, created: [], keys: [] };
  const before = JSON.stringify(manifest);

  const hookCommand = (event: string) => `ARMORANTIGRAVITY_DAEMON=${shellQuote(daemon)} ${shellQuote(hook)} ${event}`;
  const hooks: JsonObject = {};
  for (const event of EVENTS) {
    const entry: JsonObject = { type: "command", command: hookCommand(event), timeout: HOOK_TIMEOUT };
    hooks[event] = TOOL_EVENTS.has(event) ? [{ matcher: "*", hooks: [entry] }] : [entry];
  }
  setKey(manifest, path.join(geminiConfig, "hooks.json"), [KEY], hooks);
  setKey(manifest, path.join(geminiConfig, "mcp_config.json"), ["mcpServers", KEY], {
    command: process.execPath,
    args: [path.join(REPO, "packages", "mcp", "src", "main.ts")],
  });
  writeOwnFile(manifest, path.join(geminiConfig, "rules", "armoriq.md"), readFileSync(path.join(REPO, "packages", "mcp", "rules", "armoriq.md"), "utf8"));
  setKey(manifest, path.join(dataDir, "config.json"), ["backendUrl"], backend.replace(/\/+$/, ""));

  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  if (JSON.stringify(manifest) !== before || !existsSync(manifestPath)) {
    ensureDir(manifest, dataDir);
    writeFileSync(manifestPath, after);
  }
  console.log(`installed into ${home}`);
  console.log(`log in with: ARMORIQ_BACKEND_URL=${backend} armoriq login --product armorantigravity`);
  console.log("a running armoriq-agd reads its config at start; stop it to pick up changes");
}

function uninstall(): void {
  const manifest = readManifest();
  if (!manifest) {
    console.log(`nothing installed by dev-install in ${home}`);
    return;
  }
  // A copied home carries the original's manifest, whose paths point at the original home.
  const inHome = (p: string) => path.resolve(p).startsWith(home + path.sep);
  for (const edit of [...manifest.keys].reverse()) {
    if (!inHome(edit.file)) {
      console.log(`skipped ${edit.file}: outside ${home}`);
      continue;
    }
    if (!existsSync(edit.file)) continue;
    const doc = readJsonObject(edit.file);
    const next = edit.had ? setPath(doc, edit.key, edit.previous) : deletePath(doc, edit.key.slice(0, edit.created + 1));
    if (JSON.stringify(next) !== JSON.stringify(doc)) writeJson(edit.file, next);
  }
  unlinkSync(manifestPath);
  const edited = new Set(manifest.keys.map((k) => k.file));
  for (const p of [...manifest.created].reverse()) {
    if (!inHome(p) || !existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      if (readdirSync(p).length === 0) rmdirSync(p);
    } else if (!edited.has(p) || Object.keys(readJsonObject(p)).length === 0) {
      unlinkSync(p);
    }
  }
  stopDaemon();
  console.log(`uninstalled from ${home}`);
}

// The daemon holds its lock file with flock and writes its pid there; once the hooks are gone
// nothing would ever stop it.
function stopDaemon(): void {
  const lock = path.join(home, ".armoriq", "armorantigravity", "agd.sock.lock");
  const pid = existsSync(lock) ? Number.parseInt(readFileSync(lock, "utf8"), 10) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
    console.log(`stopped armoriq-agd (pid ${pid})`);
  } catch {
    // Already gone.
  }
}

function build(pkg: string, binary: string): string {
  const cwd = path.join(REPO, "packages", pkg);
  const result = spawnSync(process.execPath, ["run", "build"], { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) fail(`bun run build failed in packages/${pkg}`);
  const out = path.join(cwd, "dist", binary);
  if (!existsSync(out)) fail(`build did not produce ${out}`);
  return out;
}

function setKey(manifest: Manifest, file: string, key: string[], value: Json): void {
  ensureDir(manifest, path.dirname(file));
  const exists = existsSync(file);
  if (!exists) track(manifest, file);
  const doc = exists ? readJsonObject(file) : {};
  if (!manifest.keys.some((k) => k.file === file && k.key.join("\0") === key.join("\0"))) {
    const created = firstMissing(doc, key);
    const previous = created === -1 ? getPath(doc, key) : null;
    manifest.keys.push({ file, key, had: created === -1, previous: previous ?? null, created: Math.max(created, 0) });
  }
  const next = setPath(doc, key, value);
  if (!exists || JSON.stringify(next) !== JSON.stringify(doc)) writeJson(file, next);
}

function writeOwnFile(manifest: Manifest, file: string, content: string): void {
  ensureDir(manifest, path.dirname(file));
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;
  if (!existsSync(file)) track(manifest, file);
  writeFileSync(file, content);
}

function ensureDir(manifest: Manifest, dir: string): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    track(manifest, d);
    mkdirSync(d, { mode: 0o700 });
  }
}

function track(manifest: Manifest, p: string): void {
  if (!manifest.created.includes(p)) manifest.created.push(p);
}

function firstMissing(doc: JsonObject, key: readonly string[]): number {
  let node: Json = doc;
  for (const [i, k] of key.entries()) {
    if (!isObject(node) || !(k in node)) return i;
    node = node[k] ?? null;
  }
  return -1;
}

function getPath(doc: JsonObject, key: readonly string[]): Json | undefined {
  let node: Json | undefined = doc;
  for (const k of key) node = isObject(node) ? node[k] : undefined;
  return node;
}

function setPath(doc: JsonObject, key: readonly string[], value: Json): JsonObject {
  const [head, ...rest] = key;
  if (head === undefined) return doc;
  const child = doc[head];
  return { ...doc, [head]: rest.length === 0 ? value : setPath(isObject(child) ? child : {}, rest, value) };
}

function deletePath(doc: JsonObject, key: readonly string[]): JsonObject {
  const [head, ...rest] = key;
  if (head === undefined || !(head in doc)) return doc;
  if (rest.length === 0) {
    const { [head]: _removed, ...kept } = doc;
    return kept;
  }
  const child = doc[head];
  return isObject(child) ? { ...doc, [head]: deletePath(child, rest) } : doc;
}

// mcp_config.json and hooks.json accept comments and trailing commas (PRD N2).
function readJsonObject(file: string): JsonObject {
  const text = readFileSync(file, "utf8");
  // agy creates an empty mcp_config.json on first run.
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON or JSONC (${String(error)}); fix it or move it aside`);
  }
  const doc = toJson(parsed);
  if (!isObject(doc)) fail(`${file} must hold a JSON object`);
  return doc;
}

function readManifest(): Manifest | null {
  if (!existsSync(manifestPath)) return null;
  const raw = readJsonObject(manifestPath);
  const { v, created, keys } = raw;
  if (v !== 1 || !Array.isArray(created) || !Array.isArray(keys)) fail(`${manifestPath} is not a dev-install manifest`);
  const edits: KeyEdit[] = [];
  for (const k of keys) {
    if (!isObject(k) || typeof k.file !== "string" || !Array.isArray(k.key) || typeof k.had !== "boolean" || typeof k.created !== "number") fail(`${manifestPath} has a malformed key edit`);
    const key = k.key.filter((s): s is string => typeof s === "string");
    if (key.length !== k.key.length) fail(`${manifestPath} has a malformed key path`);
    edits.push({ file: k.file, key, had: k.had, previous: k.previous ?? null, created: k.created });
  }
  return { v: 1, created: created.filter((p): p is string => typeof p === "string"), keys: edits };
}

function toJson(value: unknown): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    const items = value.map(toJson);
    return items.every((i): i is Json => i !== undefined) ? items : undefined;
  }
  if (typeof value !== "object") return undefined;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    const j = toJson(v);
    if (j === undefined) return undefined;
    out[k] = j;
  }
  return out;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(file: string, doc: JsonObject): void {
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function fail(message: string): never {
  console.error(`dev-install: ${message}`);
  process.exit(1);
}
