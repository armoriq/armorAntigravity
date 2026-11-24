// Shared contract between agd-hook, the daemon and the adapter.
// Payload fields are from real agy 1.3.3 captures; see spike/FINDINGS.md.

export type HookEvent = "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop";

export type Surface = "app" | "cli" | "ide" | "unknown";

export interface ToolCall {
  readonly name: string;
  readonly args: unknown;
}

// Antigravity does not put the event name in stdin; agd-hook adds it from argv.
interface BasePayload {
  readonly conversationId: string;
  readonly workspacePaths: readonly string[];
  readonly transcriptPath: string;
  readonly artifactDirectoryPath: string;
  readonly modelName: string;
}

export type HookPayload =
  | (BasePayload & { readonly event: "PreToolUse"; readonly toolCall: ToolCall; readonly stepIdx: number })
  | (BasePayload & { readonly event: "PostToolUse"; readonly toolCall: ToolCall; readonly stepIdx: number; readonly error: string })
  | (BasePayload & {
      readonly event: "PreInvocation" | "PostInvocation";
      readonly invocationNum: number;
      readonly initialNumSteps: number;
    })
  | (BasePayload & {
      readonly event: "Stop";
      readonly executionNum: number;
      readonly fullyIdle: boolean;
      readonly terminationReason: string;
      readonly error: string;
    });

export const MCP_TOOL_NAME = "call_mcp_tool";

export interface McpToolArgs {
  readonly ServerName: string;
  readonly ToolName: string;
  readonly Arguments: unknown;
}

// Starts both kinds of subagent; args.Subagents[].TypeName is "self" or "browser".
export const SUBAGENT_TOOL_NAME = "invoke_subagent";

export const CONVERSATION_ID_ENV = "ANTIGRAVITY_CONVERSATION_ID";

export type ToolDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny" | "ask" | "force_ask"; readonly reason: string };

export type InjectedStep =
  | { readonly type: "userMessage" | "ephemeralMessage"; readonly text: string }
  | { readonly type: "toolCall"; readonly toolCall: ToolCall };

// null means agd-hook prints nothing. For PreToolUse that is the only neutral answer:
// Antigravity treats `{}` there as a deny with an empty reason.
export type HookResponse =
  | ToolDecision
  | { readonly injectSteps: readonly InjectedStep[] }
  | { readonly decision: "continue"; readonly reason: string }
  | null;

export const HOOK_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}

// Unix socket framing: one JSON object per line, request then response.
export const PROTOCOL_VERSION = 1;

// The hook client forwards stdin untouched; the daemon parses it with parseHookPayload,
// so the client stays free of validation logic and can be rewritten in another language.
export interface DaemonRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly receivedAt: number;
  readonly event: HookEvent;
  readonly payload: unknown;
}

export type AuditIdentity = { readonly rowId: string; readonly sessionId?: string };

export interface DaemonResponse {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly response: HookResponse;
}

// The hook client's frame, one line: tag, event, the millisecond clock reading the hook took, then the
// payload exactly as Antigravity wrote it on stdin. Text rather than JSON so a client with no JSON writer
// can build it, and so a payload that is not JSON at all still arrives with its event attached.
export const HOOK_FRAME_TAG = "agd1";

export interface HookFrame {
  readonly event: HookEvent;
  readonly receivedAt: number;
  readonly payload: unknown;
}

export function parseHookFrame(line: string): HookFrame | null {
  if (!line.startsWith(`${HOOK_FRAME_TAG} `)) return null;
  const eventEnd = line.indexOf(" ", HOOK_FRAME_TAG.length + 1);
  if (eventEnd < 0) return null;
  const event = line.slice(HOOK_FRAME_TAG.length + 1, eventEnd);
  if (!isHookEvent(event)) return null;
  const clockEnd = line.indexOf(" ", eventEnd + 1);
  if (clockEnd < 0) return null;
  const receivedAt = Number(line.slice(eventEnd + 1, clockEnd));
  const body = line.slice(clockEnd + 1);
  let payload: unknown = null;
  try {
    payload = body === "" ? null : JSON.parse(body);
  } catch {}
  return { event, receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Date.now(), payload };
}

// The contents of a pre-rendered fallback file: the bytes the hook writes to stdout. Empty for the
// null response, which is the only thing Antigravity may not see printed.
export function hookResponseLine(response: HookResponse): string {
  return response === null ? "" : `${JSON.stringify(response)}\n`;
}

// The reply to a frame. It repeats the tag so the hook can tell this daemon's answer from any other
// line the socket might carry, such as the id envelope an older daemon replies with. A reply without
// the tag is not printed, it falls back.
export function hookReplyLine(response: HookResponse): string {
  return response === null ? `${HOOK_FRAME_TAG}\n` : `${HOOK_FRAME_TAG} ${JSON.stringify(response)}\n`;
}

export const SOCKET_PATH_ENV = "ARMORANTIGRAVITY_SOCKET";
export const DEFAULT_SOCKET_PATH = "~/.armoriq/armorantigravity/agd.sock";

// The intent MCP server's request on the same socket. MCP calls carry no conversation id, so the server asks
// for the outcome the PreToolUse hook already produced for the same tool and arguments.
export interface McpOutcomeRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly kind: "mcp_outcome";
  readonly tool: string;
  readonly args: unknown;
  readonly waitMs: number;
}

export interface McpOutcomeResponse {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly text: string | null;
}

// Written by the daemon next to its socket; read by the hook client only when the daemon is unreachable.
export const MODE_FILE_NAME = "mode";
export type Mode = "enforce" | "monitor";

// One file per event beside the mode file, holding the exact bytes the hook writes to stdout when it
// cannot reach the daemon. The daemon renders them because it owns the mode; the hook only copies bytes,
// which is what lets it be a program with no JSON writer. A missing or unreadable file fails closed.
export const FALLBACK_DIR_NAME = "fallback";
export const DAEMON_UNAVAILABLE_CODE = "daemon_unavailable";
export const DAEMON_UNAVAILABLE_REASON = "armoriq-agd is not running or did not answer";

export function parseHookPayload(event: HookEvent, raw: unknown): HookPayload | null {
  if (!isRecord(raw)) return null;
  const { conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName } = raw;
  if (typeof conversationId !== "string" || conversationId === "" || typeof transcriptPath !== "string") return null;
  if (typeof artifactDirectoryPath !== "string" || typeof modelName !== "string") return null;
  if (!Array.isArray(workspacePaths) || !workspacePaths.every((p) => typeof p === "string")) return null;
  const base: BasePayload = { conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName };
  if (event === "PreInvocation" || event === "PostInvocation") {
    const { invocationNum, initialNumSteps } = raw;
    if (!isInteger(invocationNum) || !isInteger(initialNumSteps)) return null;
    return { ...base, event, invocationNum, initialNumSteps };
  }
  if (event === "Stop") {
    const { executionNum, fullyIdle, terminationReason, error } = raw;
    if (!isInteger(executionNum) || typeof fullyIdle !== "boolean" || typeof terminationReason !== "string" || typeof error !== "string") return null;
    return { ...base, event, executionNum, fullyIdle, terminationReason, error };
  }
  const { toolCall, stepIdx, error } = raw;
  if (!isRecord(toolCall) || typeof toolCall.name !== "string" || !isInteger(stepIdx)) return null;
  const call: ToolCall = { name: toolCall.name, args: toolCall.args };
  if (event === "PreToolUse") return { ...base, event, toolCall: call, stepIdx };
  return typeof error === "string" ? { ...base, event, toolCall: call, stepIdx, error } : null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

const DECISIONS = ["allow", "deny", "ask", "force_ask"] as const;

// undefined means the response is malformed; null is the valid "print nothing" response.
export function parseHookResponse(raw: unknown): HookResponse | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  if ("decision" in raw) {
    if (raw.decision === "continue") return typeof raw.reason === "string" ? { decision: "continue", reason: raw.reason } : undefined;
    const decision = DECISIONS.find((d) => d === raw.decision);
    if (decision === "allow") return { decision };
    return decision && typeof raw.reason === "string" ? { decision, reason: raw.reason } : undefined;
  }
  if ("injectSteps" in raw) {
    if (!Array.isArray(raw.injectSteps)) return undefined;
    const steps: InjectedStep[] = [];
    for (const step of raw.injectSteps) {
      if (!isRecord(step)) return undefined;
      if ((step.type === "userMessage" || step.type === "ephemeralMessage") && typeof step.text === "string") steps.push({ type: step.type, text: step.text });
      else if (step.type === "toolCall" && isRecord(step.toolCall) && typeof step.toolCall.name === "string")
        steps.push({ type: "toolCall", toolCall: { name: step.toolCall.name, args: step.toolCall.args } });
      else return undefined;
    }
    return { injectSteps: steps };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The answer when no decision can be made: closed for tool calls in enforce mode, open otherwise.
// Shared so agd-hook (daemon unreachable) and the daemon (bad payload, handler error) agree.
export function fallbackResponse(event: HookEvent, mode: Mode, code: string, reason: string): HookResponse {
  if (event !== "PreToolUse") return null;
  if (mode === "monitor") return { decision: "allow" };
  return { decision: "deny", reason: `ArmorIQ blocked this call [${code}]: ${reason}` };
}
