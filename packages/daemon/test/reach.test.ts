import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import path from "node:path";
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
let registration: PluginRegistration;
let clock: number;
let verdict: HookResponse;
let sent: { url: string; init: RequestInit; body: Record<string, any> }[];
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
  const module = await import("../src/reach.ts").catch(() => null);
  expect(module?.reachPlugin).toBeFunction();
  reach = module!;
});
afterEach(async () => { await stop(); box?.cleanup(); });

async function boot(env: Record<string, string | undefined> = {}, send?: (url: string, init: RequestInit) => Promise<Response>) {
  const plugin = reach.reachPlugin({ env, now: () => clock, fetch: send ?? (async (url, init) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) });
  daemon = await startDaemon({ env, log: quiet, plugins: [
    { name: "decision", setup: () => ({ decide: () => verdict }) },
    { ...plugin, async setup(ctx) { registration = await plugin.setup(ctx); return registration; } },
  ] });
}
async function stop() {
  if (!daemon) return;
  await turn();
  await daemon.stop();
  daemon = undefined;
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
      conversationId: "private-conversation", workspacePaths: ["/planted/private/repo"], transcriptPath: "/planted/private/transcript",
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
    expect(samples.sort((a, b) => a - b)[94]!).toBeLessThan(20);
  } finally { open.mockRestore(); read.mockRestore(); mkdir.mockRestore(); }
  await stop(); expect(sent).toHaveLength(1);
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
  const other = await reach.reachPlugin({ env: {}, now: () => clock, fetch: send }).setup({
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
