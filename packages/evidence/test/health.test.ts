import { afterEach, expect, test } from "bun:test";
import { createHealthPump } from "../src/pumps/health.ts";
import { auditLogin, createAuditPump } from "../src/pumps/audit.ts";
import { parseClientEventsReply, postClientEvents } from "../src/io/backend-client-events.ts";
import { createEvidence, evidencePlugin, type EvidenceRecorder } from "../src/plugin.ts";
import { login, quietLog, tempDir, uploads } from "./support.ts";
import { readdirSync, existsSync } from "node:fs";
import { createRunsPump } from "../src/pumps/runs.ts";
import { parseRunsReply } from "../src/io/backend-runs.ts";
import contract from "./fixtures/client-events-v1.json";
import { CLIENT_EVENTS } from "@armorantigravity/core";

test("health wire constants follow the current published contract", () => {
  expect(contract.queues).toEqual([...CLIENT_EVENTS.queues]);
  for (const type of Object.keys(CLIENT_EVENTS.reasons) as (keyof typeof CLIENT_EVENTS.reasons)[]) expect(contract.reasonCodes[type]).toEqual([...CLIENT_EVENTS.reasons[type]]);
  expect(Object.keys(contract.outcomes).sort()).toEqual([...CLIENT_EVENTS.outcomes].sort());
});

test("idle health restarts create no journals and successful requests skip unrelated journals", async () => {
  const s = setup();
  cleanup.push(async () => s.cleanup());
  for (let n = 0; n < 3; n++) {
    const health = createHealthPump(s.deps);
    await health.loginChanged(false);
    await health.planRequestSucceeded(s.auth, "never-failed");
    expect(health.outbox.diagnostics().replays).toBe(0);
    await health.stop();
  }
  const root = `${s.dir}/outbox/health-v2`;
  expect(existsSync(root) ? readdirSync(root).filter(f => f.endsWith(".jsonl")) : []).toEqual([]);
});

// regression: #0012
test("draining a health backlog after restart creates no empty writer journals", async () => {
  const s = setup();
  const deps = { ...s.deps, post: async () => ({ ok: false as const, stallReason: "server_error" as const }) };
  let health = createHealthPump(deps);
  cleanup.push(async () => { await health.stop(); s.cleanup(); });
  await health.planRequestFailed(s.auth, "backlog", "timeout");
  await health.stop();
  const files = () => readdirSync(`${s.dir}/outbox/health-v2`).filter(file => file.endsWith(".jsonl"));
  const original = files();
  expect(original).toHaveLength(1);
  for (let restart = 0; restart < 3; restart++) {
    health = createHealthPump(deps);
    await health.loginChanged(false);
    expect(health.status().pending).toBe(1);
    await health.stop();
    expect(files()).toEqual(original);
  }
});

// regression: #0012
test.each(["health", "runs"] as const)("%s org_required holds back off across restart, keep every row and lift only on delivery", async stream => {
  const s = setup();
  let now = 1000;
  let status = 403;
  let calls = 0;
  const delivered: string[] = [];
  const opened: { stop(): Promise<void> }[] = [];
  const clock = { now: () => now, random: () => 0 };
  const open = () => {
    const pump = stream === "health" ? createHealthPump({ ...s.deps, clock, post: async (_auth, _uploads, rows) => {
      calls++;
      if (status === 0) throw new Error("lost reply");
      if (status === 200) delivered.push(...rows.map(row => row.event_id));
      return parseClientEventsReply(status, status === 403 ? { error: "org_required" } : status === 200 ? { results: rows.map(row => ({ event_id: row.event_id, outcome: "accepted" })) } : {}, new Headers(), rows);
    } }) : createRunsPump({ ...s.deps, clock, enabled: true, post: async (_auth, _uploads, rows) => {
      calls++;
      if (status === 0) throw new Error("lost reply");
      if (status === 200) delivered.push(...rows.map(row => row.run_id));
      return parseRunsReply(status, status === 403 ? { error: "org_required" } : status === 200 ? { results: rows.map(row => ({ run_id: row.run_id, report_seq: row.report_seq, outcome: "accepted" })) } : {}, new Headers(), rows);
    } });
    opened.push(pump);
    return pump;
  };
  cleanup.push(async () => { for (const p of opened) await p.stop(); s.cleanup(); });
  let pump = open();
  const append = async (id: string) => {
    if (stream === "health") await (pump as ReturnType<typeof createHealthPump>).planRequestFailed(s.auth, id, "timeout");
    else (pump as ReturnType<typeof createRunsPump>).outbox.enqueue({ run_id: id, report_seq: 1, session_id: "s", started_at: new Date(1000).toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
  };
  await append("first");
  for (const [index, delay] of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000].entries()) {
    status = index === 1 ? 503 : 403;
    await pump.kick();
    expect(calls).toBe(index + 1);
    await append(`later-${index}`);
    expect(pump.status()).toMatchObject({ pending: index + 2, undeliverable: index + 2, held: ["org_required"], paused: false, deadLetters: 0 });
    expect(pump.outbox.readPending().every(entry => entry.attempts === 0)).toBe(true);
    await pump.stop();
    pump = open();
    await pump.outbox.authenticationSucceeded(auditLogin(s.auth));
    now += delay - 1;
    await pump.kick();
    expect(calls).toBe(index + 1);
    now++;
  }
  status = 0;
  await pump.kick();
  const before = calls;
  expect(pump.status()).toMatchObject({ pending: 7, held: ["org_required"], paused: false });
  await pump.stop();
  pump = open();
  status = 200;
  now += 3_599_999;
  await pump.kick();
  expect(calls).toBe(before);
  now++;
  await pump.kick();
  expect(delivered).toHaveLength(7);
  expect(new Set(delivered).size).toBe(7);
  expect(pump.status()).toMatchObject({ pending: 0, held: [], deadLetters: 0 });
});

test.each(["health", "runs"] as const)("%s authentication pause lifts through its periodic probe", async stream => {
  const s = setup();
  let now = 1000;
  let refused = true;
  let probes = 0;
  const deps = { ...s.deps, clock: { now: () => now, random: () => 0 }, probe: async () => { probes++; return true; } };
  const pump = stream === "health" ? createHealthPump({ ...deps, post: async () => refused ? { ok: false, relogin: true } : { ok: true, rejected: [] } })
    : createRunsPump({ ...deps, enabled: true, post: async () => refused ? { ok: false, relogin: true } : { ok: true, rejected: [] } });
  cleanup.push(async () => { await pump.stop(); s.cleanup(); });
  if (stream === "health") await (pump as ReturnType<typeof createHealthPump>).planRequestFailed(s.auth, "paused", "timeout");
  else (pump as ReturnType<typeof createRunsPump>).begin("paused", "s", now, true);
  await pump.kick();
  expect(pump.status().paused).toBe(true);
  refused = false;
  now += 120_000;
  await pump.kick();
  expect(probes).toBe(1);
  expect(pump.status()).toMatchObject({ pending: 0, paused: false });
});

test("run dead letters and stalls reach health with queue runs", async () => {
  const s = setup();
  let now = Date.now();
  const events: any[] = [];
  const health = createHealthPump({ ...s.deps, post: async (_auth, _uploads, rows) => { events.push(...rows); return { ok: true, rejected: [] }; } });
  const runs = createRunsPump({ ...s.deps, health, enabled: true, clock: { now: () => now, random: () => 0 }, post: async (_auth, _uploads, reports) => ({ ok: true, rejected: reports.map(item => ({ item, error: "refused", permanent: true })) }) });
  cleanup.push(async () => { await runs.stop(); await health.stop(); s.cleanup(); });
  runs.begin("refused", "s", now, true);
  await runs.kick();
  expect(events).toContainEqual(expect.objectContaining({ queue: "runs", type: "dead_letter", count: 1 }));
  runs.begin("stalled", "s", now, true);
  const pending = runs.outbox.readPending();
  await runs.outbox.drain(async () => ({ ok: false, stallReason: "server_error" }));
  now += 3_600_000;
  await runs.outbox.reportHealth(health.outbox);
  await health.kick();
  expect(events).toContainEqual(expect.objectContaining({ queue: "runs", type: "queue_stalled", count: pending.length }));
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function setup() {
  const tmp = tempDir();
  const auth = login("http://localhost:1");
  return { ...tmp, auth, deps: { dataDir: tmp.dir, uploads: uploads(() => auth), log: quietLog } };
}

test("audit dead letters reach the health endpoint with their source login", async () => {
  const s = setup();
  const delivered: unknown[] = [];
  const health = createHealthPump({ ...s.deps, post: async (bound, _uploads, events) => {
    expect(bound).toEqual(s.auth);
    delivered.push(...events);
    return { ok: true, rejected: [] };
  } });
  const audit = createAuditPump({ ...s.deps, health, post: async () => ({ ok: true, value: { written: 0, failures: [{ index: 0, error: "invalid row: rejected" }] } }) });
  cleanup.push(async () => { await audit.stop(); await health.stop(); s.cleanup(); });
  audit.enqueue({ client_row_id: crypto.randomUUID(), tool: "run_command" } as any);
  await audit.kick();
  expect(delivered).toEqual([expect.objectContaining({ type: "dead_letter", queue: "audit", count: 1, reason_code: "rejected" })]);
});

test("failed request ids deduplicate across restart and a 404 retains the events", async () => {
  const s = setup();
  const deps = { ...s.deps, post: async () => ({ ok: false as const, endpointStatus: 404 }) };
  let health = createHealthPump(deps);
  await health.planRequestFailed(s.auth, "logical-request", "timeout");
  await health.kick();
  await health.stop();
  health = createHealthPump(deps);
  cleanup.push(async () => { await health.stop(); s.cleanup(); });
  await health.planRequestFailed(s.auth, "logical-request", "timeout");
  expect(health.status()).toMatchObject({ pending: 1, paused: true });
});

test("the health transport sends client headers and settles duplicate outcomes", async () => {
  const s = setup();
  cleanup.push(async () => s.cleanup());
  const original = globalThis.fetch;
  const event = { event_id: crypto.randomUUID(), type: "plan_request_failed" as const, queue: "health" as const, count: 1, reason_code: "timeout" as const, occurred_at: new Date().toISOString() };
  try {
    globalThis.fetch = (async (url, init) => {
      expect(url).toBe(`${s.auth.backend}/iap/client-events`);
      expect(JSON.parse(String(init!.body))).toEqual({ events: [event] });
      expect(new Headers(init!.headers).get("x-armoriq-client")).toBe("armorantigravity/0.1.0");
      expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${s.auth.apiKey}`);
      return Response.json({ results: [{ event_id: event.event_id, outcome: "duplicate" }] });
    }) as typeof fetch;
    expect(await postClientEvents(s.auth, s.deps.uploads, [event])).toMatchObject({ ok: true, rejected: [] });
  } finally { globalThis.fetch = original; }
});

test("provisional failures wait for the logical deadline and confirmed success cancels them", async () => {
  const s = setup();
  let now = 0;
  const delivered: unknown[] = [];
  const deps = { ...s.deps, clock: { now: () => now, random: () => 0 }, post: async (_auth: any, _uploads: any, events: readonly unknown[]) => {
    delivered.push(...events);
    return { ok: true as const, rejected: [] };
  } };
  let health = createHealthPump(deps);
  await health.planRequestFailed(s.auth, "recovered", "network", 40_000);
  await health.kick();
  expect(delivered).toHaveLength(0);
  await health.stop();
  health = createHealthPump(deps);
  cleanup.push(async () => { await health.stop(); s.cleanup(); });
  await health.planRequestSucceeded(s.auth, "recovered");
  await health.planRequestFailed(s.auth, "exhausted", "network", 40_000);
  now = 40_000;
  await health.kick();
  await health.planRequestFailed(s.auth, "exhausted", "network");
  await health.kick();
  expect(delivered).toEqual([expect.objectContaining({ type: "plan_request_failed", reason_code: "network", occurred_at: new Date(40_000).toISOString() })]);
});

test("a final refusal replaces a provisional failure immediately", async () => {
  const s = setup();
  const delivered: unknown[] = [];
  const health = createHealthPump({ ...s.deps, clock: { now: () => 1000, random: () => 0 }, post: async (_auth, _uploads, events) => {
    delivered.push(...events);
    return { ok: true, rejected: [] };
  } });
  cleanup.push(async () => { await health.stop(); s.cleanup(); });
  await health.planRequestFailed(s.auth, "request", "network", 40_000);
  await health.planRequestFailed(s.auth, "request", "rejected");
  await health.kick();
  expect(delivered).toEqual([expect.objectContaining({ reason_code: "rejected", occurred_at: new Date(1000).toISOString() })]);
});

test("health refuses ambiguous acknowledgements and never reports its own dead letters", async () => {
  const s = setup();
  const health = createHealthPump(s.deps);
  cleanup.push(async () => { await health.stop(); s.cleanup(); });
  await health.planRequestFailed(s.auth, "request", "timeout");
  const events = health.outbox.readPending().map(({ row }) => row);
  for (const body of [null, {}, { results: null }, { results: [{ event_id: "foreign", outcome: "accepted" }] }, { results: events.flatMap(e => [{ event_id: e.event_id, outcome: "accepted" }, { event_id: e.event_id, outcome: "duplicate" }]) }]) {
    expect(parseClientEventsReply(200, body, new Headers(), events).ok).toBe(false);
  }
  await health.outbox.drain(async rows => parseClientEventsReply(400, {}, new Headers(), rows));
  expect(health.status()).toMatchObject({ pending: 0, deadLetters: 1 });
  await health.outbox.reportHealth(health.outbox);
  expect(health.status().pending).toBe(0);
});

test("evidence starts and exposes the health pump", async () => {
  const s = setup();
  const evidence = createEvidence({ ...s.deps, uploads: uploads(() => null) });
  cleanup.push(async () => { for (const pump of Object.values(evidence.pumps)) await pump.stop(); s.cleanup(); });
  expect(evidence.pumps.health.name).toBe("health");
  evidence.start();
});

test("daemon shutdown waits for audit before closing the health outbox", async () => {
  const s = setup();
  let health = undefined as ReturnType<typeof createHealthPump> | undefined;
  const plugin = evidencePlugin({ onRecorder: recorder => { health = recorder.health as ReturnType<typeof createHealthPump>; } });
  const registration = plugin.setup({ paths: { dataDir: s.dir }, log: quietLog, auth: {
    client: s.deps.uploads.client, headers: s.deps.uploads.headers, uploadLogin: () => null, reportStatus() {},
  } });
  cleanup.push(async () => s.cleanup());
  await Promise.all(registration.pumps.map(pump => pump.stop()));
  expect(health!.status()).toMatchObject({ pending: 0 });
});

test("another authenticated call resumes health and runs for the same credential", async () => {
  const s = setup();
  let listener: ((login: typeof s.auth) => void) | undefined;
  let recorder: EvidenceRecorder | undefined;
  const original = globalThis.fetch;
  let refused = true;
  const delivered: string[] = [];
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    if (refused) return Response.json({}, { status: 401 });
    delivered.push(...(body.events ?? body.reports ?? []).map((row: any) => row.event_id ?? row.run_id));
    return Response.json({ results: (body.events ?? body.reports ?? []).map((row: any) => ({ ...row, outcome: "accepted" })) });
  }) as typeof fetch;
  const registration = evidencePlugin({ runReportingEnabled: true, onRecorder: value => { recorder = value; } }).setup({ paths: { dataDir: s.dir }, log: quietLog, auth: {
    client: s.deps.uploads.client, headers: {}, uploadLogin: () => s.auth, reportStatus() {}, onAuthenticated(callback) { listener = callback; return () => {}; },
  } });
  try {
    const health = recorder!.health as ReturnType<typeof createHealthPump>;
    const runs = recorder!.runs;
    await health.planRequestFailed(s.auth, "authenticated", "timeout");
    const eventId = health.outbox.readPending()[0]!.row.event_id;
    runs.begin("authenticated", "s", Date.now(), true);
    await health.kick();
    await runs.kick();
    expect(delivered).toEqual([]);
    for (const pump of [health, runs]) {
      expect(pump.status()).toMatchObject({ pending: 1, undeliverable: 1, paused: true });
      expect(pump.outbox.readPending()[0]!.attempts).toBe(0);
    }
    refused = false;
    for (const other of [{ ...s.auth, apiKey: "other-key" }, { ...s.auth, backend: "http://localhost:2" }]) {
      await listener!(other);
      expect(health.status()).toMatchObject({ pending: 1, paused: true });
      expect(runs.status()).toMatchObject({ pending: 1, paused: true });
      expect(delivered).toEqual([]);
    }
    await listener!(s.auth);
    expect(health.status()).toMatchObject({ pending: 0, paused: false });
    expect(runs.status()).toMatchObject({ pending: 0, paused: false });
    expect(delivered.sort()).toEqual([eventId, "authenticated"].sort());
  } finally {
    await Promise.all(registration.pumps.map(pump => pump.stop()));
    globalThis.fetch = original;
    s.cleanup();
  }
});
