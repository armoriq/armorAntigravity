// Runs the evidence plugin against a real backend with a real saved login, feeding it one turn of
// daemon events, then shuts it down the way the daemon does. Until the daemon (#12) and the
// transcript reader (#5) land, the hook payloads and token counts below stand in for Antigravity's.
//
//   HOME=<sandbox> ARMORIQ_BACKEND_URL=http://localhost:3000 bun packages/evidence/scripts/drive.ts
import { loadLoginContext } from "@armoriq/sdk-dev/dist/credentials.js";
import { clientHeaders } from "@armoriq/sdk-dev";
import type { AuditRow } from "@armorantigravity/core";
import type { HookPayload } from "@armorantigravity/protocol";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { evidencePlugin, type EvidenceRecorder, type UsageSource } from "../src/index.ts";

const backend = (process.env.ARMORIQ_BACKEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const profile = loadLoginContext({ backend, product: "armorantigravity" })?.profile;
if (!profile) throw new Error(`no armorantigravity login for ${backend}; run the SDK login with --product armorantigravity`);
const armoriq = path.join(homedir(), ".armoriq");
const login = {
  backend,
  apiKey: profile.apiKey,
  userId: profile.userId,
  orgId: profile.orgId,
  email: profile.email,
  deviceId: readFileSync(path.join(armoriq, "device-id"), "utf8").trim(),
  deviceName: hostname(),
};
const client = { product: "armorantigravity", version: "0.1.0" };
const log = {
  info: (m: string, e?: object) => console.log("info", m, e ?? ""),
  warn: (m: string, e?: object) => console.log("warn", m, e ?? ""),
  error: (m: string, e?: object) => console.log("error", m, e ?? ""),
};

const conversationId = process.argv[2] ?? randomUUID();
const t0 = Date.now() - 20_000;
const source: UsageSource = {
  read: async () => ({
    steps: [
      { key: "step-1", model: "gemini-3.1-pro-high", at: t0 + 3_000, inputTokens: 18_204, outputTokens: 912, cacheReadTokens: 12_000, cacheWriteTokens: 0, reasoningTokens: 340 },
      { key: "step-3", model: "gemini-3.1-pro-high", at: t0 + 9_000, inputTokens: 19_870, outputTokens: 455, cacheReadTokens: 17_500, cacheWriteTokens: 0, reasoningTokens: 120 },
    ],
    title: { text: "Fix the flaky login test", at: t0 + 1_000 },
    parentId: null,
    problems: [],
  }),
  list: async () => [],
};

let recorder: EvidenceRecorder | null = null;
const plugin = evidencePlugin({ source, onRecorder: (r) => (recorder = r) });
const reg = plugin.setup({
  log,
  paths: { dataDir: path.join(armoriq, "armorantigravity") },
  auth: { client, headers: clientHeaders(client), uploadLogin: () => login, reportStatus: (s, b) => s >= 400 && log.warn("reported", { s, b }) },
});
const rec = (): EvidenceRecorder => {
  if (!recorder) throw new Error("recorder not registered");
  return recorder;
};

const session = { surface: "cli" as const, conversationId };
const base = { conversationId, workspacePaths: [process.cwd()], transcriptPath: path.join(homedir(), `.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs/transcript.jsonl`) };
const hook = (payload: HookPayload, at: number) => reg.observe({ kind: "hook", hook: { receivedAt: at, payload, session }, at });
const row = (over: Pick<AuditRow, "action" | "tool" | "input" | "status" | "executed_at"> & Partial<AuditRow>): AuditRow => ({
  session_id: conversationId,
  user_id: login.userId,
  user_email: login.email,
  step_index: -1,
  ...over,
});

reg.observe({ kind: "turn_start", session, at: t0 });

const run = { name: "run_command", args: { CommandLine: "bun test packages/evidence", Cwd: process.cwd() } };
hook({ ...base, event: "PreToolUse", toolCall: run, stepIdx: 2 }, t0 + 4_000);
rec().decided({ conversationId, stepIdx: 2, tool: run.name, args: run.args, mcpServer: null, decision: { kind: "allow", stepIndex: null, paramMismatch: false }, at: t0 + 4_001 });
hook({ ...base, event: "PostToolUse", toolCall: run, stepIdx: 2 }, t0 + 6_350);
rec().audit(
  row({ action: run.name, tool: run.name, input: run.args, output: { title: run.name, output: "60 pass" }, status: "success", duration_ms: 2_350, executed_at: new Date(t0 + 4_000).toISOString() }),
  { surface: "cli" },
);

const mcp = { name: "call_mcp_tool", args: { ServerName: "github", ToolName: "list_issues", Arguments: { repo: "armoriq/armorAntigravity" } } };
hook({ ...base, event: "PreToolUse", toolCall: mcp, stepIdx: 4 }, t0 + 10_000);
rec().decided({ conversationId, stepIdx: 4, tool: mcp.name, args: mcp.args, mcpServer: "github", decision: { kind: "allow", stepIndex: null, paramMismatch: false }, at: t0 + 10_001 });
hook({ ...base, event: "PostToolUse", toolCall: mcp, stepIdx: 4 }, t0 + 10_820);

const write = { name: "write_to_file", args: { TargetFile: "/etc/hosts", CodeContent: "127.0.0.1 example" } };
hook({ ...base, event: "PreToolUse", toolCall: write, stepIdx: 5 }, t0 + 12_000);
const reason = "write_to_file not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.";
rec().decided({ conversationId, stepIdx: 5, tool: write.name, args: write.args, mcpServer: null, decision: { kind: "deny", code: "intent_drift", reason, ruleId: null }, at: t0 + 12_001 });
rec().audit(
  row({ action: write.name, tool: write.name, input: write.args, status: "blocked", error_message: `intent_drift: ${reason}`, executed_at: new Date(t0 + 12_001).toISOString() }),
  { surface: "cli" },
);

reg.observe({ kind: "turn_end", session, at: t0 + 14_000 });
await Bun.sleep(4_000);
for (const pump of reg.pumps) await pump.stop();
console.log("conversationId", conversationId);
