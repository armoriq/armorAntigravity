import { afterEach, expect, test } from "bun:test";
import { createOutbox } from "@armorantigravity/core";
import { parseClientEventsReply } from "../src/io/backend-client-events.ts";
import { quietLog, tempDir } from "./support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function store() {
  const { dir, cleanup: remove } = tempDir();
  let now = 10_000;
  const handles: ReturnType<typeof createOutbox<any>>[] = [];
  const open = (name: string) => {
    const box = createOutbox<any>(dir, name, quietLog, {
      login: () => ({ backend: "http://localhost:1", keyId: "original" }),
      clock: { now: () => now, random: () => 0 },
      timing: { baseMs: 1, maxMs: 1, lockTtlMs: 1000 },
    });
    handles.push(box);
    return box;
  };
  cleanup.push(async () => { for (const box of handles) await box.persist(); remove(); });
  return { open, advance: (ms: number) => { now += ms; } };
}

test("dead letters after an outage report newly moved records once across restarts", async () => {
  const disk = store();
  let audit = disk.open("audit");
  const health = disk.open("health");
  for (let i = 0; i < 3; i++) audit.enqueue({ client_row_id: crypto.randomUUID() });
  for (let i = 0; i < 10; i++) {
    // A non transient failure spends an attempt; a plain outage never would (outbox v1.1).
    await audit.drain(async () => ({ ok: false, nonTransient: true, reason: "refused", stallReason: "server_error" }));
    disk.advance(10);
  }
  expect(audit.readDeadLetters()).toHaveLength(3);
  expect(typeof audit.reportHealth).toBe("function");
  await audit.persist();
  audit = disk.open("audit");
  await audit.reportHealth(health);
  expect(health.readPending().map(({ row }) => [row.type, row.queue, row.count, row.reason_code])).toEqual([["dead_letter", "audit", 3, "attempts_exhausted"]]);
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
});

test("stall depth and age use enqueue times and the hourly limit survives restart", async () => {
  const disk = store();
  let audit = disk.open("audit");
  const health = disk.open("health");
  audit.enqueue({ client_row_id: crypto.randomUUID(), executed_at: "2000-01-01T00:00:00Z" });
  disk.advance(65_000);
  await audit.drain(async () => ({ ok: false, stallReason: "rate_limited" }));
  expect(typeof audit.reportHealth).toBe("function");
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(0);
  await audit.persist();
  audit = disk.open("audit");
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(0);
  disk.advance(1);
  await audit.reportHealth(health);
  expect(health.readPending()[0]!.row).toMatchObject({ type: "queue_stalled", count: 1, oldest_pending_seconds: 65, reason_code: "rate_limited" });
  await audit.persist();
  audit = disk.open("audit");
  audit.enqueue({ client_row_id: crypto.randomUUID() });
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
  disk.advance(3_599_999);
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
  disk.advance(1);
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(2);
  expect(health.readPending().at(-1)!.row).toMatchObject({ count: 2, oldest_pending_seconds: 3665 });
});

test("health 404 pauses on disk without attempts and a duplicate probe delivers it", async () => {
  const disk = store();
  let health = disk.open("health");
  const id = crypto.randomUUID();
  health.enqueue({ client_row_id: id, event_id: id, type: "plan_request_failed", queue: "health", count: 1, reason_code: "timeout", occurred_at: new Date(10_000).toISOString() });
  let calls = 0;
  await health.drain(async () => { calls++; return { ok: false, endpointStatus: 404 }; });
  expect(health.status()).toMatchObject({ pending: 1, paused: true });
  expect(health.readPending()[0]!.attempts).toBe(0);
  await health.persist();
  health = disk.open("health");
  await health.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(1);
  disk.advance(299_999);
  await health.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(1);
  disk.advance(1);
  await health.drain(async rows => parseClientEventsReply(200, { results: rows.map(row => ({ event_id: row.event_id, outcome: "duplicate" })) }, new Headers(), rows));
  expect(health.status()).toMatchObject({ pending: 0, paused: false });
});
