import type { HookPayload } from "@armorantigravity/protocol";
import { afterEach, expect, test } from "bun:test";
import type { UsageClient } from "../src/io/backend-usage.ts";
import { createEvidence } from "../src/plugin.ts";
import { createLatencyPump } from "../src/pumps/latency.ts";
import type { TraceEvent } from "../src/pumps/traces.ts";
import type { SourceStep, UsageSource } from "../src/usage/source.ts";
import { login, quietLog, tempDir, until, uploads } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const ROOT = "conv-root";
const CHILD = "conv-child";
const step = (key: string, at: number): SourceStep => ({ key, model: "gemini-3.8-flash", at, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
const session = (conversationId: string) => ({ surface: "cli" as const, conversationId });
const pre = (conversationId: string, stepIdx: number): HookPayload => ({ event: "PreToolUse", conversationId, stepIdx, toolCall: { name: "run_command", args: {} }, workspacePaths: ["/repo"], transcriptPath: `/brain/${conversationId}/transcript.jsonl`, artifactDirectoryPath: `/brain/${conversationId}`, modelName: "gemini-3.8-flash-high" });

// The trace and latency pumps are replaced by recorders, so the test sees exactly what the
// plugin hands them and in what order; nothing is started or sent.
function harness(steps: Record<string, SourceStep[]>, readDelayMs = 0) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const source: UsageSource = {
    read: async (ref) => (await Bun.sleep(readDelayMs), { steps: steps[ref.conversationId] ?? [], title: null, parentId: null, problems: [] }),
    list: async () => [],
  };
  const evidence = createEvidence({ dataDir: tmp.dir, uploads: uploads(() => null), log: quietLog }, { source, rootOf: (id) => (id === CHILD ? ROOT : id) });
  const traced: TraceEvent[] = [];
  const latency: string[] = [];
  evidence.pumps.traces.record = (e) => void traced.push(e);
  evidence.pumps.latency.turnStarted = (id, at) => void latency.push(`start ${id}@${at}`);
  evidence.pumps.latency.turnEnded = (id, at) => void latency.push(`end ${id}@${at}`);
  const shape = () => traced.map((e) => ("sessionId" in e ? `${e.kind} ${e.sessionId}` : `${e.kind} ${e.call.sessionId}`) + (e.kind === "model" ? ` [${e.calls.map((c) => c.key).join(",")}]` : ""));
  return { evidence, traced, latency, shape };
}

test("a turn end that waits on the source still lands before the next turn's start and decisions", async () => {
  const { evidence, shape } = harness({ [ROOT]: [step("s1", 50)] }, 50);
  const { observe, recorder } = evidence;
  observe({ kind: "turn_start", session: session(ROOT), at: 1 });
  observe({ kind: "hook", hook: { receivedAt: 2, payload: pre(ROOT, 1), session: session(ROOT) }, at: 2 });
  observe({ kind: "turn_end", session: session(ROOT), at: 100 });
  observe({ kind: "turn_start", session: session(ROOT), at: 110 });
  recorder.decided({ conversationId: ROOT, stepIdx: 2, tool: "run_command", args: {}, mcpServer: null, decision: { kind: "allow", stepIndex: null, paramMismatch: false }, at: 120 });
  await evidence.settle(2_000);
  expect(shape()).toEqual([`turn_start ${ROOT}`, `model ${ROOT} [${ROOT}:s1]`, `turn_end ${ROOT}`, `turn_start ${ROOT}`, `decision ${ROOT}`]);
});

test("a subagent's turn joins the root's trace and does not end the root's turn or latency sample", async () => {
  const { evidence, shape, latency } = harness({ [CHILD]: [step("c1", 15)], [ROOT]: [step("r1", 90)] });
  const { observe } = evidence;
  observe({ kind: "turn_start", session: session(ROOT), at: 0 });
  observe({ kind: "hook", hook: { receivedAt: 1, payload: pre(ROOT, 1), session: session(ROOT) }, at: 1 });
  observe({ kind: "turn_start", session: session(CHILD), at: 10 });
  observe({ kind: "hook", hook: { receivedAt: 11, payload: pre(CHILD, 1), session: session(CHILD) }, at: 11 });
  observe({ kind: "turn_end", session: session(CHILD), at: 20 });
  observe({ kind: "turn_end", session: session(ROOT), at: 100 });
  await evidence.settle(2_000);
  expect(shape()).toEqual([`turn_start ${ROOT}`, `model ${ROOT} [${CHILD}:c1]`, `model ${ROOT} [${ROOT}:r1]`, `turn_end ${ROOT}`]);
  expect(latency).toEqual([`start ${ROOT}@0`, `end ${ROOT}@100`]);
});

test("steps from before the turn started, as after a daemon restart, are not re-emitted as this turn's spans", async () => {
  const { evidence, shape } = harness({ [ROOT]: [step("old-1", 1_000), step("old-2", 2_000), step("new", 5_005)] });
  const { observe } = evidence;
  observe({ kind: "turn_start", session: session(ROOT), at: 5_000 });
  observe({ kind: "hook", hook: { receivedAt: 5_001, payload: pre(ROOT, 1), session: session(ROOT) }, at: 5_001 });
  observe({ kind: "turn_end", session: session(ROOT), at: 6_000 });
  await evidence.settle(2_000);
  expect(shape()).toEqual([`turn_start ${ROOT}`, `model ${ROOT} [${ROOT}:new]`, `turn_end ${ROOT}`]);
});

test("a session that ends without a turn end closes its open trace turn", async () => {
  const { evidence, shape } = harness({});
  evidence.observe({ kind: "turn_start", session: session(ROOT), at: 0 });
  evidence.observe({ kind: "session_end", session: session(ROOT), at: 50 });
  await evidence.settle(2_000);
  expect(shape()).toEqual([`turn_start ${ROOT}`, `turn_end ${ROOT}`]);
});

test("latency a daemon could not send goes out from the next daemon's start", async () => {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const posted: string[] = [];
  let up = false;
  const client: UsageClient = {
    titles: false,
    initialize: async () => ({ ok: true, value: { generation: "g" } }),
    send: async () => ({ ok: true, value: null }),
    reportRun: async () => ({ ok: true, value: { historyCompleted: false } }),
    recordLatency: async (p) => (up ? (posted.push(`${p.sessionId}:${p.sampleCount}`), { ok: true, value: null }) : { ok: false, retryable: true, reason: "backend down" }),
  };
  const usage = { client: async () => ({ client, dir: tmp.dir, login: login("http://127.0.0.1:9") }) };
  const deps = { dataDir: tmp.dir, uploads: uploads(() => null), log: quietLog, usage };
  const first = createLatencyPump(deps);
  first.turnStarted(ROOT, Date.UTC(2026, 9, 11, 10));
  first.turnEnded(ROOT, Date.UTC(2026, 9, 11, 10) + 4_000);
  first.kick();
  await first.stop();
  expect(posted).toEqual([]);

  up = true;
  const second = createLatencyPump(deps);
  second.start();
  await until(() => posted.length > 0);
  await second.stop();
  expect(posted).toEqual([`${ROOT}:1`]);
});
