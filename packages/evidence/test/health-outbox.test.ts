import { afterEach, expect, test } from "bun:test";
import { createOutbox } from "@armorantigravity/core";
import { parseClientEventsReply } from "../src/io/backend-client-events.ts";
import { parseRunsReply } from "../src/io/backend-runs.ts";
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

// regression: #0010
test.each(["health", "runs"] as const)("%s permanent batch refusals exhaust ten charged attempts across restarts", async stream => {
  for (const status of [413, 405, 409]) {
    const disk = store();
    let box = disk.open(stream);
    for (const id of ["first", "second"]) box.enqueue(stream === "health"
      ? { event_id: id, type: "queue_stalled", queue: "audit", count: 1, reason_code: "server_error", occurred_at: new Date(10_000).toISOString() }
      : { run_id: id, report_seq: 1, session_id: "s", started_at: new Date(10_000).toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
    let calls = 0;
    const send = async (rows: readonly any[]) => {
      calls++;
      return stream === "health" ? parseClientEventsReply(status, {}, new Headers(), rows) : parseRunsReply(status, {}, new Headers(), rows);
    };
    for (let attempt = 1; attempt <= 10; attempt++) {
      await box.drain(send);
      if (attempt === 1) expect(calls).toBe(1);
      if (attempt < 10) {
        expect(box.readPending().map(entry => entry.attempts)).toEqual([attempt, attempt]);
        expect(box.readDeadLetters()).toEqual([]);
      }
      await box.persist();
      box = disk.open(stream);
      disk.advance(10);
    }
    expect(box.readPending()).toEqual([]);
    expect(box.readDeadLetters().map(entry => entry.attempts)).toEqual([10, 10]);
    const before = calls;
    await box.drain(send);
    expect(calls).toBe(before);
  }
});

// regression: #0012
test.each(["health", "runs"] as const)("%s transient and malformed replies never charge attempts", async stream => {
  for (const [status, body] of [[408, {}], [429, {}], [503, {}], [409, { error: "request_in_progress" }], [413, { results: null }]] as const) {
    const disk = store();
    let box = disk.open(stream);
    box.enqueue(stream === "health"
      ? { event_id: "event", type: "queue_stalled", queue: "audit", count: 1, reason_code: "server_error", occurred_at: new Date(10_000).toISOString() }
      : { run_id: "run", report_seq: 1, session_id: "s", started_at: new Date(10_000).toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
    for (let attempt = 0; attempt < 11; attempt++) {
      await box.drain(async rows => stream === "health" ? parseClientEventsReply(status, body, new Headers(), rows) : parseRunsReply(status, body, new Headers(), rows));
      await box.persist();
      box = disk.open(stream);
      disk.advance(10);
    }
    expect(box.readPending().map(entry => entry.attempts)).toEqual([0]);
    expect(box.readDeadLetters()).toEqual([]);
  }
});

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
