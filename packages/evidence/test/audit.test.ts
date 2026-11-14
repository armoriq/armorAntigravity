import type { AuditRow } from "@armorantigravity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { attribute } from "../src/attribution.ts";
import { parseFailures } from "../src/io/backend-audit.ts";
import { retryAfterMs } from "../src/io/http.ts";
import { createAuditPump } from "../src/pumps/audit.ts";
import { login, quietLog, stubBackend, tempDir, until, uploads, type Handler } from "./support.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAST = { intervalMs: 60_000, minBackoffMs: 10, maxBackoffMs: 50, stopBudgetMs: 2_000 };

function row(n: number, overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    session_id: "conv-raw-id",
    agent_id: "antigravity",
    client_id: "armorantigravity",
    step_index: -1,
    action: "run_command",
    tool: "run_command",
    input: { CommandLine: `echo ${n}` },
    status: "success",
    executed_at: new Date(1_760_000_000_000 + n).toISOString(),
    ...overrides,
  };
}

type Rows = { rows: Array<AuditRow & { client_row_id: string }> };
const rowsOf = (body: unknown): Rows["rows"] => (body as Rows).rows;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(handler: Handler, timing: Partial<typeof FAST> = {}) {
  const backend = stubBackend({ "POST /iap/audit/batch": handler });
  const tmp = tempDir();
  cleanups.push(backend.stop, tmp.cleanup);
  const up = uploads(() => login(backend.url));
  const pump = createAuditPump({ dataDir: tmp.dir, uploads: up, log: quietLog, timing: { ...FAST, ...timing } });
  return { backend, tmp, up, pump, sent: () => backend.hits("POST", "/iap/audit/batch").map((r) => rowsOf(r.body)) };
}

describe("audit pump", () => {
  test("every row carries one client_row_id that survives a resend", async () => {
    let calls = 0;
    const { pump, sent } = setup(() => (++calls === 1 ? { status: 503, body: { message: "down" } } : { body: { written: 2, failures: [] } }));
    pump.enqueue(row(1));
    pump.enqueue(row(2));
    pump.start();
    await until(() => (pump.kick(), sent().length >= 2));
    await pump.stop();
    const [first, second] = sent();
    expect(first?.map((r) => r.client_row_id).every((id) => UUID.test(id))).toBe(true);
    expect(second?.map((r) => r.client_row_id)).toEqual(first?.map((r) => r.client_row_id) ?? []);
    expect(new Set(first?.map((r) => r.client_row_id)).size).toBe(2);
  });

  test("a backend that defers part of every batch gets smaller batches, and no row is dead-lettered", async () => {
    const { pump, sent, tmp } = setup(({ body }) => {
      const rows = rowsOf(body);
      const failures = rows.slice(50).map((_, i) => ({ index: 50 + i, error: `batch budget exhausted after 10001ms; row deferred for retry` }));
      return { body: { written: rows.length - failures.length, failures } };
    });
    for (let n = 0; n < 400; n++) pump.enqueue(row(n));
    pump.start();
    await until(() => (pump.kick(), sent().reduce((n, b) => n + Math.min(b.length, 50), 0) >= 400), 8_000);
    await pump.stop();
    expect(sent()[1]?.length).toBe(50);
    expect(() => readdirSync(path.join(tmp.dir, "outbox", "audit", "dead"))).toThrow();
  });

  test("an invalid row is dead-lettered, a deferred row is retried, accepted rows are not resent", async () => {
    let calls = 0;
    const { pump, sent, tmp } = setup(({ body }) => {
      calls += 1;
      if (calls === 1) return { body: { written: 1, failures: [{ index: 0, error: "invalid row: action must be a string" }, { index: 2, error: "batch budget exhausted after 10012ms; row deferred for retry" }] } };
      return { body: { written: rowsOf(body).length, failures: [] } };
    });
    for (const n of [1, 2, 3]) pump.enqueue(row(n));
    pump.start();
    await until(() => sent().length >= 1);
    pump.kick();
    await until(() => sent().length >= 2);
    await pump.stop();
    const [first, second] = sent();
    expect(first?.length).toBe(3);
    expect(second?.map((r) => r.input)).toEqual([{ CommandLine: "echo 3" }]);
    expect(second?.[0]?.client_row_id).toBe(first?.[2]?.client_row_id ?? "");
    const deadDir = path.join(tmp.dir, "outbox", "audit", "dead");
    const dead = readdirSync(deadDir).map((f) => readFileSync(path.join(deadDir, f), "utf8")).join("");
    expect(dead).toContain("invalid row: action must be a string");
    expect(dead).toContain("echo 1");
  });

  test("a 2xx without a failures list is a failed send", async () => {
    let calls = 0;
    const { pump, sent } = setup(() => (++calls === 1 ? { body: { ok: true } } : { body: { written: 1, failures: [] } }));
    pump.enqueue(row(1));
    pump.start();
    await until(() => (pump.kick(), sent().length >= 2));
    await pump.stop();
    expect(sent()[1]?.[0]?.client_row_id).toBe(sent()[0]?.[0]?.client_row_id ?? "");
  });

  test("Retry-After holds the next send back", async () => {
    let calls = 0;
    const { pump, sent } = setup(() => (++calls === 1 ? { status: 429, headers: { "Retry-After": "1" }, body: {} } : { body: { written: 1, failures: [] } }), { maxBackoffMs: 5_000 });
    pump.enqueue(row(1));
    pump.start();
    await until(() => sent().length >= 1);
    const firstAt = Date.now();
    for (let i = 0; i < 10; i++) {
      pump.kick();
      await Bun.sleep(50);
    }
    expect(sent().length).toBe(1);
    await until(() => (pump.kick(), sent().length >= 2), 3_000);
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(900);
    await pump.stop();
  });

  test("a 413 halves the batch and the rest still goes out", async () => {
    const { pump, sent } = setup(({ body }) => (rowsOf(body).length > 2 ? { status: 413, body: {} } : { body: { written: rowsOf(body).length, failures: [] } }));
    for (const n of [1, 2, 3, 4, 5]) pump.enqueue(row(n));
    pump.start();
    await until(() => sent().filter((b) => b.length <= 2).flat().length >= 5);
    await pump.stop();
    const delivered = sent().filter((b) => b.length <= 2).flat().map((r) => r.input);
    expect(delivered).toHaveLength(5);
  });

  test("stop() sends what is queued before exiting", async () => {
    const { pump, sent } = setup(() => ({ body: { written: 1, failures: [] } }));
    pump.enqueue(row(7));
    await pump.stop();
    expect(sent().flat().map((r) => r.input)).toEqual([{ CommandLine: "echo 7" }]);
  });

  test("rows queued while the backend is down are adopted and sent by the next daemon", async () => {
    const tmp = tempDir();
    const down = stubBackend({ "POST /iap/audit/batch": () => ({ status: 503, body: {} }) });
    const up = stubBackend({ "POST /iap/audit/batch": ({ body }) => ({ body: { written: rowsOf(body).length, failures: [] } }) });
    cleanups.push(tmp.cleanup, down.stop, up.stop);
    const first = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => login(down.url)), log: quietLog, timing: { ...FAST, stopBudgetMs: 300 } });
    first.enqueue(row(9));
    await first.stop();
    const firstIds = down.hits("POST", "/iap/audit/batch").map((r) => rowsOf(r.body)[0]?.client_row_id);
    const second = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => login(up.url)), log: quietLog, timing: FAST });
    second.start();
    await until(() => up.hits("POST", "/iap/audit/batch").length >= 1);
    await second.stop();
    const resent = rowsOf(up.hits("POST", "/iap/audit/batch")[0]?.body);
    expect(resent.map((r) => r.input)).toEqual([{ CommandLine: "echo 9" }]);
    expect(firstIds).toContain(resent[0]?.client_row_id);
  });

  test("nothing is sent while logged out", async () => {
    const backend = stubBackend({ "POST /iap/audit/batch": () => ({ body: { written: 1, failures: [] } }) });
    const tmp = tempDir();
    cleanups.push(backend.stop, tmp.cleanup);
    const pump = createAuditPump({ dataDir: tmp.dir, uploads: uploads(() => null), log: quietLog, timing: { ...FAST, stopBudgetMs: 200 } });
    pump.enqueue(row(1));
    pump.start();
    await Bun.sleep(100);
    await pump.stop();
    expect(backend.requests).toHaveLength(0);
  });
});

describe("audit ack parsing", () => {
  test("failures must index rows of this batch", () => {
    expect(parseFailures({ failures: [{ index: 0, error: "x" }] }, 1)).toEqual([{ index: 0, error: "x" }]);
    expect(parseFailures({ failures: [{ index: 1, error: "x" }] }, 1)).toBeNull();
    expect(parseFailures({ written: 1 }, 1)).toBeNull();
    expect(parseFailures({ failures: [{ index: "0", error: "x" }] }, 1)).toBeNull();
  });

  test("Retry-After reads seconds and HTTP dates", () => {
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe("audit attribution", () => {
  test("rows carry the product ids and surface, and keep the raw session id", () => {
    const stamped = attribute(row(1, { agent_id: "opencode", client_id: "armoropencode" }), "app");
    expect(stamped).toMatchObject({ session_id: "conv-raw-id", agent_id: "antigravity", client_id: "armorantigravity" });
    expect(stamped.input).toEqual({ CommandLine: "echo 1", _antigravity_surface: "app" });
  });
});
