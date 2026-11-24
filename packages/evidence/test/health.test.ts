import { afterEach, expect, test } from "bun:test";
import { createHealthPump } from "../src/pumps/health.ts";
import { createAuditPump } from "../src/pumps/audit.ts";
import { parseClientEventsReply, postClientEvents } from "../src/io/backend-client-events.ts";
import { createEvidence, evidencePlugin } from "../src/plugin.ts";
import { login, quietLog, tempDir, uploads } from "./support.ts";

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
