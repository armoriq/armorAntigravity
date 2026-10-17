import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { createUsageClient, scopeDir, type UsageBatch, type UsageClient } from "../src/io/backend-usage.ts";
import { createUsagePump } from "../src/pumps/usage.ts";
import { observeConversation } from "../src/usage/observe.ts";
import type { ConversationRef, SourceRead, SourceStep, UsageSource } from "../src/usage/source.ts";
import { login, quietLog, tempDir, until, uploads } from "./support.ts";
import { usageBackend } from "./usage-stub.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const ROOT = "conv-root-7f3a";
const CHILD = "conv-child-91bc";
const ref = (conversationId: string): ConversationRef => ({ conversationId, transcriptPath: `/tmp/brain/${conversationId}/transcript.jsonl`, workspacePaths: ["/Users/dev/repo"], surface: "cli", model: null });
const step = (key: string, at: number, inputTokens = 100): SourceStep => ({ key, model: "gemini-3.8-flash-high", at, inputTokens, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 7 });

function sourceOf(reads: Record<string, SourceRead>): UsageSource {
  return {
    read: async (r) => reads[r.conversationId] ?? { steps: [], title: null, parentId: null, problems: [] },
    list: async () => Object.keys(reads).map(ref),
  };
}

function setup(opts: Parameters<typeof usageBackend>[1] = {}, client?: (c: UsageClient) => UsageClient) {
  const backend = usageBackend({}, opts);
  const tmp = tempDir();
  cleanups.push(backend.stop, tmp.cleanup);
  const up = uploads(() => login(backend.url));
  const usage = createUsagePump(
    { dataDir: tmp.dir, uploads: up, log: quietLog },
    { intervalMs: 60_000, persistDelayMs: 10, client: async (l) => (client ? client(await createUsageClient(l, up)) : createUsageClient(l, up)) },
  );
  return { backend, tmp, up, usage };
}

describe("usage pump", () => {
  test("a turn's calls go out as an hour snapshot plus one call record each, under the raw root id", async () => {
    const { backend, usage } = setup();
    const t = Date.UTC(2026, 9, 11, 14, 5);
    const source = sourceOf({ [ROOT]: { steps: [step("s1", t), step("s2", t + 1_000, 300)], title: null, parentId: null, problems: [] } });
    await observeConversation({ usage, source, ref: ref(ROOT), rootOf: (id) => id });
    usage.start();
    await until(() => backend.batches().length > 0);
    await usage.stop();
    const [batch] = backend.batches();
    expect(batch?.snapshots).toEqual([
      expect.objectContaining({ sessionId: ROOT, usageDate: "2026-10-11", usageHour: 14, repo: "/Users/dev/repo", entries: [expect.objectContaining({ model: "gemini-3.8-flash", inputTokens: 400 })] }),
    ]);
    expect(batch?.calls?.[0]?.sessionId).toBe(ROOT);
    expect(batch?.calls?.[0]?.records.map((r) => r.key)).toEqual([`${ROOT}:s1`, `${ROOT}:s2`]);
    expect(batch).toMatchObject({ deviceName: "test-host" });
  });

  test("a subagent's calls roll up into the root session", async () => {
    const { backend, usage } = setup();
    const t = Date.UTC(2026, 9, 11, 15, 0);
    const source = sourceOf({ [CHILD]: { steps: [step("c1", t)], title: { text: "Child title", at: t }, parentId: null, problems: [] } });
    await observeConversation({ usage, source, ref: ref(CHILD), rootOf: (id) => (id === CHILD ? ROOT : id) });
    usage.start();
    await until(() => backend.batches().length > 0);
    await usage.stop();
    const sent = backend.batches();
    expect(sent.flatMap((b) => b.snapshots.map((s) => s.sessionId))).toEqual([ROOT]);
    expect(sent.flatMap((b) => (b.calls ?? []).flatMap((c) => c.records.map((r) => `${c.sessionId}|${r.key}`)))).toEqual([`${ROOT}|${CHILD}:c1`]);
    expect(sent.flatMap((b) => b.sessions ?? [])).toEqual([]);
  });

  test("a 401 on a batch keeps the hour for later instead of refusing it, and reports the status", async () => {
    let status: number | null = 401;
    const backend = usageBackend({}, { refuse: () => status });
    const tmp = tempDir();
    cleanups.push(backend.stop, tmp.cleanup);
    const reports: number[] = [];
    const up = { ...uploads(() => login(backend.url)), report: (s: number) => void reports.push(s) };
    const source = sourceOf({ [ROOT]: { steps: [step("s1", Date.UTC(2026, 9, 11, 13))], title: null, parentId: null, problems: [] } });
    const first = createUsagePump({ dataDir: tmp.dir, uploads: up, log: quietLog }, { intervalMs: 60_000, persistDelayMs: 10 });
    await observeConversation({ usage: first, source, ref: ref(ROOT), rootOf: (id) => id });
    first.start();
    await until(() => backend.hits("POST", "/dashboard/token-usage/batch").length > 0);
    await first.stop();
    expect(reports).toContain(401);

    status = null;
    const second = createUsagePump({ dataDir: tmp.dir, uploads: up, log: quietLog }, { intervalMs: 60_000, persistDelayMs: 10 });
    second.start();
    await until(() => backend.hits("POST", "/dashboard/token-usage/batch").length > 1);
    await second.stop();
    const accepted = backend.batches().slice(1);
    expect(accepted.flatMap((b) => b.snapshots.map((s) => `${s.sessionId}@${s.usageHour}`))).toEqual([`${ROOT}@13`]);
    expect(accepted.flatMap((b) => (b.calls ?? []).flatMap((c) => c.records.map((r) => r.key)))).toEqual([`${ROOT}:s1`]);
  });

  test("a 409 generation re-initialises the stream and captures again", async () => {
    let fenced = 0;
    const { backend, usage } = setup({ generations: [crypto.randomUUID(), crypto.randomUUID()], fence: () => fenced++ === 0 });
    const source = sourceOf({ [ROOT]: { steps: [step("s1", Date.UTC(2026, 9, 11, 16))], title: null, parentId: null, problems: [] } });
    await observeConversation({ usage, source, ref: ref(ROOT), rootOf: (id) => id });
    usage.start();
    await until(() => backend.batches().length >= 2);
    await usage.stop();
    const [first, second] = backend.batches();
    expect(backend.hits("POST", "/dashboard/token-usage/stream")).toHaveLength(2);
    expect(second?.generation).not.toBe(first?.generation ?? "");
    expect(second?.snapshots.map((s) => s.sessionId)).toEqual([ROOT]);
  });

  test("titles wait while the SDK refuses the title source, and go out once it accepts it", async () => {
    const t = Date.UTC(2026, 9, 11, 17);
    const read = { steps: [step("s1", t)], title: { text: "Fix the flaky login test", at: t }, parentId: null, problems: [] };
    const held = setup();
    await observeConversation({ usage: held.usage, source: sourceOf({ [ROOT]: read }), ref: ref(ROOT), rootOf: (id) => id });
    held.usage.start();
    await until(() => held.backend.batches().length > 0);
    await held.usage.stop();
    expect(held.backend.batches().flatMap((b) => b.sessions ?? [])).toEqual([]);


    // With an SDK that accepts the source, the title rides in `sessions` with the antigravity source.
    const batches: UsageBatch[] = [];
    const accepting: UsageClient = {
      titles: true,
      initialize: async () => ({ ok: true, value: { generation: "0b9f6c56-3d0e-4c4e-9c55-2f1f4c6b8a10" } }),
      send: async (b) => (batches.push(b), { ok: true, value: null }),
      reportRun: async () => ({ ok: true, value: { historyCompleted: false } }),
      recordLatency: async () => ({ ok: true, value: null }),
    };
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const usage = createUsagePump({ dataDir: tmp.dir, uploads: uploads(() => login("http://127.0.0.1:9")), log: quietLog }, { intervalMs: 60_000, persistDelayMs: 10, client: async () => accepting });
    await observeConversation({ usage, source: sourceOf({ [ROOT]: read }), ref: ref(ROOT), rootOf: (id) => id });
    usage.start();
    await until(() => batches.some((b) => b.sessions.length > 0));
    await usage.stop();
    expect(batches.flatMap((b) => b.sessions)).toEqual([{ sessionId: ROOT, title: "Fix the flaky login test", titleSource: "antigravity-session-title", titleUpdatedAt: new Date(t).toISOString() }]);
  });

  test("the usage dir follows the PRD layout", async () => {
    const { tmp, usage, backend } = setup();
    await observeConversation({ usage, source: sourceOf({ [ROOT]: { steps: [step("s1", Date.now())], title: null, parentId: null, problems: [] } }), ref: ref(ROOT), rootOf: (id) => id });
    usage.start();
    await until(() => backend.batches().length > 0);
    await usage.stop();
    const dir = scopeDir(tmp.dir, login(backend.url));
    expect(path.relative(tmp.dir, dir)).toMatch(/^usage\/[0-9a-f]{32}$/);
    expect(readdirSync(dir).sort()).toEqual(expect.arrayContaining(["queue", "sessions", "stream.json"]));
  });
});
