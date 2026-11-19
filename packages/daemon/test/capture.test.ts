import { afterEach, expect, test } from "bun:test";
import { AUDIT_SIZE_LIMITS, createOutbox, clientRowId } from "@armorantigravity/core";
import { createRegistry, conversationKey } from "@armorantigravity/intent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditIdentity, auditStatus, captureFallback, prepareHookCapture, queueLogin } from "../src/capture.ts";

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

test("the hook snapshots root identity and login before an asynchronous decision or a login change", async () => {
  const { dir, env } = store();
  const registry = createRegistry(() => 1_000, path.join(dir, "intent-state.json"));
  registry.syncAuth(login, "enforce");
  const root = { surface: "cli" as const, conversationId: "root" };
  const child = { surface: "cli" as const, conversationId: "child" };
  registry.open(root);
  registry.open(child);
  registry.link(child, root);
  const request = { id: crypto.randomUUID(), receivedAt: 1_000, payload: { conversationId: "child", stepIdx: 7, transcriptPath: "/.gemini/antigravity-cli/brain/child/t.jsonl", toolCall: { args: { secret: "never captured" } } } };
  const captured = prepareHookCapture(request, env);
  registry.close(conversationKey(root));
  env.ARMORIQ_API_KEY = "ak_test_other_login";
  request.payload.stepIdx = 99;
  await captured.stop();
  const outbox = createOutbox(dir, "audit", quiet, { login: () => binding });
  expect(outbox.readPending().map(entry => entry.row)).toEqual([{
    client_row_id: clientRowId("root", "7", "decision"), session_id: "root", tool: "unknown", action: "unknown", input: {},
    executed_at: new Date(1_000).toISOString(), decision_code: "internal_error", status: "blocked",
  }]);
  expect(outbox.status().undeliverable).toBe(0);
  await outbox.persist();
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
  expect(outbox.status()).toEqual({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 1 });
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
  const expected = { pending: 1, undeliverable: 1, deadLetters: 1, captureFailures: 1 };
  expect(await auditStatus(env)).toEqual(expected);
  expect(await auditStatus({ ...env, ARMORIQ_API_KEY: "ak_test_other_login" })).toEqual(expected);
});
