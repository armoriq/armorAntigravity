import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileLog } from "../src/log.ts";
import { createAuth, type Auth } from "../src/auth.ts";
import { readConfig } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import type { HookEvent, HookResponse } from "@armorantigravity/protocol";
import type { PluginRegistration } from "../src/plugin.ts";
import { startDaemon, type RunningDaemon } from "../src/daemon.ts";
import { sandboxHome } from "./sandbox.ts";
import contract from "./fixtures/install-ping-v1.json";
import pkg from "../package.json";

type Reach = typeof import("../src/reach.ts");
let reach: Reach;
let box: ReturnType<typeof sandboxHome>;
let daemon: RunningDaemon | undefined;
let isolatedAuth: Auth | undefined;
let registration: PluginRegistration;
let clock: number;
let verdict: HookResponse;
let sent: { url: string; init: RequestInit; body: Record<string, any> }[];
let messages: string[];
let conversationId: string;
const quiet = { info() {}, warn() {}, error() {} };
const day = "2026-11-15";
const previous = "2026-11-14";
const id = contract.examples.valid[0]!.installId;
const armoriq = () => path.join(box.home, ".armoriq");
const dir = (environment = "production") => path.join(armoriq(), "reach/v1/armorantigravity", environment);
const counts = (date = day) => path.join(dir(), `counts-${date}.ndjson`);
const configFile = () => path.join(armoriq(), "armorantigravity/config.json");
function config(value: unknown) {
  mkdirSync(path.dirname(configFile()), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(value));
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(async () => {
  box = sandboxHome();
  clock = Date.parse(`${day}T23:59:59.000Z`);
  verdict = { decision: "allow" };
  sent = [];
  messages = [];
  const module = await import("../src/reach.ts").catch(() => null);
  expect(module?.reachPlugin).toBeFunction();
  reach = module!;
});
afterEach(async () => { await stop(); box?.cleanup(); });

async function boot(env: Record<string, string | undefined> = {}, send?: (url: string, init: RequestInit) => Promise<Response>, notifier = (message: string) => { messages.push(message); }) {
  // A new conversation produces session_start even when the daemon restores older snapshots.
  conversationId = `private-conversation-${crypto.randomUUID()}`;
  // Existing ping cases isolate the independent reminder. Reminder cases explicitly enable it.
  env = { ARMORIQ_SIGNIN_REMINDER_DISABLED: "1", ...env };
  const plugin = reach.reachPlugin({ env, now: () => clock, notifier, fetch: send ?? (async (url, init) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) });
  daemon = await startDaemon({ env, log: fileLog(path.join(armoriq(), "armorantigravity/logs/agd.log"), false), plugins: [
    { name: "decision", setup: () => ({ decide: () => verdict }) },
    { ...plugin, async setup(ctx) { registration = await plugin.setup(ctx); return registration; } },
  ] });
}
async function stop() {
  if (isolatedAuth) {
    await registration.pumps![0]!.stop();
    isolatedAuth.stop(); isolatedAuth = undefined;
  }
  if (!daemon) return;
  await turn();
  await daemon.stop();
  daemon = undefined;
}

async function bootDirect(env: Record<string, string> = {}, send?: (url: string, init: RequestInit) => Promise<Response>) {
  const paths = resolvePaths(env);
  isolatedAuth = createAuth(quiet, { env, config: readConfig(paths.configFile, quiet), dataDir: paths.dataDir });
  registration = await reach.reachPlugin({ env, now: () => clock, notifier: (text) => { messages.push(text); }, fetch: send ?? (async (url, init) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) }).setup({ paths, auth: isolatedAuth, log: quiet, sessions: { get: () => undefined, all: () => [] } });
}
async function directHook(event: HookEvent = "PreToolUse") {
  registration.observe!({ kind: "hook", hook: { event } as never, response: verdict, at: clock });
  await turn();
}
function hook(event: HookEvent = "PreToolUse"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(daemon!.paths.socket);
    socket.on("error", reject);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (text) => {
      buffer += text;
      if (buffer.includes("\n")) { socket.end(); resolve(JSON.parse(buffer).response); }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id: "reach-test", event, receivedAt: clock, payload: {
      conversationId, workspacePaths: ["/planted/private/repo"], transcriptPath: "/planted/private/transcript",
      artifactDirectoryPath: "/planted/private/artifacts", modelName: hostname(),
      toolCall: { name: "private_tool_name", args: { key: "planted-secret" } }, stepIdx: 1,
      invocationNum: 0, initialNumSteps: 0, error: "",
    } })}\n`));
  });
}

// Small schema interpreter, deliberately checked against every contract example.
function schemaValid(value: any, schema: any): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (!types.includes(type)) return false;
  if ("const" in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "string" && ((schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.maxLength && value.length > schema.maxLength))) return false;
  if (typeof value === "number" && (value < schema.minimum || value > schema.maximum)) return false;
  if (type === "object") {
    if (schema.required.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (Object.keys(value).some((key) => !(key in schema.properties))) return false;
    return Object.entries(schema.properties).every(([key, child]) => !Object.hasOwn(value, key) || schemaValid(value[key], child));
  }
  if (type === "array") return value.length <= schema.maxItems && value.every((entry: unknown) => schemaValid(entry, schema.items));
  return true;
}
function bodyValid(body: any): boolean {
  if (!schemaValid(body, contract.schema)) return false;
  const pairs: Record<string, string> = { armorclaude: "claude-code", armorcodex: "codex", armoropencode: "opencode", armorantigravity: "antigravity" };
  return pairs[body.plugin] === body.hostAgent && new Set(body.localCounts.map((entry: any) => entry.day)).size === body.localCounts.length &&
    body.localCounts.every((entry: any) => { const time = Date.parse(`${entry.day}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === entry.day; });
}
test("contract checker accepts all valid examples and rejects every invalid example", () => {
  for (const body of contract.examples.valid) expect(bodyValid(body)).toBe(true);
  for (const { body } of contract.examples.invalid) expect(bodyValid(body)).toBe(false);
});

for (const [index, vector] of contract.optOut.testVectors.entries()) {
  const v = vector as { env: Record<string, string>; settings: unknown; settingsJson?: unknown; settingsReadable?: boolean; enabled: boolean; plugin?: string; pluginConfig?: unknown };
  if (v.plugin && v.plugin !== "armorantigravity") continue;
  test(`opt out contract vector ${index} writes nothing when disabled`, async () => {
    mkdirSync(armoriq(), { recursive: true });
    const file = path.join(armoriq(), "settings.json");
    if (v.settingsReadable === false) mkdirSync(file);
    else if (Object.hasOwn(v, "settingsJson")) writeFileSync(file, JSON.stringify(v.settingsJson));
    else if (v.settings !== null) writeFileSync(file, v.settings === "malformed" ? "{" : JSON.stringify(v.settings));
    if (v.pluginConfig) config(v.pluginConfig);
    await boot(v.env);
    verdict = { decision: "deny", reason: "guard" };
    await hook();
    await stop();
    expect(sent.length).toBe(v.enabled ? 1 : 0);
    expect(existsSync(path.join(armoriq(), "install-id"))).toBe(v.enabled);
    expect(existsSync(path.join(armoriq(), "reach"))).toBe(v.enabled);
    expect(messages).toEqual(v.enabled ? [contract.notice] : []);
  });
}

for (const origin of [...contract.origins.production, ...contract.origins.staging,
  "http://api.armoriq.ai", "https://api.armoriq.ai:444", "https://user:pass@api.armoriq.ai", "https://api.armoriq.ai/prefix", "https://api.armoriq.ai.evil", "https://API.armoriq.ai", "https://api.armoriq.ai?x=1", "https://api.armoriq.ai#x"]) {
  test(`backend origin ${origin} obeys the exact allowlist`, async () => {
    config({ backendUrl: origin });
    await boot(); await hook(); await stop();
    const environment = contract.origins.production.includes(origin) ? "production" : contract.origins.staging.includes(origin) ? "staging" : null;
    expect(sent.length).toBe(environment ? 1 : 0);
    if (environment) { expect(sent[0]!.url).toBe(`${origin}/install-pings`); expect(sent[0]!.body.environment).toBe(environment); }
    else expect(existsSync(path.join(armoriq(), "reach"))).toBe(false);
  });
}

test("install id is complete, private, reused across races and shared with other plugins, never a device id", async () => {
  const ids = await Promise.all(Array.from({ length: 30 }, () => reach.ensureInstallId(armoriq())));
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toMatch(new RegExp(contract.schema.properties.installId.pattern));
  expect(readFileSync(path.join(armoriq(), "install-id"), "utf8")).toBe(`${ids[0]}\n`);
  expect(lstatSync(armoriq()).mode & 0o777).toBe(0o700);
  expect(lstatSync(path.join(armoriq(), "install-id")).mode & 0o777).toBe(0o600);
  expect(readdirSync(armoriq())).toEqual(["install-id"]);
  await boot(); await hook(); await stop();
  expect(sent[0]!.body.installId).toBe(ids[0]);
  expect(existsSync(path.join(armoriq(), "device-id"))).toBe(false);
});
test("an interrupted candidate write leaves no install id or temporary file", async () => {
  const open = fs.open;
  const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp")) handle.writeFile = async () => { throw new Error("disk full"); };
    return handle;
  });
  try {
    expect(await reach.ensureInstallId(armoriq())).toBeNull();
    expect(readdirSync(armoriq())).toEqual([]);
  } finally { mock.mockRestore(); }
});
test("an old candidate file cannot prevent install id creation", async () => {
  mkdirSync(armoriq());
  const stale = path.join(armoriq(), "install-id.99999.crashed.tmp");
  writeFileSync(stale, "partial");
  const created = await reach.ensureInstallId(armoriq());
  expect(created).toMatch(new RegExp(contract.schema.properties.installId.pattern));
  expect(readFileSync(stale, "utf8")).toBe("partial");
  expect(readdirSync(armoriq()).sort()).toEqual(["install-id", "install-id.99999.crashed.tmp"]);
});
test("install id falls back to one exclusive write on a filesystem without hard links", async () => {
  const mock = spyOn(fs, "link").mockImplementation(async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  try {
    const created = await reach.ensureInstallId(armoriq());
    expect(created).toMatch(new RegExp(contract.schema.properties.installId.pattern));
    expect(readFileSync(path.join(armoriq(), "install-id"), "utf8")).toBe(`${created}\n`);
    expect(lstatSync(path.join(armoriq(), "install-id")).mode & 0o777).toBe(0o600);
    expect(readdirSync(armoriq())).toEqual(["install-id"]);
  } finally { mock.mockRestore(); }
});
for (const kind of ["symlink", "invalid", "empty", "unreadable", "directory", "no newline", "uppercase"]) {
  test(`existing ${kind} install id is preserved and suppresses the ping`, async () => {
    mkdirSync(armoriq(), { mode: 0o700 });
    const file = path.join(armoriq(), "install-id");
    const contents = kind === "empty" ? "" : kind === "invalid" ? "bad\n" : kind === "uppercase" ? `${id.toUpperCase()}\n` : kind === "no newline" ? id : `${id}\n`;
    if (kind === "directory") mkdirSync(file);
    else if (kind === "symlink") { writeFileSync(path.join(box.home, "target"), contents); symlinkSync(path.join(box.home, "target"), file); }
    else writeFileSync(file, contents, { mode: kind === "unreadable" ? 0 : 0o600 });
    const before = lstatSync(file);
    await boot(); await hook(); await stop();
    expect(sent).toEqual([]);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(lstatSync(file).mode).toBe(before.mode);
    expect(readdirSync(armoriq()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (kind !== "directory") { chmodSync(file, 0o600); expect(readFileSync(file, "utf8")).toBe(contents); }
    expect(existsSync(dir())).toBe(false);
  });
}

test("one anonymous daily attempt across events, channels and restarts; UTC rollover allows the next day", async () => {
  await boot(); await hook(); await hook("PreInvocation"); await stop();
  expect(sent).toHaveLength(1);
  config({ channel: "dev" });
  await boot(); await hook(); await stop(); expect(sent).toHaveLength(1);
  clock += 1000;
  await boot(); await hook(); await stop(); expect(sent).toHaveLength(2);
  for (const request of sent) {
    expect(bodyValid(request.body)).toBe(true);
    expect(request.body).toMatchObject({ plugin: "armorantigravity", hostAgent: "antigravity", pluginVersion: pkg.version, hostVersion: null, signedIn: false });
    expect(JSON.stringify(request.body)).not.toMatch(/planted|private_tool_name|private-conversation/);
    expect(JSON.stringify(request.body)).not.toContain(hostname());
    expect(request.init.headers).toEqual({ "content-type": "application/json" });
    expect(request.init.method).toBe("POST"); expect(request.init.redirect).toBe("error");
  }
  expect(lstatSync(path.join(dir(), `ping-${day}`)).mode & 0o777).toBe(0o600);
});

test("environment override chooses the backend and config opt outs are read again on every event", async () => {
  config({ usagePing: false, backendUrl: "https://api.armoriq.ai" });
  await boot({ ARMORIQ_BACKEND_URL: "https://staging-api.armoriq.io" });
  await hook(); await turn(); await Bun.sleep(20);
  expect(sent).toEqual([]);
  config({ usagePing: true, backendUrl: "https://api.armoriq.ai" });
  await hook(); await stop();
  expect(sent[0]!.url).toBe("https://staging-api.armoriq.io/install-pings");
});

test("opt out is rechecked after claiming and immediately before sending", async () => {
  const link = fs.link;
  const mock = spyOn(fs, "link").mockImplementation(async (from, to) => {
    await link(from, to);
    config({ usagePing: false });
  });
  try { await boot(); await hook(); await stop(); expect(sent).toEqual([]); }
  finally { mock.mockRestore(); }
});

test("observe only schedules work and stays below 20 ms at p95 with file calls guarded", async () => {
  await boot();
  const open = spyOn(fs, "open"); const read = spyOn(fs, "readFile"); const mkdir = spyOn(fs, "mkdir");
  try {
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      registration.observe!({ kind: "session_start", session: {} as never, at: clock });
      samples.push(performance.now() - start);
    }
    expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(sent).toEqual([]);
    expect(messages).toEqual([]);
    expect(samples.sort((a, b) => a - b)[94]!).toBeLessThan(20);
  } finally { open.mockRestore(); read.mockRestore(); mkdir.mockRestore(); }
  await stop(); expect(sent).toHaveLength(1);
});

test("after daily decisions later events only append counters until UTC rollover", async () => {
  const { emitPlanSuccess } = await import("@armorantigravity/intent");
  await bootDirect(reminderOn); sessionStart(); await directHook();
  while (!sent.length) await turn();
  await Bun.sleep(30);
  const open = spyOn(fs, "open"); const lstat = spyOn(fs, "lstat");
  try {
    sessionStart();
    verdict = { decision: "deny", reason: "guard" };
    await directHook(); emitPlanSuccess();
    await Bun.sleep(30);
    expect(open.mock.calls.map(([file]) => String(file))).toEqual([counts(), counts()]);
    expect(lstat).not.toHaveBeenCalled();
    expect(messages).toHaveLength(2);
    expect(sent).toHaveLength(1);
  } finally { open.mockRestore(); lstat.mockRestore(); }
  clock += 1000;
  await directHook(); await stop();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body.localCounts).toEqual([{ day, plans: 1, blocked: 1, held: 0 }]);
});

test("daily claim already taken is remembered without repeating file reads", async () => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(path.join(dir(), `ping-${day}`), "");
  await bootDirect(); sessionStart(); await directHook(); await Bun.sleep(50);
  const open = spyOn(fs, "open"); const lstat = spyOn(fs, "lstat");
  try {
    await directHook("PostToolUse"); sessionStart();
    await stop();
    expect(open).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  } finally { open.mockRestore(); lstat.mockRestore(); }
});

test("reach queue drops excess work while a file operation is stalled", async () => {
  await bootDirect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const openFile = fs.open;
  const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    await gate;
    return openFile(...args);
  });
  try {
    sessionStart(); await turn();
    for (let i = 0; i < 256; i++) registration.observe!({
      kind: "hook", hook: { event: "PreToolUse" } as never,
      response: { decision: "deny", reason: "guard" }, at: clock,
    });
    release(); await stop();
    const lines = readFileSync(counts(), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(32);
  } finally { release(); open.mockRestore(); }
});

test("blocked, held, and plan successes count only while signed out; today stays local", async () => {
  const { emitPlanSuccess } = await import("@armorantigravity/intent");
  await boot();
  for (const response of [{ decision: "deny", reason: "guard" }, { decision: "deny", reason: "[approval_required]" }, { decision: "ask", reason: "ask" }, { decision: "force_ask", reason: "ask" }, { decision: "allow" }] as HookResponse[]) {
    verdict = response; await hook();
  }
  emitPlanSuccess();
  await stop();
  const lines = readFileSync(counts(), "utf8").trim().split("\n").map((line) => JSON.parse(line).t);
  expect(lines.sort()).toEqual(["blocked", "held", "held", "held", "plan"]);
  expect(lstatSync(counts()).mode & 0o777).toBe(0o600);
  expect(sent[0]!.body.localCounts).toEqual([]);
  await boot({ ARMORIQ_API_KEY: "test-key" });
  verdict = { decision: "deny", reason: "guard" };
  await hook(); emitPlanSuccess(); await stop();
  expect(readFileSync(counts(), "utf8").trim().split("\n")).toHaveLength(5);
  clock += 1000;
  await boot({ ARMORIQ_API_KEY: "test-key" }); await hook(); await stop();
  expect(sent.at(-1)!.body.signedIn).toBe(true);
  expect(existsSync(counts("2026-11-16"))).toBe(false);
});

test("sending cycle retains seven previous days, skips bad lines, caps metrics and drops old files", async () => {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  for (let i = 1; i <= 8; i++) {
    const date = new Date(clock - i * 86400000).toISOString().slice(0, 10);
    writeFileSync(counts(date), '{"t":"blocked"}\n');
  }
  writeFileSync(counts(previous), '{"t":"plan"}\n'.repeat(100002) + 'bad\n{"t":"held","extra":1}\n{"t":"held"}\n{"t":"unknown"}\n');
  writeFileSync(counts(), '{"t":"blocked"}\n');
  writeFileSync(path.join(dir(), "ping-2026-09-01"), "");
  await boot({}, async (url, init) => {
    expect(existsSync(`${counts(previous)}.sending`)).toBe(true);
    expect(existsSync(counts(previous))).toBe(false);
    const body = JSON.parse(String(init.body)); sent.push({ url, init, body });
    return new Response(null, { status: 204 });
  });
  await hook(); await stop();
  expect(bodyValid(sent[0]!.body)).toBe(true);
  expect(sent[0]!.body.localCounts).toHaveLength(7);
  expect(sent[0]!.body.localCounts[0]).toEqual({ day: previous, plans: 100000, blocked: 0, held: 1 });
  expect(readdirSync(dir()).sort()).toEqual([`counts-${day}.ndjson`, `ping-${day}`].sort());
});
test("counter collection reads the renamed file so an append before the rename is included", async () => {
  mkdirSync(dir(), { recursive: true }); writeFileSync(counts(previous), '{"t":"plan"}\n');
  const rename = fs.rename;
  const mock = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from) === counts(previous)) await fs.appendFile(from, '{"t":"held"}\n');
    await rename(from, to);
  });
  try {
    await boot(); await hook(); await stop();
    expect(sent[0]!.body.localCounts).toEqual([{ day: previous, plans: 1, blocked: 0, held: 1 }]);
  } finally { mock.mockRestore(); }
});

for (const status of [200, 204, 302, 400, 500, 0]) {
  test(`request status ${status} settles or rolls back counters, without retries or changed hook output`, async () => {
    mkdirSync(dir(), { recursive: true }); writeFileSync(counts(previous), '{"t":"plan"}\n');
    let calls = 0;
    await boot({}, async () => { calls++; if (!status) throw new Error("down"); return new Response(null, { status }); });
    const start = performance.now(); expect(await hook()).toEqual({ decision: "allow" });
    expect(performance.now() - start).toBeLessThan(1000);
    await stop(); expect(calls).toBe(1);
    expect(existsSync(counts(previous))).toBe(!(status >= 200 && status < 300));
    expect(existsSync(`${counts(previous)}.sending`)).toBe(false);
    await boot(); await hook(); await stop(); expect(sent).toEqual([]);
  });
}

for (const code of ["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]) {
  for (const lateWrite of [false, true]) {
    test(`failed send restores counts without hard links (${code}, late write ${lateWrite})`, async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(counts(previous), '{"t":"plan"}\n');
      const linkFile = fs.link;
      const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
        if (String(from).endsWith(".sending")) throw Object.assign(new Error("unsupported"), { code });
        await linkFile(from, to);
      });
      try {
        await bootDirect({}, async () => {
          if (lateWrite) writeFileSync(counts(previous), '{"t":"held"}\n');
          return new Response(null, { status: 500 });
        });
        await directHook(); await stop();
        expect(readFileSync(counts(previous), "utf8").trim().split("\n").sort()).toEqual(lateWrite ? ['{"t":"held"}', '{"t":"plan"}'] : ['{"t":"plan"}']);
        expect(existsSync(`${counts(previous)}.sending`)).toBe(false);
        clock += 1000;
        await bootDirect(); await directHook(); await stop();
        expect(sent[0]!.body.localCounts).toEqual([{ day: previous, plans: 1, blocked: 0, held: lateWrite ? 1 : 0 }]);
      } finally { link.mockRestore(); }
    });
  }
}

test("interrupted sending files merge late writes on rollback and the next day sends both", async () => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(`${counts(previous)}.sending`, '{"t":"plan"}\n');
  writeFileSync(counts(previous), '{"t":"held"}\n');
  await boot({}, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.localCounts).toEqual([{ day: previous, plans: 1, blocked: 0, held: 1 }]);
    writeFileSync(counts(previous), '{"t":"blocked"}\n');
    return new Response(null, { status: 500 });
  });
  await hook(); await stop();
  expect(readFileSync(counts(previous), "utf8").trim().split("\n")).toHaveLength(3);
  clock += 1000;
  await boot(); await hook(); await stop();
  expect(sent[0]!.body.localCounts).toEqual([{ day: previous, plans: 1, blocked: 1, held: 1 }]);
});

test("5 MB counter files stop growing and are not read into a request", async () => {
  mkdirSync(dir(), { recursive: true });
  const big = " ".repeat(5 * 1024 * 1024 + 1);
  writeFileSync(counts(), big); writeFileSync(counts(previous), big);
  await boot(); verdict = { decision: "deny", reason: "guard" }; await hook(); await stop();
  expect(lstatSync(counts()).size).toBe(big.length);
  expect(sent[0]!.body.localCounts).toEqual([]);
  expect(existsSync(counts(previous))).toBe(true);
  expect(existsSync(`${counts(previous)}.sending`)).toBe(false);
});

test("request aborts at three seconds and retains the failed day's claim and counters", async () => {
  mkdirSync(dir(), { recursive: true }); writeFileSync(counts(previous), '{"t":"held"}\n');
  let calls = 0; let elapsed = 0;
  await boot({}, async (_url, init) => {
    calls++; const start = performance.now();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => { elapsed = performance.now() - start; reject(init.signal!.reason); }, { once: true }));
  });
  expect(await hook()).toEqual({ decision: "allow" }); await stop();
  expect(calls).toBe(1); expect(elapsed).toBeGreaterThanOrEqual(2900); expect(elapsed).toBeLessThan(4000);
  expect(existsSync(counts(previous))).toBe(true); expect(existsSync(path.join(dir(), `ping-${day}`))).toBe(true);
}, 7000);

test("the whole worker has a five second deadline even if injected fetch ignores abort", async () => {
  mkdirSync(dir(), { recursive: true }); writeFileSync(counts(previous), '{"t":"plan"}\n');
  await boot({}, async () => new Promise<Response>(() => {}));
  const start = performance.now(); await hook(); await stop();
  expect(performance.now() - start).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - start).toBeLessThan(6000);
  expect(existsSync(counts(previous))).toBe(true);
}, 8000);

test("an interrupted rollback with two names for the same file never doubles its events", async () => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(`${counts(previous)}.sending`, '{"t":"plan"}\n');
  await fs.link(`${counts(previous)}.sending`, counts(previous));
  await boot(); await hook(); await stop();
  expect(sent[0]!.body.localCounts).toEqual([{ day: previous, plans: 1, blocked: 0, held: 0 }]);
});

test("two racing plugin workers share one install id and one daily claim", async () => {
  const send = async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  };
  await boot({}, send);
  const other = await reach.reachPlugin({ env: { ARMORIQ_SIGNIN_REMINDER_DISABLED: "1" }, now: () => clock, fetch: send, notifier() {} }).setup({
    log: quiet, paths: daemon!.paths, auth: daemon!.auth, sessions: { get: () => undefined, all: () => [] },
  });
  try {
    registration.observe!({ kind: "session_start", session: {} as never, at: clock });
    other.observe!({ kind: "session_start", session: {} as never, at: clock });
    await Promise.all([registration.pumps![0]!.stop(), other.pumps![0]!.stop()]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.installId).toBe(readFileSync(path.join(armoriq(), "install-id"), "utf8").trim());
    expect(readdirSync(armoriq()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally { await other.pumps![0]!.stop(); }
});

const reminderOn = { ARMORIQ_SIGNIN_REMINDER_DISABLED: "0" };
const noticeFile = () => path.join(armoriq(), "reach/v1/armorantigravity/notice-shown");
const reminderFile = (date = day, environment = "production") => path.join(dir(environment), `reminder-${date}`);
const loggedMessages = () => readFileSync(path.join(armoriq(), "armorantigravity/logs/agd.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).message as string);
const sessionStart = () => registration.observe!({ kind: "session_start", session: {} as never, at: clock });
function installedCli() {
  const cli = path.join(armoriq(), "armorantigravity/bin/armorantigravity");
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
  return `'${cli.replaceAll("'", "'\\''")}'`;
}

test("first session shows two separate notifications, then notice stays claimed across days and channels", async () => {
  const cli = installedCli();
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toEqual([contract.notice, `ArmorAntigravity is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${cli} login --backend 'https://api.armoriq.ai' (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`]);
  expect(lstatSync(noticeFile()).mode & 0o777).toBe(0o600);
  expect(lstatSync(reminderFile()).mode & 0o777).toBe(0o600);
  config({ channel: "dev" });
  await boot(reminderOn); await hook(); await stop(); expect(messages).toHaveLength(2);
  clock += 1000;
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toHaveLength(3);
  expect(messages.filter((text) => text === contract.notice)).toHaveLength(1);
  expect(existsSync(reminderFile("2026-11-16"))).toBe(true);
  clock -= 1000;
  await boot(reminderOn); await hook(); await stop(); expect(messages).toHaveLength(3);
});

test("notice and reminder claims are independent and a previous installer notice is respected", async () => {
  mkdirSync(path.dirname(noticeFile()), { recursive: true });
  writeFileSync(noticeFile(), "");
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
});

test("a failed notice claim does not suppress the reminder", async () => {
  mkdirSync(noticeFile(), { recursive: true });
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
});

test("a failed reminder claim does not suppress the notice", async () => {
  mkdirSync(reminderFile(), { recursive: true });
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toEqual([contract.notice]);
});

for (const env of [{ DO_NOT_TRACK: "1" }, { ARMORIQ_USAGE_PING_DISABLED: " YeS " }]) {
  test(`ping opt out ${JSON.stringify(env)} leaves reminder enabled without an install id or request`, async () => {
    await boot({ ...reminderOn, ...env }); await hook(); await stop();
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
    expect(sent).toEqual([]); expect(existsSync(noticeFile())).toBe(false);
    expect(existsSync(path.join(armoriq(), "install-id"))).toBe(false);
  });
}
for (const source of ["config", "settings"]) {
  test(`${source} usagePing false leaves reminder enabled`, async () => {
    if (source === "config") config({ usagePing: false });
    else { mkdirSync(armoriq(), { recursive: true }); writeFileSync(path.join(armoriq(), "settings.json"), '{"usagePing":false}'); }
    await boot(reminderOn); await hook(); await stop();
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in"); expect(sent).toEqual([]);
  });
}

for (const value of ["1", "true", "yes", " TRUE ", " YeS "]) {
  test(`reminder env opt out ${value} leaves ping and notice enabled`, async () => {
    await boot({ ARMORIQ_SIGNIN_REMINDER_DISABLED: value }); await hook(); await stop();
    expect(messages).toEqual([contract.notice]); expect(sent).toHaveLength(1);
    expect(existsSync(reminderFile())).toBe(false);
  });
}
for (const value of ["0", "false", "no", "", "unknown"]) {
  test(`unrecognised reminder env value ${value} does not disable it`, async () => {
    await boot({ DO_NOT_TRACK: "1", ARMORIQ_SIGNIN_REMINDER_DISABLED: value }); await hook(); await stop();
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
  });
}

for (const value of [false, "false", 0, null, {}, []]) {
  test(`shared signInReminder ${JSON.stringify(value)} fails closed independently of the ping`, async () => {
    mkdirSync(armoriq(), { recursive: true });
    writeFileSync(path.join(armoriq(), "settings.json"), JSON.stringify({ signInReminder: value }));
    await boot(reminderOn); await hook(); await stop();
    expect(messages).toEqual([contract.notice]); expect(sent).toHaveLength(1);
    expect(existsSync(reminderFile())).toBe(false);
  });
}
for (const kind of ["malformed", "unreadable", "directory", "null", "array"]) {
  test(`${kind} shared settings suppress both messages`, async () => {
    mkdirSync(armoriq(), { recursive: true });
    const file = path.join(armoriq(), "settings.json");
    if (kind === "directory") mkdirSync(file);
    else writeFileSync(file, kind === "malformed" ? "{" : kind === "null" ? "null" : kind === "array" ? "[]" : "{}", { mode: kind === "unreadable" ? 0 : 0o600 });
    await boot(reminderOn); await hook(); await stop();
    expect(messages).toEqual([]); expect(existsSync(noticeFile())).toBe(false); expect(existsSync(reminderFile())).toBe(false);
  });
}

test("config reminder opt out is reread at each session and enabled sources cannot override it", async () => {
  config({ signInReminder: false });
  mkdirSync(armoriq(), { recursive: true });
  writeFileSync(path.join(armoriq(), "settings.json"), '{"signInReminder":true}');
  await boot(reminderOn); await hook();
  await registration.pumps![0]!.stop();
  expect(messages).toEqual([contract.notice]); expect(existsSync(reminderFile())).toBe(false);
  await stop();
  config({ signInReminder: true });
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toHaveLength(2); expect(existsSync(reminderFile())).toBe(true);
});

test("signed in and cached relogin postures use uploadLogin for the reminder", async () => {
  await boot({ ...reminderOn, ARMORIQ_API_KEY: "test-key" }); await hook();
  await registration.pumps![0]!.stop();
  expect(messages).toEqual([contract.notice]); expect(existsSync(reminderFile())).toBe(false);
  await stop();
  await boot({ ...reminderOn, ARMORIQ_API_KEY: "test-key" });
  daemon!.auth.reportStatus(401, {}, "probe");
  expect(daemon!.auth.uploadLogin()).toBeNull();
  await hook(); await stop();
  expect(messages).toHaveLength(2); expect(messages[1]).toContain("is not signed in");
});

for (const posture of ["relogin_required", "local_only"]) {
  test(`reminder forces a fresh login for the ${posture} posture captured in observe`, async () => {
    const cli = installedCli();
    await bootDirect({ ...reminderOn, ARMORIQ_API_KEY: "test-key" });
    isolatedAuth!.reportStatus(posture === "relogin_required" ? 403 : 401, posture === "relogin_required" ? { error: "relogin_required" } : {}, "probe");
    sessionStart();
    if (posture === "local_only") isolatedAuth!.reportStatus(200, {}, "probe");
    await stop();
    expect(messages[1]).toContain(`${cli} login --backend 'https://api.armoriq.ai' --force`);
  });
}

test("reminder uses environment backend, has independent environment claims and prunes only expired reminders", async () => {
  installedCli();
  config({ backendUrl: "https://api.armoriq.ai", usagePing: false });
  mkdirSync(dir("staging"), { recursive: true });
  for (const name of ["reminder-2026-10-15", "reminder-2026-10-16", "reminder-invalid", "ping-2026-10-15", "counts-2026-10-15.ndjson"]) writeFileSync(path.join(dir("staging"), name), "");
  await boot({ ...reminderOn, ARMORIQ_BACKEND_URL: "https://staging-api.armoriq.io/" }); await hook(); await stop();
  expect(messages[0]).toContain("login --backend 'https://staging-api.armoriq.io'");
  expect(readdirSync(dir("staging")).sort()).toEqual(["reminder-2026-10-16", "reminder-invalid", "ping-2026-10-15", "counts-2026-10-15.ndjson", `reminder-${day}`].sort());
  await boot(reminderOn); await hook(); await stop(); expect(messages).toHaveLength(2);
  expect(existsSync(reminderFile())).toBe(true);
});

test("non contract backend suppresses notice and reminder", async () => {
  config({ backendUrl: "https://api.armoriq.ai/prefix" });
  await boot(reminderOn); await hook(); await stop();
  expect(messages).toEqual([]); expect(existsSync(noticeFile())).toBe(false); expect(existsSync(reminderFile())).toBe(false);
});

test("hook events alone do not show messages and observe returns before notifications and file work", async () => {
  await boot(reminderOn);
  registration.observe!({ kind: "hook", hook: { event: "PostToolUse" } as never, response: null, at: clock });
  await turn(); await Bun.sleep(20); expect(messages).toEqual([]);
  const open = spyOn(fs, "open"); const mkdir = spyOn(fs, "mkdir");
  try {
    const start = performance.now(); sessionStart();
    expect(performance.now() - start).toBeLessThan(20);
    expect(messages).toEqual([]); expect(open).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  } finally { open.mockRestore(); mkdir.mockRestore(); }
  await stop(); expect(messages).toHaveLength(2);
});

test("racing workers share the notice and reminder claims", async () => {
  config({ usagePing: false });
  await boot(reminderOn);
  const other = await reach.reachPlugin({ env: reminderOn, now: () => clock, notifier: (text) => { messages.push(text); } }).setup({
    log: quiet, paths: daemon!.paths, auth: daemon!.auth, sessions: { get: () => undefined, all: () => [] },
  });
  sessionStart(); other.observe!({ kind: "session_start", session: {} as never, at: clock });
  await Promise.all([registration.pumps![0]!.stop(), other.pumps![0]!.stop()]);
  expect(messages).toHaveLength(1);
});

async function notifierModule() {
  const module = await import("../src/notify.ts").catch(() => null);
  expect(module?.desktopNotifier).toBeFunction();
  return module!;
}

function notificationChild() {
  return Object.assign(new EventEmitter(), { unref() {}, kill: (_signal?: string) => true });
}

test("macOS notifier passes message only as an argument, detached without a shell, and always logs it", async () => {
  const { desktopNotifier } = await notifierModule();
  const calls: unknown[][] = [];
  const child = notificationChild();
  const unref = spyOn(child, "unref");
  const text = 'quotes " \' ` $(touch /tmp/never) \\ and\na new line';
  const notify = desktopNotifier(fileLog(path.join(armoriq(), "armorantigravity/logs/agd.log"), false), { platform: "darwin", env: {}, spawn: (...args) => { calls.push(args); return child; } });
  const result = notify(text);
  expect(result).toBeUndefined(); expect(unref).toHaveBeenCalled();
  expect(calls).toEqual([["osascript", ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "ArmorIQ"', "-e", "end run", text], { detached: true, stdio: "ignore", shell: false }]]);
  expect(loggedMessages()).toContain(text);
  child.emit("exit", 0);
});

for (const display of ["DISPLAY", "WAYLAND_DISPLAY"]) {
  test(`Linux notifier requires PATH binary and ${display}`, async () => {
    const { desktopNotifier } = await notifierModule();
    const bin = path.join(armoriq(), "test-bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "notify-send"), "#!/bin/sh\n", { mode: 0o755 });
    const calls: unknown[][] = [];
    const child = notificationChild();
    const notify = desktopNotifier(fileLog(path.join(armoriq(), "armorantigravity/logs/agd.log"), false), {
      platform: "linux", env: { PATH: bin, [display]: ":0" }, spawn: (...args) => { calls.push(args); return child; },
    });
    notify(contract.notice);
    expect(calls).toEqual([[path.join(bin, "notify-send"), ["ArmorIQ", contract.notice], { detached: true, stdio: "ignore", shell: false }]]);
    expect(loggedMessages()).toContain(contract.notice); child.emit("exit", 0);
  });
}

for (const failure of ["missing", "headless", "throw", "error", "nonzero", "timeout"]) {
  test(`notifier ${failure} retains the full message in agd.log`, async () => {
    const { desktopNotifier } = await notifierModule();
    const calls: unknown[][] = [];
    const child = notificationChild();
    const kill = spyOn(child, "kill");
    const text = `${contract.notice} full message with \"quotes\"`;
    const notify = desktopNotifier(fileLog(path.join(armoriq(), "armorantigravity/logs/agd.log"), false), {
      platform: failure === "missing" || failure === "headless" ? "linux" : "darwin",
      env: failure === "missing" ? { PATH: box.home, DISPLAY: ":0" } : {},
      spawn: (...args) => { calls.push(args); if (failure === "throw") throw new Error("spawn failed"); return child; },
    });
    expect(notify(text)).toBeUndefined();
    if (failure === "missing" || failure === "headless") expect(calls).toEqual([]);
    if (failure === "error") child.emit("error", new Error("missing executable"));
    if (failure === "nonzero") child.emit("exit", 1);
    if (failure === "timeout") { await Bun.sleep(5100); expect(kill).toHaveBeenCalledWith("SIGKILL"); }
    expect(loggedMessages().filter((line) => line === text)).toEqual([text]);
    if (failure !== "timeout") expect(kill).not.toHaveBeenCalled();
  }, 7000);
}

test("Linux notifier ignores a directory named notify-send on PATH", async () => {
  const { desktopNotifier } = await notifierModule();
  const bin = path.join(armoriq(), "test-bin");
  mkdirSync(path.join(bin, "notify-send"), { recursive: true });
  let spawned = false;
  desktopNotifier(fileLog(path.join(armoriq(), "armorantigravity/logs/agd.log"), false), {
    platform: "linux", env: { PATH: bin, DISPLAY: ":0" }, spawn: () => { spawned = true; return notificationChild(); },
  })(contract.notice);
  expect(spawned).toBe(false); expect(loggedMessages()).toContain(contract.notice);
});

// Exercise the same queued worker without a socket as well as the daemon integration above.
async function worker(env: Record<string, string> = {}, observe = (reg: PluginRegistration) => reg.observe!({ kind: "session_start", session: {} as never, at: clock }), notifier = (text: string) => { messages.push(text); }) {
  const paths = resolvePaths(env);
  const log = fileLog(paths.logFile, false);
  const auth = createAuth(log, { env, config: readConfig(paths.configFile, log), dataDir: paths.dataDir });
  const reg = await reach.reachPlugin({ env, now: () => clock, notifier, fetch: async () => new Response(null, { status: 204 }) }).setup({
    paths, auth, log, sessions: { get: () => undefined, all: () => [] },
  });
  try { observe(reg); }
  finally { await reg.pumps![0]!.stop(); auth.stop(); }
}

test("worker shows and logs two messages, shares claims across restarts, and rolls over at UTC midnight", async () => {
  installedCli();
  await worker(); expect(messages).toHaveLength(2); expect(messages[0]).toBe(contract.notice);
  expect(loggedMessages()).toContain(messages[0]!); expect(loggedMessages()).toContain(messages[1]!);
  await worker(); expect(messages).toHaveLength(2);
  clock += 1000; await worker(); expect(messages).toHaveLength(3);
  expect(existsSync(reminderFile("2026-11-16"))).toBe(true);
  clock -= 1000; await worker(); expect(messages).toHaveLength(3);
});

test("worker preserves full messages and both claims when the injected notifier throws", async () => {
  await worker({}, undefined, () => { throw new Error("notification failed"); });
  expect(loggedMessages()).toContain(contract.notice);
  expect(loggedMessages().some((text) => text.startsWith("ArmorAntigravity is not signed in"))).toBe(true);
  expect(existsSync(noticeFile())).toBe(true); expect(existsSync(reminderFile())).toBe(true);
});

for (const source of ["DO_NOT_TRACK", "ARMORIQ_USAGE_PING_DISABLED", "config", "settings"]) {
  test(`worker ping opt out ${source} leaves the reminder enabled and never creates an install id`, async () => {
    if (source === "config") config({ usagePing: false });
    else if (source === "settings") { mkdirSync(armoriq(), { recursive: true }); writeFileSync(path.join(armoriq(), "settings.json"), '{"usagePing":false}'); }
    await worker(source === "config" || source === "settings" ? {} : { [source]: "true" });
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
    expect(existsSync(noticeFile())).toBe(false); expect(existsSync(path.join(armoriq(), "install-id"))).toBe(false);
  });
}

for (const source of ["environment", "config", "settings", "malformed", "unreadable", "wrong type", "signed in"]) {
  test(`worker suppresses the reminder for ${source}`, async () => {
    config({ usagePing: false, ...(source === "config" ? { signInReminder: false } : {}) });
    if (["settings", "malformed", "unreadable", "wrong type"].includes(source)) {
      writeFileSync(path.join(armoriq(), "settings.json"), source === "malformed" ? "{" : JSON.stringify({ signInReminder: source === "wrong type" ? "false" : false }), { mode: source === "unreadable" ? 0 : 0o600 });
    }
    await worker(source === "environment" ? { ARMORIQ_SIGNIN_REMINDER_DISABLED: " YeS " } : source === "signed in" ? { ARMORIQ_API_KEY: "test-key" } : {});
    expect(messages).toEqual([]); expect(existsSync(reminderFile())).toBe(false);
  });
}

test("worker claims each message independently and respects an installer notice", async () => {
  mkdirSync(noticeFile(), { recursive: true });
  await worker(); expect(messages).toHaveLength(1); expect(messages[0]).toContain("is not signed in");
});

test("worker captures clock and auth before scheduling without doing file or notification work in observe", async () => {
  await worker({}, (reg) => {
    const open = spyOn(fs, "open"); const mkdir = spyOn(fs, "mkdir");
    try {
      const start = performance.now();
      reg.observe!({ kind: "session_start", session: {} as never, at: clock });
      clock += 1000;
      expect(performance.now() - start).toBeLessThan(20);
      expect(messages).toEqual([]); expect(open).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    } finally { open.mockRestore(); mkdir.mockRestore(); }
  });
  expect(messages).toHaveLength(2); expect(existsSync(reminderFile(day))).toBe(true);
  expect(existsSync(reminderFile("2026-11-16"))).toBe(false);
});
