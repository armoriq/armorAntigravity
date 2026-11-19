import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createOutbox, type Outbox } from "@armorantigravity/core";
import { parseRunsReply } from "../../src/io/backend-runs.ts";
import type { RunReport } from "@armorantigravity/core";
import { quietLog, tempDir } from "../support.ts";

const cleanup: (() => Promise<void>)[] = [];
const memoryLog = () => ({ log: quietLog });
const scratch = (_prefix: string) => tempDir().dir;
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const report = (run_id = "r", report_seq = 1): RunReport => ({ run_id, report_seq, session_id: "s", started_at: "2026-11-15T00:00:00Z", tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
function store() {
  const dir = scratch("runs-conformance-");
  let now = 0;
  let fault = "";
  let login: { backend: string; keyId: string } | null = { backend: "http://localhost:1", keyId: "a" };
  const handles: Outbox<RunReport>[] = [];
  const open = () => {
    const box = createOutbox<RunReport>(dir, "runs", memoryLog().log, { login: () => login, clock: { now: () => now, random: () => 0 }, timing: { baseMs: 1, maxMs: 1, lockTtlMs: 1000 },
      beforeCommit(point) { if (point === fault) { fault = ""; throw new Error("storage failure"); } },
    });
    handles.push(box);
    return box;
  };
  cleanup.push(async () => { for (const box of handles) await box.persist(); rmSync(dir, { recursive: true, force: true }); });
  return { open, advance: () => { now += 1001; }, fail: (point: string) => { fault = point; }, login: (value: typeof login) => { login = value; } };
}

test("runs stream retries immutable payloads and settles by run id plus sequence", async () => {
  const s = store();
  const box = s.open();
  const start = report();
  box.enqueue(start);
  box.enqueue(report("r", 2));
  box.enqueue(report());
  start.tool_calls = 10;
  await box.drain(async rows => {
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tool_calls).toBe(0);
    return parseRunsReply(200, { results: [{ run_id: "r", report_seq: 2, outcome: "accepted" }] }, new Headers(), rows);
  });
  expect(box.readPending().map(p => p.row.report_seq)).toEqual([1]);
  await box.persist();
  s.advance();
  const next = s.open();
  await next.drain(async rows => parseRunsReply(200, { results: [{ run_id: "r", report_seq: 1, outcome: "duplicate" }] }, new Headers(), rows));
  expect(next.readPending()).toEqual([]);
});

test("runs stream commits closure and report together or neither", async () => {
  const s = store();
  const box = s.open();
  const binding = { backend: "http://localhost:1", keyId: "a" };
  box.checkpoint({ id: "r", sequence: 1, value: { version: 1, closed: false } }, binding, report());
  s.fail("append");
  expect(() => box.checkpoint({ id: "r", sequence: 2, value: { version: 2, closed: true } }, binding, report("r", 2))).toThrow("storage failure");
  expect(s.open().readCheckpoints().map(c => c.value)).toEqual([{ version: 1, closed: false }]);
  expect(box.readPending()).toHaveLength(1);
  box.checkpoint({ id: "r", sequence: 2, value: { version: 2, closed: true } }, binding, report("r", 2));
  await box.persist();
  const recovered = s.open();
  expect(recovered.readCheckpoints()).toEqual([]);
  expect(recovered.closedCheckpoints()).toEqual(["r"]);
  expect(recovered.readPending().map(entry => entry.row.report_seq).sort()).toEqual([1, 2]);
});

for (const failure of ["network", "server", "missing"] as const) test(`runs stream keeps ${failure} pending without charging attempts`, async () => {
  const s = store();
  let box = s.open();
  box.enqueue(report());
  for (let n = 0; n < 10; n++) {
    await box.drain(async rows => {
      if (failure === "network") throw new Error("network lost");
      return parseRunsReply(failure === "server" ? 503 : 200, { results: [] }, new Headers(), rows);
    });
    await box.persist();
    box = s.open();
    s.advance();
  }
  // Outbox v1.1: an outage never spends attempts and never dead letters a row.
  expect(box.readDeadLetters()).toHaveLength(0);
  expect(box.readPending()).toHaveLength(1);
  expect(box.readPending()[0]!.attempts).toBe(0);
});

test("runs stream limits batches to 200 reports and excludes the wrong login", async () => {
  const s = store();
  const box = s.open();
  for (let n = 0; n < 201; n++) box.enqueue(report(`r${n}`));
  s.login(null);
  await box.drain(async () => { throw new Error("logged out send"); });
  expect(box.readPending()).toHaveLength(201);
  s.login({ backend: "http://localhost:1", keyId: "b" });
  let calls = 0;
  await box.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(0);
  s.login({ backend: "http://localhost:1", keyId: "a" });
  const sizes: number[] = [];
  await box.drain(async rows => { sizes.push(rows.length); return { ok: true, rejected: [] }; });
  expect(sizes).toEqual([200, 1]);
});

test("runs stream fences a concurrent drainer and retries a lost acknowledgement", async () => {
  const s = store();
  const first = s.open();
  const second = s.open();
  first.enqueue(report());
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const sending = first.drain(async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, rejected: [] };
  });
  await ready;
  let calls = 0;
  await second.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(0);
  s.fail("ack");
  release();
  await expect(sending).rejects.toThrow("storage failure");
  expect(first.readPending()).toHaveLength(1);
  await second.drain(async rows => parseRunsReply(200, { results: [{ run_id: "r", report_seq: 1, outcome: "stale" }] }, new Headers(), rows));
  expect(first.readPending()).toEqual([]);
});
