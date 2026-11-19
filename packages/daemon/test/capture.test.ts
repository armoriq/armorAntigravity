import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { AUDIT_SIZE_LIMITS, createOutbox, clientRowId } from "@armorantigravity/core";
import { createRegistry, conversationKey } from "@armorantigravity/intent";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditIdentity, auditStatus, captureFallback, queueLogin } from "../src/capture.ts";
import * as spoolModule from "../src/fallback-spool.ts";
import * as capture from "../src/capture.ts";

const dirs: string[] = [];
const quiet = { info() {}, warn() {}, error() {} };
const login = { backend: "https://capture.invalid", apiKey: "ak_test_capture", userId: "user", orgId: "org", email: "", deviceId: "device", deviceName: "test" };
const binding = queueLogin(login)!;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(path.join(tmpdir(), "agy-capture-"));
  dirs.push(root);
  return { root, dir: path.join(root, "armorantigravity"), env: { ARMORIQ_HOME: root, ARMORIQ_API_KEY: login.apiKey, ARMORIQ_BACKEND_URL: login.backend } };
}

function spoolRecord(payload: unknown, event = "PreToolUse", reason = "no_answer") {
  const frame = `agd1 ${event} 1000 ${JSON.stringify(payload)}\n`;
  const printed = event === "PreToolUse" ? '{"decision":"deny"}\n' : "";
  const context = JSON.stringify({ binding, loggedOut: false });
  return `agds1 ${reason} ${Buffer.byteLength(frame)} ${Buffer.byteLength(printed)} ${Buffer.byteLength(context)}\n${frame}${printed}${context}`;
}

// regression: #0012
test("an aborted startup cannot ingest the spool before opening its socket", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "record-999999999-1.spool");
  writeFileSync(file, spoolRecord({ conversationId: "startup", stepIdx: 1 }));
  const { startDaemon } = await import("../src/daemon.ts");
  await expect(startDaemon({ env, log: quiet, plugins: [{ name: "aborted", setup() { throw new Error("stop before listen"); } }] })).rejects.toThrow("stop before listen");
  expect(existsSync(file)).toBe(true);
  expect(existsSync(path.join(root, "archive"))).toBe(false);
});

// regression: #0012
test("a persistent spool storage failure is counted once and a recovered store retries", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  const queue = path.join(dir, "outbox", "audit-v2");
  mkdirSync(root, { recursive: true });
  mkdirSync(queue, { recursive: true });
  writeFileSync(path.join(root, "record-999999999-1.spool"), spoolRecord({ conversationId: "storage-retry", stepIdx: 1 }));
  chmodSync(queue, 0o500);
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try {
    for (let tick = 0; tick < 3; tick++) await spool.kick();
    expect(spoolModule.fallbackSpoolStatus(path.join(dir, "agd.sock")).pending).toBe(1);
    chmodSync(queue, 0o700);
    await spool.kick();
  } finally { chmodSync(queue, 0o700); await spool.stop(); }
  expect(await auditStatus(env)).toMatchObject({ pending: 1, captureFailures: 1, spoolPending: 0 });
});

// regression: #0010
test("a no_answer spool and a daemon capture for one step keep one AC-1 row", async () => {
  const { dir } = store();
  const payload = { conversationId: "same-stop", stepIdx: 7 };
  const identity = auditIdentity({ id: crypto.randomUUID(), payload }, dir);
  await captureFallback(dir, identity, 1_000, binding);
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "record-999999999-1.spool"), spoolRecord(payload));
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try { await spool.kick(); } finally { await spool.stop(); }
  const outbox = createOutbox(dir, "audit", quiet, { login: () => binding });
  try { expect(outbox.readPending().map(entry => entry.id)).toEqual([identity.rowId]); }
  finally { await outbox.persist(); }
});

// regression: #0012
test("a retained append failure is counted once and retried by the next daemon", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "record-999999999-1.spool"), spoolRecord({ conversationId: "append-retry", stepIdx: 1 }));
  const write = fs.writeSync;
  const fault = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
    if (typeof args[1] === "string" && args[1].includes('"t":"a"')) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return (write as (...values: unknown[]) => number)(...args);
  }) as typeof fs.writeSync);
  const deps = { dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet };
  const spool = spoolModule.createFallbackSpool(deps);
  try {
    for (let tick = 0; tick < 3; tick++) await spool.kick();
    expect(await auditStatus(env)).toMatchObject({ captureFailures: 1, spoolPending: 1 });
  } finally { fault.mockRestore(); await spool.stop(); }
  const restarted = spoolModule.createFallbackSpool(deps);
  try { await restarted.kick(); } finally { await restarted.stop(); }
  expect(await auditStatus(env)).toMatchObject({ pending: 1, captureFailures: 1, spoolPending: 0 });
});

// regression: #0012
test("a transient spool read failure retries the retained record", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "record-999999999-1.spool");
  writeFileSync(file, spoolRecord({ conversationId: "read-retry", stepIdx: 1 }), { mode: 0o600 });
  chmodSync(file, 0o000);
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try {
    await spool.kick();
    expect(spoolModule.fallbackSpoolStatus(path.join(dir, "agd.sock"))).toEqual({ pending: 1, quarantined: 0, failures: 0 });
    chmodSync(file, 0o600);
    await spool.kick();
    expect(await auditStatus(env)).toMatchObject({ pending: 1, captureFailures: 0 });
  } finally { if (existsSync(file)) chmodSync(file, 0o600); await spool.stop(); }
});

// regression: #0012
test.each([999999999, process.pid])("complete temporary records from dead or stale writer %i are ingested", async pid => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `record-${pid}-1.tmp`);
  writeFileSync(file, spoolRecord({ conversationId: "complete-tmp", stepIdx: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try { await spool.kick(); } finally { await spool.stop(); }
  expect(await auditStatus(env)).toMatchObject({ pending: 1, captureFailures: 0 });
  expect(readdirSync(path.join(root, "archive"))).toHaveLength(1);
});

// regression: #0012
test("fresh temporary records wait, stale incomplete records become private counted quarantine", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `record-${process.pid}-1.tmp`);
  writeFileSync(file, "incomplete", { mode: 0o644 });
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try {
    await spool.kick();
    expect(await auditStatus(env)).toMatchObject({ spoolPending: 1, captureFailures: 0 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    await spool.kick();
    expect(await auditStatus(env)).toMatchObject({ spoolPending: 0, captureFailures: 1 });
    const quarantined = path.join(root, "quarantine", path.basename(file));
    expect(readFileSync(quarantined, "utf8")).toBe("incomplete");
    expect(statSync(quarantined).mode & 0o777).toBe(0o600);
  } finally { await spool.stop(); }
});

// regression: #0012
test.each(["PreToolUse", "PostToolUse"])("%s archives retain sanitized content and the original digest", async event => {
  const { dir } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const secret = "Bearer abcdefghijklmnopqrstuvwxyz123456";
  writeFileSync(path.join(root, "record-999999999-1.spool"), spoolRecord({ conversationId: "sanitized", stepIdx: 1, toolCall: { args: { CommandLine: `echo ${secret}` } }, output: secret }, event));
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try { await spool.kick(); } finally { await spool.stop(); }
  const archive = path.join(root, "archive", readdirSync(path.join(root, "archive"))[0]!);
  const text = readFileSync(archive, "utf8");
  expect(text).not.toContain(secret);
  expect(text).toContain("<redacted>");
  expect(JSON.parse(text).original_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(statSync(archive).mode & 0o777).toBe(0o600);
});

// regression: #0012
test("idle spool kicks do not read the audit archive", async () => {
  const { dir } = store();
  const archive = path.join(dir, "outbox", "audit-v2", "archive");
  mkdirSync(archive, { recursive: true });
  chmodSync(archive, 0o000);
  const errors: string[] = [];
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: { ...quiet, error: message => { errors.push(message); } } });
  try {
    for (let tick = 0; tick < 3; tick++) await spool.kick();
    expect(errors).toEqual([]);
  } finally { chmodSync(archive, 0o700); await spool.stop(); }
});

test("released v0.2.0 files stay untouched and rows without a binding appear in status", async () => {
  const { dir, env } = store();
  const released = path.join(dir, "outbox", "audit");
  mkdirSync(path.join(released, "dead"), { recursive: true });
  const oldRow = { client_row_id: crypto.randomUUID(), tool: "unknown", action: "unknown", input: {}, status: "blocked" };
  const journal = path.join(released, "999999999-deadbeef.jsonl");
  const dead = path.join(released, "dead", "999999999-deadbeef.jsonl");
  const lock = path.join(released, ".adopt.lock");
  // These are the append, acknowledgement and dead letter formats shipped in v0.2.0.
  writeFileSync(journal, [
    { t: "a", id: "settled", n: 0, v: oldRow },
    { t: "k", ids: ["settled"] },
    { t: "a", id: "pending", n: 3, v: oldRow },
  ].map(line => JSON.stringify(line) + "\n").join(""));
  writeFileSync(dead, JSON.stringify({ item: oldRow, attempts: 10 }) + "\n");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const snapshot = () => [journal, dead, lock].map(file => ({ file, bytes: readFileSync(file), mtime: statSync(file).mtimeMs, ino: statSync(file).ino }));
  const before = snapshot();
  await captureFallback(dir, { rowId: crypto.randomUUID() }, 1_000, binding);
  const queue = createOutbox(dir, "audit", quiet, { login: () => binding });
  try {
    const sent: unknown[] = [];
    await queue.drain(async rows => { sent.push(...rows); return { ok: true, rejected: [] }; });
    expect(sent).toHaveLength(1);
    expect(sent).not.toContainEqual(oldRow);
    expect(await auditStatus(env)).toMatchObject({ pending: 1, undeliverable: 1, deadLetters: 1, legacyPending: 1 });
    expect(snapshot()).toEqual(before);
    expect(readdirSync(released).sort()).toEqual([".adopt.lock", "999999999-deadbeef.jsonl", "dead"]);
  } finally { await queue.persist(); }
});

// regression: #0010
test("spool records keep their captured login, deduplicate replay, and retain incomplete files", async () => {
  const { dir, env } = store();
  const registry = createRegistry(() => 1_000, path.join(dir, "intent-state.json"));
  registry.syncAuth(login, "enforce");
  const root = { surface: "cli" as const, conversationId: "root" };
  const child = { surface: "cli" as const, conversationId: "child" };
  registry.open(root);
  registry.open(child);
  registry.link(child, root);
  const request = { id: crypto.randomUUID(), receivedAt: 1_000, payload: { conversationId: "child", stepIdx: 7, transcriptPath: "/.gemini/antigravity-cli/brain/child/t.jsonl", toolCall: { args: { secret: "never captured" } } } };
  const socket = path.join(dir, "agd.sock");
  const spoolDir = path.join(dir, "fallback-spool");
  mkdirSync(spoolDir, { recursive: true });
  const frame = `agd1 PreToolUse 1000 ${JSON.stringify(request.payload)}\n`;
  const printed = '{"decision":"deny","reason":"daemon unavailable"}\n';
  const context = JSON.stringify({ binding, loggedOut: false });
  const bytes = Buffer.from(`agds1 dial_failed ${Buffer.byteLength(frame)} ${Buffer.byteLength(printed)} ${Buffer.byteLength(context)}\n${frame}${printed}${context}`);
  writeFileSync(path.join(spoolDir, "record-999999999-1.spool"), bytes);
  writeFileSync(path.join(spoolDir, "record-999999999-2.tmp"), "incomplete");
  registry.close(conversationKey(root));
  env.ARMORIQ_API_KEY = "ak_test_other_login";
  request.payload.stepIdx = 99;
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket, log: quiet });
  await spool.kick();
  writeFileSync(path.join(spoolDir, "record-999999999-1.spool"), bytes);
  await spool.kick();
  await spool.stop();
  const outbox = createOutbox(dir, "audit", quiet, { login: () => binding });
  expect(outbox.readPending().map(entry => entry.row)).toEqual([{
    client_row_id: clientRowId("root", "child:7", "decision"), session_id: "root", tool: "unknown", action: "unknown", input: {},
    executed_at: new Date(1_000).toISOString(), decision_code: "internal_error", status: "blocked",
  }]);
  expect(outbox.status().undeliverable).toBe(0);
  expect(readdirSync(path.join(spoolDir, "archive"))).toHaveLength(1);
  expect(readdirSync(path.join(spoolDir, "quarantine"))).toHaveLength(1);
  await outbox.persist();
});

test("parent and child fallback stops at the same step have distinct ids", async () => {
  const { dir } = store();
  const registry = createRegistry(() => 1_000, path.join(dir, "intent-state.json"));
  const root = { surface: "cli" as const, conversationId: "root" };
  const child = { surface: "cli" as const, conversationId: "child" };
  registry.open(root);
  registry.open(child);
  registry.link(child, root);
  const identity = (conversationId: string) => auditIdentity({ id: crypto.randomUUID(), payload: { conversationId, stepIdx: 7, transcriptPath: `/.gemini/antigravity-cli/brain/${conversationId}/t.jsonl` } }, dir);
  const parentId = identity("root");
  const childId = identity("child");
  expect(parentId.sessionId).toBe("root");
  expect(childId.sessionId).toBe("root");
  expect(childId.rowId).not.toBe(parentId.rowId);
  await captureFallback(dir, parentId, 1_000, binding);
  await captureFallback(dir, childId, 1_000, binding);
  const queue = createOutbox(dir, "audit", quiet, { login: () => binding });
  expect(queue.readPending()).toHaveLength(2);
  await queue.persist();
});

test("an invalid spool login snapshot is retained without stopping the next valid record", async () => {
  const { dir, env } = store();
  const root = path.join(dir, "fallback-spool");
  mkdirSync(root, { recursive: true });
  const frame = 'agd1 PreToolUse 1000 {"conversationId":"captured"}\n';
  const printed = '{"decision":"deny"}\n';
  const record = (context: string) => `agds1 dial_failed ${Buffer.byteLength(frame)} ${Buffer.byteLength(printed)} ${Buffer.byteLength(context)}\n${frame}${printed}${context}`;
  writeFileSync(path.join(root, "record-999999999-1.spool"), record("null"));
  writeFileSync(path.join(root, "record-999999999-2.spool"), record(JSON.stringify({ binding, loggedOut: false })));
  const spool = spoolModule.createFallbackSpool({ dataDir: dir, socket: path.join(dir, "agd.sock"), log: quiet });
  try { await spool.kick(); } finally { await spool.stop(); }
  expect(await auditStatus(env)).toMatchObject({ pending: 1, captureFailures: 1 });
  expect(readdirSync(path.join(root, "archive"))).toHaveLength(1);
  expect(readFileSync(path.join(root, "quarantine", "record-999999999-1.spool"), "utf8")).toContain("null");
});

test("a missing host call id carries the UUID allocated on entry through fallback capture", () => {
  const { dir } = store();
  const id = crypto.randomUUID();
  expect(auditIdentity({ id, payload: null }, dir)).toEqual({ rowId: id });
});

test("logged out stops create no queue, while missing identity stays a local capture failure", async () => {
  const { dir } = store();
  const identity = { rowId: crypto.randomUUID() };
  await captureFallback(dir, identity, 1_000, null, true);
  expect(existsSync(dir)).toBe(false);
  await captureFallback(dir, identity, 1_000, null);
  const outbox = createOutbox(dir, "audit", quiet, { login: () => binding });
  expect(outbox.status()).toEqual({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 1, legacyPending: 0, corruptRecords: 0, holds: [] });
  await outbox.persist();
});

test("status counts paused rows, other login rows, dead letters and capture failures across restart", async () => {
  const { dir, env } = store();
  const outbox = createOutbox(dir, "audit", quiet, { login: () => binding });
  const row = { client_row_id: crypto.randomUUID(), input: {}, status: "blocked", metadata: "x".repeat(AUDIT_SIZE_LIMITS.maxRowBytes + 1) };
  outbox.enqueue(row);
  outbox.enqueue({ client_row_id: crypto.randomUUID(), input: {}, status: "blocked" });
  outbox.captureFailure();
  await outbox.drain(async () => ({ ok: false, relogin: true }));
  await outbox.persist();
  const expected = { pending: 1, undeliverable: 1, deadLetters: 1, captureFailures: 1, legacyPending: 0, corruptRecords: 0, holds: [], spoolPending: 0 };
  expect(await auditStatus(env)).toEqual(expected);
  expect(await auditStatus({ ...env, ARMORIQ_API_KEY: "ak_test_other_login" })).toEqual(expected);
});

test("repeated status calls create no queue writers", async () => {
  const { dir, env } = store();
  await auditStatus(env);
  expect(existsSync(path.join(dir, "outbox", "audit-v2"))).toBe(false);
  await auditStatus(env);
  await auditStatus(env);
  expect(existsSync(path.join(dir, "outbox", "audit-v2"))).toBe(false);
});

test("health and runs status are read only even with reporting disabled", async () => {
  const { dir, env } = store();
  for (let n = 0; n < 3; n++) { await capture.healthStatus(env); await capture.runsStatus(env); }
  expect(existsSync(path.join(dir, "outbox", "health-v2"))).toBe(false);
  expect(existsSync(path.join(dir, "outbox", "runs-v2"))).toBe(false);
});

test("local status counts retained health events and the persisted endpoint pause", async () => {
  const { dir, env } = store();
  const health = createOutbox(dir, "health", quiet, { login: () => binding });
  health.enqueue({ event_id: crypto.randomUUID(), type: "plan_request_failed", queue: "health", count: 1, reason_code: "network", occurred_at: new Date().toISOString() });
  await health.drain(async () => ({ ok: false, endpointStatus: 404 }));
  await health.persist();
  expect(typeof capture.healthStatus).toBe("function");
  expect(await capture.healthStatus(env)).toMatchObject({ pending: 1, undeliverable: 1, deadLetters: 0, captureFailures: 0, paused: true });
  expect(await capture.healthStatus({ ...env, ARMORIQ_API_KEY: "ak_test_other_login" })).toMatchObject({ pending: 1, undeliverable: 1, paused: false });
  const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", "status"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(output).toContain("health: 1 pending, 1 undeliverable, 0 dead letters, paused");
});

test("local status retains runs and shows endpoint and login pauses", async () => {
  const { dir, env } = store();
  const runs = createOutbox(dir, "runs", quiet, { login: () => binding });
  runs.enqueue({ run_id: "run", report_seq: 1, session_id: "root", started_at: new Date().toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
  await runs.drain(async () => ({ ok: false, endpointStatus: 404 }));
  await runs.persist();
  expect(await capture.runsStatus(env)).toMatchObject({ pending: 1, undeliverable: 1, deadLetters: 0, captureFailures: 0, paused: true });
  expect(await capture.runsStatus({ ...env, ARMORIQ_API_KEY: "ak_test_other_login" })).toMatchObject({ pending: 1, undeliverable: 1, paused: false });
  const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", "status"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(output).toContain("runs: 1 pending, 1 undeliverable, 0 dead letters, paused");
});
