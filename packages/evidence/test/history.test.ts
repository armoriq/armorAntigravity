import { afterEach, describe, expect, test } from "bun:test";
import { createHistoryPump } from "../src/pumps/history.ts";
import { createUsagePump } from "../src/pumps/usage.ts";
import type { ConversationRef, SourceRead, SourceStep, UsageSource } from "../src/usage/source.ts";
import { login, quietLog, tempDir, until, uploads } from "./support.ts";
import { usageBackend } from "./usage-stub.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const ROOT = "conv-root-7f3a";
const CHILD = "conv-child-91bc";
const ref = (conversationId: string): ConversationRef => ({ conversationId, transcriptPath: `/tmp/brain/${conversationId}/transcript.jsonl`, workspacePaths: ["/Users/dev/repo"], surface: "cli" });
const step = (key: string, at: number, inputTokens = 100): SourceStep => ({ key, model: "gemini-3.8-flash-high", at, inputTokens, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 7 });

function sourceOf(reads: Record<string, SourceRead>): UsageSource {
  return {
    read: async (r) => reads[r.conversationId] ?? { steps: [], title: null, parentId: null, problems: [] },
    list: async () => Object.keys(reads).map(ref),
  };
}

describe("history and discovery runs", () => {
  test("a console history request resends every hour under one run and reports it complete", async () => {
    const requestId = crypto.randomUUID();
    const t = Date.UTC(2026, 9, 1, 9);
    const history = usageBackend({ "GET /api-keys/device-history-sync": () => ({ body: { requestId, requestedAt: new Date().toISOString() } }) });
    const tmp = tempDir();
    cleanups.push(history.stop, tmp.cleanup);
    const up = uploads(() => login(history.url));
    const usage = createUsagePump({ dataDir: tmp.dir, uploads: up, log: quietLog }, { intervalMs: 60_000, persistDelayMs: 10 });
    const source = sourceOf({
      [ROOT]: { steps: [step("a", t), step("b", t + 3_600_000)], title: null, parentId: null, problems: [] },
      "conv-other": { steps: [step("c", t)], title: null, parentId: null, problems: [] },
    });
    const pump = createHistoryPump({ dataDir: tmp.dir, uploads: up, log: quietLog, usage, source, rootOf: (id) => id }, { firstDelayMs: 0, intervalMs: 60_000 });
    pump.start();
    await until(() => [...history.runs.values()].some((r) => r.completedAt));
    await pump.stop();
    await usage.stop();

    const puts = history.requests.filter((r) => r.method === "PUT");
    const historyPuts = puts.filter((r) => (r.body as { mode: string }).mode === "history");
    expect(historyPuts.map((r) => (r.body as { phase: string }).phase)).toEqual(["discovering", "complete"]);
    expect(historyPuts.every((r) => (r.body as { requestId?: string }).requestId === requestId)).toBe(true);
    const historyRun = historyPuts[0]?.path.split("/").pop();
    const tagged = history.batches().filter((b) => b.runId === historyRun);
    const hours = new Set(tagged.flatMap((b) => b.snapshots.map((s) => `${s.sessionId}|${s.usageDate}|${s.usageHour}`)));
    expect(hours.size).toBe(3);
    expect((historyPuts[1]?.body as { total: number }).total).toBe(3);
    expect(history.hits("GET", "/api-keys/device-history-sync").length).toBeGreaterThan(0);
  });
});

describe("discovery", () => {
  test("with no history request, conversations already on disk upload once under a discovery run", async () => {
    const backend = usageBackend({ "GET /api-keys/device-history-sync": () => ({ body: { requestId: null, requestedAt: null } }) });
    const tmp = tempDir();
    cleanups.push(backend.stop, tmp.cleanup);
    const up = uploads(() => login(backend.url));
    const usage = createUsagePump({ dataDir: tmp.dir, uploads: up, log: quietLog }, { intervalMs: 60_000, persistDelayMs: 10 });
    const source = sourceOf({ [ROOT]: { steps: [step("a", Date.UTC(2026, 8, 30, 8))], title: null, parentId: null, problems: [] } });
    const options = { firstDelayMs: 0, intervalMs: 60_000 };
    const pump = createHistoryPump({ dataDir: tmp.dir, uploads: up, log: quietLog, usage, source, rootOf: (id) => id }, options);
    pump.start();
    await until(() => [...backend.runs.values()].some((r) => r.completedAt));
    await pump.stop();
    const puts = backend.requests.filter((r) => r.method === "PUT").map((r) => r.body as { mode: string; phase: string; requestId?: string });
    expect(puts.map((p) => `${p.mode}:${p.phase}`)).toEqual(["discovery:discovering", "discovery:complete"]);
    expect(puts.every((p) => p.requestId === undefined)).toBe(true);

    const again = createHistoryPump({ dataDir: tmp.dir, uploads: up, log: quietLog, usage, source, rootOf: (id) => id }, options);
    again.start();
    await until(() => backend.hits("GET", "/api-keys/device-history-sync").length >= 2);
    await again.stop();
    await usage.stop();
    expect(backend.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
  });
});
