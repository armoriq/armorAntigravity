// Replays one captured agy conversation through the evidence plugin against a real backend with a
// real saved login, then shuts it down the way the daemon does. The hooks come from a capture in
// the P0 spike's format (spike/payloads/cli/*.jsonl), and token counts, titles and subagent links
// come from the agy data dir through the transcript reader. Captures carry no timestamps, so each
// hook is timed from its step's created_at in the transcript.
//
//   HOME=<sandbox> ARMORIQ_BACKEND_URL=http://localhost:3000 \
//     bun packages/evidence/scripts/drive.ts <capture.jsonl> <agy data dir>
import { loadLoginContext } from "@armoriq/sdk-dev/dist/credentials.js";
import { clientHeaders } from "@armoriq/sdk-dev";
import { toAuditRow, type Decision, type Session, type SessionID } from "@armorantigravity/core";
import type { HookPayload } from "@armorantigravity/protocol";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createTranscriptSource, evidencePlugin, transcriptPathOf, type EvidenceRecorder } from "../src/index.ts";
import { isRecord } from "../src/io/http.ts";

const [capturePath, dataDir] = process.argv.slice(2);
if (!capturePath || !dataDir) throw new Error("usage: drive.ts <capture.jsonl> <agy data dir>");

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

type Captured = { event: string; action: string; payload: HookPayload };
const captured: Captured[] = readFileSync(capturePath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .flatMap((l): Captured[] => {
    const r: unknown = JSON.parse(l);
    // Every hook fired once per registration; the global one is enough.
    if (!isRecord(r) || r.source !== "global" || typeof r.event !== "string" || !isRecord(r.stdin)) return [];
    const stdin = r.stdin;
    if (typeof stdin.conversationId !== "string" || typeof stdin.transcriptPath !== "string" || !Array.isArray(stdin.workspacePaths)) return [];
    const base = {
      conversationId: stdin.conversationId,
      transcriptPath: stdin.transcriptPath,
      workspacePaths: stdin.workspacePaths.filter((p): p is string => typeof p === "string"),
      ...(typeof stdin.modelName === "string" ? { modelName: stdin.modelName } : {}),
    };
    const action = typeof r.action === "string" ? r.action : "";
    const call = isRecord(stdin.toolCall) && typeof stdin.toolCall.name === "string" ? { name: stdin.toolCall.name, args: stdin.toolCall.args } : null;
    const stepIdx = typeof stdin.stepIdx === "number" ? stdin.stepIdx : null;
    if ((r.event === "PreToolUse" || r.event === "PostToolUse") && call && stepIdx !== null) {
      const payload: HookPayload =
        r.event === "PreToolUse"
          ? { ...base, event: "PreToolUse", toolCall: call, stepIdx }
          : { ...base, event: "PostToolUse", toolCall: call, stepIdx, ...(typeof stdin.error === "string" ? { error: stdin.error } : {}) };
      return [{ event: r.event, action, payload }];
    }
    if (r.event === "PreInvocation" || r.event === "PostInvocation" || r.event === "Stop") return [{ event: r.event, action, payload: { ...base, event: r.event } }];
    return [];
  });
const first = captured[0];
if (!first) throw new Error(`no global hooks in ${capturePath}`);
const conversationId = first.payload.conversationId;

const stepTimes = new Map<number, number>();
for (const line of readFileSync(transcriptPathOf(dataDir, conversationId), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const s: unknown = JSON.parse(line);
  if (isRecord(s) && typeof s.step_index === "number" && typeof s.created_at === "string") stepTimes.set(s.step_index, Date.parse(s.created_at));
}
const timeOf = (step: number) => stepTimes.get(step) ?? stepTimes.get(step - 1) ?? 0;

let recorder: EvidenceRecorder | null = null;
const plugin = evidencePlugin({ source: createTranscriptSource({ dataDir }), onRecorder: (r) => (recorder = r) });
const reg = plugin.setup({
  log,
  paths: { dataDir: path.join(armoriq, "armorantigravity") },
  auth: { client, headers: clientHeaders(client), uploadLogin: () => login, reportStatus: (s, b) => s >= 400 && log.warn("reported", { s, b }) },
});
const rec = (): EvidenceRecorder => {
  if (!recorder) throw new Error("recorder not registered");
  return recorder;
};

// The adapter builds these in the daemon; here every captured call was allowed, as in the capture.
const core: Session = { id: conversationId as SessionID, parentId: null, mode: "enforce", plan: null, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: null };
const allow: Decision = { kind: "allow", stepIndex: null, paramMismatch: false };
const session = { surface: "cli" as const, conversationId };
const mcpServerOf = (args: unknown) => (isRecord(args) && typeof args.ServerName === "string" ? args.ServerName : null);

let at = timeOf(0);
const pre = new Map<number, number>();
reg.observe({ kind: "turn_start", session, at });
for (const { event, payload } of captured) {
  if (payload.event === "PreToolUse") {
    at = timeOf(payload.stepIdx - 1);
    pre.set(payload.stepIdx, at);
    reg.observe({ kind: "hook", hook: { receivedAt: at, payload, session }, at });
    const { name, args } = payload.toolCall;
    rec().decided({ conversationId, stepIdx: payload.stepIdx, tool: name, args, mcpServer: mcpServerOf(args), decision: allow, at: at + 1 });
  } else if (payload.event === "PostToolUse") {
    at = timeOf(payload.stepIdx);
    reg.observe({ kind: "hook", hook: { receivedAt: at, payload, session }, at });
    const begun = pre.get(payload.stepIdx) ?? at;
    const { name, args } = payload.toolCall;
    rec().audit(
      toAuditRow(
        {
          call: { sessionId: core.id, callId: `${conversationId}:${payload.stepIdx}`, tool: name, args: isRecord(args) ? args : {} },
          session: core,
          root: core,
          status: payload.error ? "failed" : "success",
          decision: allow,
          output: "",
          error: payload.error || null,
          durationMs: at - begun,
          at,
          userId: login.userId,
          userEmail: login.email,
        },
        { slug: "armorantigravity", agentId: "antigravity", childSessionKey: "_antigravity_session" },
      ),
      { surface: "cli" },
    );
  } else if (event === "Stop") {
    at = Math.max(...stepTimes.values());
    reg.observe({ kind: "turn_end", session, at });
  }
}

await Bun.sleep(4_000);
for (const pump of reg.pumps) await pump.stop();
console.log("conversationId", conversationId, "hooks", captured.length);
