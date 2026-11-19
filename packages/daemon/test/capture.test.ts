import { afterEach, expect, test } from "bun:test";
import { AUDIT_SIZE_LIMITS, createOutbox, clientRowId } from "@armorantigravity/core";
import { createRegistry, conversationKey } from "@armorantigravity/intent";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    client_row_id: expect.stringMatching(/^[0-9a-f-]{36}$/), session_id: "child", tool: "unknown", action: "unknown", input: {},
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
  const expected = { pending: 1, undeliverable: 1, deadLetters: 1, captureFailures: 1, legacyPending: 0, corruptRecords: 0, holds: [] };
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
