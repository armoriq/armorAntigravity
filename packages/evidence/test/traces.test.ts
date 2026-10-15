import { parsePolicyLease, type SpooledSpan, type SpooledSpanBatch } from "@armoriq/sdk-dev";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalModel } from "../src/model.ts";
import { createTraceSpool } from "../src/io/trace-spool.ts";
import { createTracePump } from "../src/pumps/traces.ts";
import { login, quietLog, stubBackend, tempDir, until, uploads } from "./support.ts";

const lease = () => parsePolicyLease({ captureMode: "metadata", revision: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function spooled(dataDir: string): SpooledSpan[] {
  const dir = path.join(dataDir, "traces", "spool");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {}
  return names.flatMap((n) => (JSON.parse(readFileSync(path.join(dir, n), "utf8")) as SpooledSpanBatch).spans);
}

const CONV = "c0ffee00-raw-conversation-id";

describe("trace pump", () => {
  test("a turn spools a root with agentId, a block decision, an MCP tool span with duration and a priced-model chat span", async () => {
    const tmp = tempDir();
    // Refuses every export, so spans stay in the spool where the test reads them.
    const backend = stubBackend({ "POST /v1/traces": () => ({ status: 503, body: {} }) });
    cleanups.push(tmp.cleanup, backend.stop);
    const up = uploads(() => login(backend.url));
    const pump = createTracePump({ dataDir: tmp.dir, uploads: up, log: quietLog }, { intervalMs: 60_000, runtimeOptions: { leaseFetcher: async () => lease() } });
    pump.start();
    const t0 = Date.now();
    const call = { sessionId: CONV, callId: `${CONV}:3`, tool: "call_mcp_tool", args: { ServerName: "github", ToolName: "list_issues" }, mcpServer: "github" };
    pump.record({ kind: "turn_start", sessionId: CONV, at: t0 });
    pump.record({ kind: "decision", call: { ...call, callId: `${CONV}:2`, tool: "run_command", mcpServer: null }, decision: { kind: "deny", code: "intent_drift", reason: "run_command not in plan", ruleId: null }, at: t0 + 5 });
    pump.record({ kind: "decision", call, decision: { kind: "allow", stepIndex: 0, paramMismatch: false }, at: t0 + 10 });
    pump.record({ kind: "tool", call, ok: true, output: "3 issues", durationMs: 420, at: t0 + 430 });
    pump.record({ kind: "model", sessionId: CONV, calls: [{ key: `${CONV}:step-1`, model: "gemini-3.1-pro-high", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0, at: t0 + 600 }] });
    pump.record({ kind: "turn_end", sessionId: CONV, at: t0 + 700 });
    pump.kick();
    await until(() => spooled(tmp.dir).some((s) => s.name === "armoriq.agent.run"), 8_000);
    await pump.stop();

    const spans = spooled(tmp.dir);
    const root = spans.find((s) => s.name === "armoriq.agent.run");
    expect(root?.attributes["armoriq.agent_id"]).toBe("antigravity");
    expect(root?.attributes["gen_ai.agent.name"]).toBe("antigravity");
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);

    const policy = spans.filter((s) => s.attributes["armoriq.policy.decision"] !== undefined);
    expect(policy.map((s) => s.attributes["armoriq.policy.decision"]).sort()).toEqual(["allow", "deny"]);
    expect(policy.find((s) => s.attributes["armoriq.policy.decision"] === "deny")?.attributes["armoriq.policy.reason_code"]).toBe("intent_drift");

    const tool = spans.find((s) => s.attributes["armoriq.tool.name"] === "call_mcp_tool" && s.attributes["armoriq.policy.decision"] === undefined);
    expect(tool?.attributes["armoriq.operation.category"]).toBe("mcp");
    expect(tool?.attributes["armoriq.mcp.server"]).toBe("github");
    expect(tool?.attributes["armoriq.duration_ms"]).toBe(420);

    const chat = spans.find((s) => s.name === "gen_ai.chat");
    expect(chat?.attributes["gen_ai.request.model"]).toBe("gemini-3.1-pro-preview");
    expect(chat?.attributes["gen_ai.system"]).toBe("google");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(1200);
    for (const s of spans) if (s.parentSpanId) expect(s.parentSpanId).toBe(root?.spanId ?? "");
  });

  test("spans spooled while the backend is down are shipped by the next daemon and then removed", async () => {
    const tmp = tempDir();
    let available = false;
    const backend = stubBackend({ "POST /v1/traces": () => (available ? { status: 200, body: {} } : { status: 503, body: {} }) });
    cleanups.push(tmp.cleanup, backend.stop);
    const options = { intervalMs: 60_000, stopDeadlineMs: 300, runtimeOptions: { leaseFetcher: async () => lease() } };
    const first = createTracePump({ dataDir: tmp.dir, uploads: uploads(() => login(backend.url)), log: quietLog }, options);
    first.start();
    first.record({ kind: "turn_start", sessionId: CONV, at: Date.now() });
    first.record({ kind: "turn_end", sessionId: CONV, at: Date.now() + 1 });
    first.kick();
    await until(() => spooled(tmp.dir).length > 0, 8_000);
    await first.stop();
    const left = spooled(tmp.dir).length;
    expect(left).toBeGreaterThan(0);

    available = true;
    const before = backend.hits("POST", "/v1/traces").length;
    const second = createTracePump({ dataDir: tmp.dir, uploads: uploads(() => login(backend.url)), log: quietLog }, options);
    second.start();
    await until(() => spooled(tmp.dir).length === 0, 8_000);
    await second.stop();
    expect(backend.hits("POST", "/v1/traces").length).toBeGreaterThan(before);
  });
});

describe("trace pump across turns", () => {
  test("a second turn still records and ships, though closing a turn's session closes its runtime", async () => {
    const tmp = tempDir();
    const backend = stubBackend({ "POST /v1/traces": () => ({ status: 200, body: {} }) });
    cleanups.push(tmp.cleanup, backend.stop);
    const pump = createTracePump({ dataDir: tmp.dir, uploads: uploads(() => login(backend.url)), log: quietLog }, { intervalMs: 60_000, runtimeOptions: { leaseFetcher: async () => lease() } });
    const logged = quietLog.lines.length;
    pump.start();
    for (const turn of [1, 2]) {
      const at = Date.now();
      pump.record({ kind: "turn_start", sessionId: CONV, at });
      pump.record({ kind: "turn_end", sessionId: CONV, at: at + 1 });
      pump.kick();
      await until(() => backend.hits("POST", "/v1/traces").length >= turn, 8_000);
    }
    await pump.stop();
    expect(spooled(tmp.dir)).toHaveLength(0);
    expect(quietLog.lines.slice(logged).filter((l) => l.message === "traces: spool ship incomplete")).toEqual([]);
  });
});

describe("trace shutdown and outages", () => {
  test("stop() with a backend that never answers still spools the open turn's root and decision", async () => {
    const tmp = tempDir();
    let ships = 0;
    const backend = stubBackend({ "POST /v1/traces": async () => (ships++, await Bun.sleep(15_000), { status: 200, body: {} }) });
    cleanups.push(tmp.cleanup, backend.stop);
    const pump = createTracePump({ dataDir: tmp.dir, uploads: uploads(() => login(backend.url)), log: quietLog }, { intervalMs: 60_000, runtimeOptions: { leaseFetcher: async () => lease() } });
    pump.start();
    const t0 = Date.now();
    pump.record({ kind: "turn_start", sessionId: "done-turn", at: t0 });
    pump.record({ kind: "turn_end", sessionId: "done-turn", at: t0 + 1 });
    pump.kick();
    await until(() => ships > 0, 8_000);
    pump.record({ kind: "turn_start", sessionId: "open-turn", at: t0 + 2 });
    pump.record({ kind: "decision", call: { sessionId: "open-turn", callId: "open-turn:1", tool: "run_command", args: {}, mcpServer: null }, decision: { kind: "deny", code: "intent_drift", reason: "not in plan", ruleId: null }, at: t0 + 3 });
    const begun = Date.now();
    await pump.stop();
    expect(Date.now() - begun).toBeLessThan(5_000);
    const open = spooled(tmp.dir).filter((sp) => sp.attributes["armoriq.session_id"] === "open-turn");
    expect(open.map((sp) => sp.name)).toContain("armoriq.agent.run");
    expect(open.some((sp) => sp.attributes["armoriq.policy.decision"] === "deny")).toBe(true);
  }, 20_000);

  test("a spooled batch survives many failed rounds; only the age and size caps remove it", async () => {
    const tmp = tempDir();
    const spool = createTraceSpool(tmp.dir, quietLog);
    await spool.sink.write({ version: 1, binding: "a".repeat(64), spans: [], seal: "" });
    const exporter = { spoolBinding: "a".repeat(64), exportSpooled: async (b: readonly unknown[]) => b.map(() => ({ status: "failed" as const, reason: "export_failed" as const })) };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let round = 0; round < 20; round++) {
        await spool.ship(exporter);
        now += 11 * 60_000;
      }
    } finally {
      Date.now = realNow;
    }
    expect(await spool.pending("a".repeat(64))).toBe(1);
  });
});

describe("model ids", () => {
  test("Antigravity slugs and display names reduce to the provider's id", () => {
    expect(canonicalModel("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
    expect(canonicalModel("Gemini 3.1 Pro (High)")).toBe("gemini-3.1-pro-preview");
    expect(canonicalModel("Claude Sonnet 5.5 (Thinking)")).toBe("claude-sonnet-5-5");
    expect(canonicalModel("claude-opus-4.6")).toBe("claude-opus-4-6");
    expect(canonicalModel("models/gemini-3.6-flash")).toBe("gemini-3.6-flash");
    expect(canonicalModel("")).toBe("unknown");
  });
});
