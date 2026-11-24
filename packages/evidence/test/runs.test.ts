import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRunsPump, runReportingEnabled } from "../src/pumps/runs.ts";
import { parseRunsReply } from "../src/io/backend-runs.ts";
import { quietLog, tempDir } from "./support.ts";
import { uploads } from "./support.ts";
import type { Login, RunState } from "@armorantigravity/core";
import { createOutbox } from "@armorantigravity/core";
import { auditLogin } from "../src/pumps/audit.ts";

const login: Login = { backend: "http://localhost:1", apiKey: "test-runs", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
const cleanup: (() => Promise<void>)[] = [];
const memoryLog = () => ({ log: quietLog });
const scratch = (_prefix: string) => tempDir().dir;
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

function setup(enabled = true) {
  const dir = scratch("armor-runs-");
  let current: Login | null = login;
  let now = Date.now();
  const sent: unknown[] = [];
  const pumps: ReturnType<typeof createRunsPump>[] = [];
  const audit = createOutbox<any>(dir, "audit", memoryLog().log, { login: () => auditLogin(current) });
  let status = 200;
  const open = () => {
    const pump = createRunsPump({ dataDir: dir, uploads: uploads(() => current), log: memoryLog().log, enabled, checkpoints: () => audit.readCheckpoints(),
      clock: { now: () => now, random: () => 0 },
      post: async (auth, _uploads, reports) => {
        sent.push({ auth, reports });
        return parseRunsReply(status, { results: reports.map(r => ({ run_id: r.run_id, report_seq: r.report_seq, outcome: "accepted" })) }, new Headers(), reports);
      },
    });
    pumps.push(pump);
    return pump;
  };
  cleanup.push(async () => { for (const pump of pumps) await pump.stop(); await audit.persist(); rmSync(dir, { recursive: true, force: true }); });
  return { open, sent, audit, dir, login: (auth: Login | null) => { current = auth; }, status: (value: number) => { status = value; }, advance: (ms: number) => { now += ms; } };
}

test("reporting defaults off and queues and sends nothing while disabled", async () => {
  expect(runReportingEnabled({})).toBe(false);
  expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "true" })).toBe(true);
  const store = setup(false);
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  pump.end("r", "stop", Date.now());
  await pump.kick();
  expect(pump.outbox.readPending()).toEqual([]);
  expect(store.sent).toEqual([]);
  await pump.loginChanged();
  expect(pump.outbox.closedCheckpoints()).toEqual([]);
  await pump.outbox.retireCheckpoints(["unused"]);
  await pump.stop();
  expect(existsSync(`${store.dir}/outbox/runs-v2`)).toBe(false);
});

test("the off switch never reads run storage or credentials", async () => {
  const pump = createRunsPump({ enabled: false, get dataDir(): string { throw new Error("runs path must not be read"); }, log: quietLog,
    uploads: uploads(() => { throw new Error("credentials must not be read"); }),
  });
  pump.begin("off", "s", 1, true);
  pump.attempt("off", "call", "bash", true);
  pump.request("off", "request", "failed");
  pump.end("off", "stop", 2);
  await pump.loginChanged();
  await pump.kick();
  await pump.stop();
});

// regression: #0013
test("a failed runs initialization closes the journals it already opened", async () => {
  const tmp = tempDir();
  cleanup.push(async () => tmp.cleanup());
  expect(() => createRunsPump({ enabled: true, dataDir: tmp.dir, log: quietLog,
    uploads: uploads(() => { throw new Error("credentials unavailable"); }),
  })).toThrow("credentials unavailable");
  await new Promise<void>(resolve => setImmediate(resolve));
  const box = createOutbox(tmp.dir, "runs", quietLog, { login: () => null });
  try {
    await box.drain(async () => ({ ok: true, rejected: [] }));
    expect(readdirSync(`${tmp.dir}/outbox/runs-v2`).filter(file => file.endsWith(".jsonl"))).toEqual([]);
    expect(readdirSync(`${tmp.dir}/outbox/runs-v2/archive`).filter(file => file.endsWith(".jsonl"))).toHaveLength(1);
  } finally { await box.persist(); }
});

test("prompt start is persisted with report sequence 1 before any turn end", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  expect(pump.outbox.readPending().map(p => p.row)).toEqual([expect.objectContaining({ run_id: "r", report_seq: 1, tool_calls: 0, plan_ids: [] })]);
  expect(pump.outbox.readCheckpoints()).toHaveLength(1);
  await pump.kick();
  expect(store.sent).toHaveLength(1);
});

test("logout pauses delivery and another login cannot send a run", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  store.login(null);
  pump.end("r", "stop", Date.now());
  await pump.kick();
  store.login({ ...login, apiKey: "another-login" });
  await pump.loginChanged();
  expect(store.sent).toEqual([]);
  expect(pump.status().undeliverable).toBe(2);
  store.login(login);
  await pump.loginChanged();
  expect(store.sent).toHaveLength(1);
  store.login(null);
  pump.begin("logged-out", "s", Date.now(), false);
  store.login(login);
  pump.end("logged-out", "stop", Date.now());
  await pump.kick();
  expect(store.sent).toHaveLength(1);
});

// regression: #0013
test("404 pauses the runs stream on disk and backs off from five minutes to one hour without consuming attempts", async () => {
  const store = setup();
  const pump = store.open();
  pump.outbox.enqueue({ run_id: "r", report_seq: 1, session_id: "s", started_at: "2026-11-19T00:00:00Z", tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
  store.status(404);
  await pump.kick();
  expect(pump.status()).toMatchObject({ pending: 1, paused: true });
  expect(pump.outbox.readPending()[0]!.attempts).toBe(0);
  await pump.stop();
  let next = store.open();
  await next.kick();
  expect(store.sent).toHaveLength(1);
  for (const [index, delay] of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000].entries()) {
    store.advance(delay - 1);
    await next.kick();
    expect(store.sent).toHaveLength(index + 1);
    expect(next.outbox.readPending()[0]!.attempts).toBe(0);
    store.advance(1);
    await next.kick();
    expect(store.sent).toHaveLength(index + 2);
    await next.stop();
    next = store.open();
  }
  store.status(200);
  store.advance(3_600_000);
  await next.kick();
  expect(next.status()).toMatchObject({ pending: 0, paused: false });
});

test("a restart keeps a prompt open and continues counting until its Stop", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  pump.attempt("r", "call", "bash", true);
  pump.attempt("r", "call", "bash", true);
  await pump.stop();
  const recovered = store.open();
  expect(recovered.outbox.readPending()).toHaveLength(1);
  recovered.attempt("r", "second", "bash", true);
  recovered.end("r", "stop", Date.now());
  expect(recovered.outbox.readPending().map(p => p.row).sort((a, b) => a.report_seq - b.report_seq)).toEqual([
    expect.objectContaining({ run_id: "r", report_seq: 1 }),
    expect.objectContaining({ run_id: "r", report_seq: 2, tool_calls: 2, gated_tool_calls: 2, end_reason: "stop", no_plan_reason: "not_registered" }),
  ]);
  await recovered.stop();
  const twice = store.open();
  expect(twice.outbox.readPending()).toHaveLength(2);
});

// regression: #0013
test.each([false, true])("a live run keeps counting after thirty idle minutes, resumed=%p", async resumed => {
  const store = setup();
  const at = Date.now();
  let pump = store.open();
  pump.begin("live", "s", at, true);
  if (resumed) {
    await pump.stop();
    pump = store.open();
  }
  pump.attempt("live", "first", "bash", true);
  store.login(null);
  store.advance(30 * 60_000);
  await pump.kick();
  expect(pump.outbox.readPending().map(entry => entry.row.report_seq)).toEqual([1]);
  pump.attempt("live", "second", "bash", true);
  pump.end("live", "stop", at + 30 * 60_000 + 1);
  expect(pump.outbox.readPending().find(entry => entry.row.report_seq === 2)?.row).toMatchObject({ tool_calls: 2, gated_tool_calls: 2, end_reason: "stop" });
});

test("final reporting waits for registrations and a late result never changes the next run", async () => {
  const store = setup();
  const pump = store.open();
  const at = Date.now();
  pump.begin("old", "s", at, true);
  const settle = pump.registration("old");
  pump.request("old", "descriptor", "pending");
  pump.end("old", "next_prompt", at + 1);
  pump.begin("new", "s", at + 1, true);
  expect(pump.outbox.readPending()).toHaveLength(2);
  pump.request("old", "descriptor", "confirmed", "11111111-1111-4111-8111-111111111111");
  settle();
  pump.attempt("old", "late", "bash", true);
  pump.end("new", "stop", at + 2);
  const finals = pump.outbox.readPending().map(p => p.row).filter(r => r.report_seq === 2);
  expect(finals).toEqual([
    expect.objectContaining({ run_id: "old", plan_ids: ["11111111-1111-4111-8111-111111111111"], tool_calls: 0 }),
    expect.objectContaining({ run_id: "new", plan_ids: [], tool_calls: 0, no_plan_reason: "no_tool_use" }),
  ]);
  expect(finals[0]!.no_plan_reason).toBeUndefined();
});

test("a blocked audit row persists its counter in the same journal record", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  const checkpoint = pump.attempt("r", "blocked", "bash", true, { persist: false });
  pump.commit(checkpoint, value => store.audit.enqueue({ client_row_id: "blocked", status: "blocked" }, { checkpoint: value }));
  await pump.stop();
  const recovered = store.open();
  recovered.end("r", "stop", Date.now());
  expect(recovered.outbox.readPending().find(p => p.row.report_seq === 2)?.row).toMatchObject({ tool_calls: 1, gated_tool_calls: 1 });
  await recovered.stop();
  const again = store.open();
  expect(again.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(1);
});

// regression: #0013
test("recovery merges sequenced core counter deltas from the audit journal", async () => {
  const store = setup();
  const seed = createOutbox(store.dir, "runs", quietLog, { login: () => auditLogin(login) });
  const binding = auditLogin(login)!;
  const run: RunState = {
    runId: "sequenced", sessionId: "s", startedAt: Date.now(), updatedAt: Date.now(), binding: auditLogin(login), owner: { id: "previous", pid: process.pid },
    version: 1, reportSeq: 1, enforcing: true, enforcementNeeded: false, toolCalls: 1, gatedToolCalls: 0,
    callIds: ["read"], planIds: [], requests: {}, rejected: false, unreachable: false, end: null, closed: false,
  };
  seed.checkpoint({ id: run.runId, sequence: 1, value: run }, binding);
  await seed.persist();
  store.audit.checkpoint({ id: run.runId, sequence: 2, delta: true, value: {
    runId: run.runId, version: 2, toolCalls: 2, gatedToolCalls: 1, enforcementNeeded: true, callIds: ["read", "shell"],
  } }, binding);
  store.advance(31 * 60_000);
  store.login(null);
  const recovered = store.open();
  recovered.attempt(run.runId, "read", "view_file", true);
  await recovered.kick();
  expect(recovered.outbox.readPending().find(entry => entry.row.report_seq === 2)?.row).toMatchObject({ tool_calls: 2, gated_tool_calls: 1, end_reason: "recovered" });
});

test("a killed host retains the open run and counters without a flush", async () => {
  const store = setup();
  const child = Bun.spawn([process.execPath, new URL("./runs-child.ts", import.meta.url).pathname, store.dir], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  const recovered = store.open();
  store.login(null);
  store.advance(31 * 60_000);
  await recovered.kick();
  expect(recovered.outbox.readPending().map(p => p.row).sort((a, b) => a.report_seq - b.report_seq)).toEqual([
    expect.objectContaining({ run_id: "killed", report_seq: 1 }),
    expect.objectContaining({ run_id: "killed", report_seq: 2, tool_calls: 1, end_reason: "recovered" }),
  ]);
});

test("another live runtime does not recover a session that is still running", async () => {
  const store = setup();
  const first = store.open();
  first.begin("live", "s", Date.now(), true);
  const second = store.open();
  expect(second.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(0);
  await first.stop();
  const restarted = store.open();
  expect(restarted.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(0);
  const overlapping = store.open();
  overlapping.end("live", "stop", Date.now());
  expect(restarted.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(0);
  restarted.end("live", "stop", Date.now());
  expect(restarted.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(1);
});

test("tool checkpoints grow by deltas and replay all ids after restart", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("deltas", "s", Date.now(), true);
  for (let n = 0; n < 100; n++) pump.attempt("deltas", `call-${n}`, "bash", true);
  const text = readdirSync(`${store.dir}/outbox/runs-v2`).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(`${store.dir}/outbox/runs-v2/${f}`, "utf8")).join("");
  expect(text.split("call-0").length - 1).toBe(1);
  await pump.stop();
  const next = store.open();
  next.attempt("deltas", "call-0", "bash", true);
  next.end("deltas", "stop", Date.now());
  expect(next.outbox.readPending().find(p => p.row.report_seq === 2)?.row.tool_calls).toBe(100);
});

test("shutdown waits for a registration before persisting the final report", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  const settle = pump.registration("r");
  pump.request("r", "request", "pending");
  pump.end("r", "stop", Date.now());
  let stopped = false;
  const stopping = pump.stop().then(() => { stopped = true; });
  await Bun.sleep(0);
  expect(stopped).toBe(false);
  pump.request("r", "request", "confirmed", "11111111-1111-4111-8111-111111111111");
  settle();
  await stopping;
  expect(pump.outbox.readPending().find(p => p.row.report_seq === 2)?.row.plan_ids).toEqual(["11111111-1111-4111-8111-111111111111"]);
});
