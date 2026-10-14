import { toAuditRow, type Decision, type Session, type SessionID } from "@armorantigravity/core";
import type { HookPayload } from "@armorantigravity/protocol";
import type { SpooledSpanBatch } from "@armoriq/sdk-dev";
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { evidencePlugin, type EvidenceRecorder, type ObservedEvent } from "../src/plugin.ts";
import type { UsageSource } from "../src/usage/source.ts";
import { login, quietLog, tempDir, until, uploads } from "./support.ts";
import { usageBackend } from "./usage-stub.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// Not a UUID on purpose: Antigravity's conversationId format is unknown (PRD 4).
const CONV = "agy_conv:2026-10-12/7f3a9c";

function spans(dataDir: string) {
  const dir = path.join(dataDir, "traces", "spool");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {}
  return names.flatMap((n) => (JSON.parse(readFileSync(path.join(dir, n), "utf8")) as SpooledSpanBatch).spans);
}

test("audit, usage, latency and traces all carry the raw conversationId as the session id", async () => {
  const backend = usageBackend({
    "POST /iap/audit/batch": (r) => ({ body: { written: 1, failures: [] as unknown[], rows: r.body } }),
    "GET /observability/policy/lease": () => ({ body: { captureMode: "metadata", revision: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }),
    "POST /v1/traces": () => ({ status: 503, body: {} }),
    "GET /api-keys/device-history-sync": () => ({ body: { requestId: null, requestedAt: null } }),
  });
  const tmp = tempDir();
  cleanups.push(backend.stop, tmp.cleanup);
  const up = uploads(() => login(backend.url));
  const t0 = Date.now() - 60_000;
  const source: UsageSource = {
    read: async () => ({
      steps: [{ key: "step-4", model: "gemini-3.8-flash-high", at: t0 + 2_000, inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 12 }],
      title: null,
      parentId: null,
      problems: [],
    }),
    list: async () => [],
  };
  let recorder: EvidenceRecorder | null = null;
  const registration = evidencePlugin({ source, onRecorder: (r) => (recorder = r) }).setup({
    log: quietLog,
    paths: { dataDir: tmp.dir },
    auth: { client: up.client, headers: up.headers, uploadLogin: up.login, reportStatus: (s, b) => up.report(s, b) },
  });

  const session = { surface: "cli" as const, conversationId: CONV };
  const base = { conversationId: CONV, workspacePaths: ["/Users/dev/repo"], transcriptPath: `/Users/dev/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript.jsonl` };
  const toolCall = { name: "run_command", args: { CommandLine: "bun test" } };
  const pre: HookPayload = { ...base, event: "PreToolUse", toolCall, stepIdx: 4 };
  const post: HookPayload = { ...base, event: "PostToolUse", toolCall, stepIdx: 4 };
  const events: ObservedEvent[] = [
    { kind: "turn_start", session, at: t0 },
    { kind: "hook", hook: { receivedAt: t0 + 100, payload: pre, session }, at: t0 + 100 },
  ];
  for (const e of events) registration.observe(e);

  const decision: Decision = { kind: "allow", stepIndex: null, paramMismatch: false };
  recorder!.decided({ conversationId: CONV, stepIdx: 4, tool: "run_command", args: toolCall.args, mcpServer: null, decision, at: t0 + 101 });
  registration.observe({ kind: "hook", hook: { receivedAt: t0 + 1_600, payload: post, session }, at: t0 + 1_600 });
  const core: Session = { id: CONV as SessionID, parentId: null, mode: "enforce", plan: null, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: null };
  recorder!.audit(
    toAuditRow({
      call: { sessionId: CONV as SessionID, callId: `${CONV}:4`, tool: "run_command", args: toolCall.args },
      session: core,
      root: core,
      status: "success",
      decision,
      output: "ok",
      error: null,
      durationMs: 1_500,
      at: t0 + 1_600,
      userId: "user-1",
      userEmail: "dev@example.com",
    }, { slug: "armorantigravity", agentId: "antigravity", childSessionKey: "_antigravity_session" }),
    { surface: "cli" },
  );
  registration.observe({ kind: "turn_end", session, at: t0 + 3_000 });

  await until(() => backend.hits("POST", "/iap/audit/batch").length > 0 && backend.batches().length > 0 && backend.hits("POST", "/dashboard/token-usage/latency").length > 0, 8_000);
  await until(() => spans(tmp.dir).some((s) => s.name === "armoriq.agent.run"), 8_000);
  for (const pump of registration.pumps) await pump.stop();

  const auditRow = (backend.hits("POST", "/iap/audit/batch")[0]?.body as { rows: Array<{ session_id: string; agent_id: string; client_id: string; client_row_id: string; input: Record<string, unknown> }> }).rows[0];
  const batch = backend.batches()[0];
  const latency = backend.hits("POST", "/dashboard/token-usage/latency")[0]?.body as { sessionId: string; product: string; sampleCount: number; totalMs: number };
  const traced = spans(tmp.dir);
  const root = traced.find((s) => s.name === "armoriq.agent.run");
  const tool = traced.find((s) => s.attributes["armoriq.tool.name"] === "run_command" && s.attributes["armoriq.policy.decision"] === undefined);

  expect(auditRow?.session_id).toBe(CONV);
  expect(auditRow).toMatchObject({ agent_id: "antigravity", client_id: "armorantigravity", user_id: "user-1", user_email: "dev@example.com", input: { _antigravity_surface: "cli" } });
  expect(batch?.snapshots[0]?.sessionId).toBe(CONV);
  expect(batch?.calls?.[0]?.sessionId).toBe(CONV);
  expect(latency).toMatchObject({ sessionId: CONV, product: "armorantigravity", sampleCount: 1, totalMs: 3_000 });
  expect(root?.attributes["armoriq.session_id"]).toBe(CONV);
  expect(tool?.attributes["armoriq.duration_ms"]).toBe(1_500);
  expect(traced.some((s) => s.name === "gen_ai.chat" && s.traceId === root?.traceId)).toBe(true);
});
