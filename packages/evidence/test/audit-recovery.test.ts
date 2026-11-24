import { createOutbox, type AuditRow } from "@armorantigravity/core";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { auditLogin, createAuditPump } from "../src/pumps/audit.ts";
import { login, quietLog, tempDir, uploads } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const row = (): AuditRow => ({ client_row_id: crypto.randomUUID(), session_id: "root", step_index: -1, tool: "unknown", action: "unknown", input: {}, status: "blocked", decision_code: "internal_error", executed_at: new Date(1_000).toISOString() });

test("Retry-After survives a pump restart and prevents early sends", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  let now = 1_000;
  let calls = 0;
  const deps = {
    dataDir: tmp.dir, uploads: uploads(() => credential), log: quietLog,
    clock: { now: () => now, random: () => 0 },
    timing: { minBackoffMs: 10, maxBackoffMs: 50 },
    post: async (_login: unknown, _uploads: unknown, rows: readonly AuditRow[]) => ++calls === 1
      ? { ok: false as const, retryable: true, retryAfterMs: 1_000, status: 429, reason: "rate limited" }
      : { ok: true as const, value: { written: rows.length, failures: [] } },
  };
  let pump = createAuditPump(deps);
  const reader = createOutbox<AuditRow>(tmp.dir, "audit", quietLog, { login: () => null });
  cleanups.push(async () => { await pump.stop(); await reader.persist(); tmp.cleanup(); });
  const captured = row();
  pump.enqueue(captured);
  await pump.kick();
  expect(reader.readPending()).toMatchObject([{ row: captured, attempts: 0, nextAttemptAt: 2_000 }]);
  await pump.stop();
  pump = createAuditPump(deps);
  now = 1_999;
  await pump.kick();
  expect(calls).toBe(1);
  now = 2_000;
  await pump.kick();
  expect(calls).toBe(2);
  expect(pump.status().pending).toBe(0);
});

test("the real audit pump persists failed probe deadlines and resumes after a successful probe", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  let now = 1_000;
  let calls = 0;
  let probes = 0;
  let probeStatus = 503;
  const delivered: AuditRow[] = [];
  const deps = {
    dataDir: tmp.dir, uploads: uploads(() => credential), log: quietLog,
    clock: { now: () => now, random: () => 0 }, timing: { authProbeMs: 120_000 },
    probe: async () => { probes++; return { status: probeStatus }; },
    post: async (_login: unknown, _uploads: unknown, rows: readonly AuditRow[]) => {
      if (++calls === 1) return { ok: false as const, retryable: false, unauthorized: true, reason: "audit route returned 401" };
      delivered.push(...rows);
      return { ok: true as const, value: { written: rows.length, failures: [] } };
    },
  };
  let pump = createAuditPump(deps);
  cleanups.push(async () => { await pump.stop(); tmp.cleanup(); });
  const captured = row();
  pump.enqueue(captured);
  await pump.kick();
  expect(pump.status().undeliverable).toBe(1);
  await pump.stop();
  pump = createAuditPump(deps);
  now += 120_000;
  await pump.kick();
  expect(probes).toBe(1);
  expect(delivered).toEqual([]);
  await pump.stop();
  pump = createAuditPump(deps);
  await pump.kick();
  expect(probes).toBe(1);
  probeStatus = 200;
  now += 120_000;
  await pump.kick();
  expect(probes).toBe(2);
  expect(delivered).toEqual([captured]);
  expect(pump.status().pending).toBe(0);
});

test("an authenticated call with the same key resumes the audit pump without an auth state change", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  let calls = 0;
  const pump = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => credential), log: quietLog, post: async (_login, _uploads, rows) => ++calls === 1
    ? { ok: false, retryable: false, relogin: true, reason: "audit route returned 403" }
    : { ok: true, value: { written: rows.length, failures: [] } } });
  cleanups.push(async () => { await pump.stop(); tmp.cleanup(); });
  pump.enqueue(row());
  await pump.kick();
  await pump.authenticationSucceeded({ ...credential, apiKey: "ak_test_other" });
  expect(pump.status().undeliverable).toBe(1);
  await pump.authenticationSucceeded(credential);
  expect(pump.status().pending).toBe(0);
});

test("forty transport failures never spend row attempts or dead letter captured rows", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  const pump = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => credential), log: quietLog, post: async () => { throw new Error("network unavailable"); } });
  const reader = createOutbox<AuditRow>(tmp.dir, "audit", quietLog, { login: () => null });
  cleanups.push(async () => { await pump.stop(); await reader.persist(); tmp.cleanup(); });
  const captured = row();
  pump.enqueue(captured);
  for (let failure = 0; failure < 40; failure++) await pump.kick();
  expect(reader.readPending().map(entry => [entry.row, entry.attempts])).toEqual([[captured, 0]]);
  expect(reader.readDeadLetters()).toEqual([]);
  expect(auditLogin(credential)?.keyId).toHaveLength(64);
});

test("an unavailable old authentication schedule still pauses without spending a row attempt", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  writeFileSync(path.join(tmp.dir, "audit-auth-v1"), "unavailable old schedule");
  const pump = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => credential), log: quietLog, post: async () => {
    return { ok: false, retryable: false, unauthorized: true, reason: "audit route returned 401" };
  } });
  const reader = createOutbox<AuditRow>(tmp.dir, "audit", quietLog, { login: () => null });
  cleanups.push(async () => { await pump.stop(); await reader.persist(); tmp.cleanup(); });
  pump.enqueue(row());
  await pump.kick();
  expect(reader.readPending().map(entry => entry.attempts)).toEqual([0]);
  expect(pump.status().undeliverable).toBe(1);
});

test("the periodic probe can revalidate a retained credential while uploads are paused", async () => {
  const tmp = tempDir();
  const credential = login("https://recovery.invalid");
  let available = true;
  let now = 1_000;
  let calls = 0;
  const up = { ...uploads(() => available ? credential : null), probeLogin: () => credential, authenticationSucceeded: () => { available = true; } };
  const pump = createAuditPump({ dataDir: tmp.dir, uploads: up, log: quietLog, clock: { now: () => now, random: () => 0 }, post: async (_login, _uploads, rows) => {
    if (++calls === 1) { available = false; return { ok: false, retryable: false, relogin: true, reason: "audit route requires revalidation" }; }
    return { ok: true, value: { written: rows.length, failures: [] } };
  } });
  cleanups.push(async () => { await pump.stop(); tmp.cleanup(); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response(null, { status: 200 }), { preconnect: originalFetch.preconnect });
  try {
    pump.enqueue(row());
    await pump.kick();
    expect(available).toBe(false);
    now += 120_000;
    await pump.kick();
    expect(available).toBe(true);
    expect(pump.status().pending).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
