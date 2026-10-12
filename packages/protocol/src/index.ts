// Shared contract between agd-hook, the daemon and the adapter.
// Antigravity payload fields follow https://antigravity.google/docs/hooks/ and are
// unconfirmed until the P0 spike (#1) captures real payloads; adjust here first.

export type HookEvent = "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop";

export type Surface = "app" | "cli" | "ide" | "unknown";

export interface ToolCall {
  readonly name: string;
  readonly args: unknown;
}

interface BasePayload {
  readonly conversationId: string;
  readonly workspacePaths: readonly string[];
  readonly transcriptPath: string;
  readonly artifactDirectoryPath?: string;
  readonly modelName?: string;
}

export type HookPayload =
  | (BasePayload & { readonly event: "PreToolUse"; readonly toolCall: ToolCall; readonly stepIdx: number })
  | (BasePayload & { readonly event: "PostToolUse"; readonly toolCall: ToolCall; readonly stepIdx: number; readonly error?: string })
  // invocationNum counts model invocations within one user message and is 0 on the first (spike capture, agy CLI).
  | (BasePayload & { readonly event: "PreInvocation" | "PostInvocation"; readonly invocationNum?: number })
  | (BasePayload & { readonly event: "Stop" });

export type ToolDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny" | "ask" | "force_ask"; readonly reason: string };

export type InjectedStep =
  | { readonly type: "userMessage" | "ephemeralMessage"; readonly text: string }
  | { readonly type: "toolCall"; readonly toolCall: ToolCall };

export type HookResponse =
  | ToolDecision
  | { readonly injectSteps: readonly InjectedStep[] }
  | { readonly continue: boolean }
  | Record<string, never>;

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

export interface DaemonResponse {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly response: HookResponse;
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

export function parseHookPayload(event: HookEvent, raw: unknown): HookPayload | null {
  if (!isRecord(raw)) return null;
  const { conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName } = raw;
  if (typeof conversationId !== "string" || conversationId === "" || typeof transcriptPath !== "string") return null;
  if (!Array.isArray(workspacePaths) || !workspacePaths.every((p) => typeof p === "string")) return null;
  const base = {
    conversationId,
    workspacePaths,
    transcriptPath,
    ...(typeof artifactDirectoryPath === "string" ? { artifactDirectoryPath } : {}),
    ...(typeof modelName === "string" ? { modelName } : {}),
  };
  if (event !== "PreToolUse" && event !== "PostToolUse") return { ...base, event };
  const { toolCall, stepIdx, error } = raw;
  if (!isRecord(toolCall) || typeof toolCall.name !== "string" || typeof stepIdx !== "number" || !Number.isInteger(stepIdx)) return null;
  const call: ToolCall = { name: toolCall.name, args: toolCall.args };
  if (event === "PreToolUse") return { ...base, event, toolCall: call, stepIdx };
  return { ...base, event, toolCall: call, stepIdx, ...(typeof error === "string" ? { error } : {}) };
}

const DECISIONS = ["allow", "deny", "ask", "force_ask"] as const;

export function parseHookResponse(raw: unknown): HookResponse | null {
  if (!isRecord(raw)) return null;
  if ("decision" in raw) {
    const decision = DECISIONS.find((d) => d === raw.decision);
    if (decision === "allow") return { decision };
    return decision && typeof raw.reason === "string" ? { decision, reason: raw.reason } : null;
  }
  if ("continue" in raw) return typeof raw.continue === "boolean" ? { continue: raw.continue } : null;
  if ("injectSteps" in raw) {
    if (!Array.isArray(raw.injectSteps)) return null;
    const steps: InjectedStep[] = [];
    for (const step of raw.injectSteps) {
      if (!isRecord(step)) return null;
      if ((step.type === "userMessage" || step.type === "ephemeralMessage") && typeof step.text === "string") steps.push({ type: step.type, text: step.text });
      else if (step.type === "toolCall" && isRecord(step.toolCall) && typeof step.toolCall.name === "string")
        steps.push({ type: "toolCall", toolCall: { name: step.toolCall.name, args: step.toolCall.args } });
      else return null;
    }
    return { injectSteps: steps };
  }
  return Object.keys(raw).length === 0 ? {} : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The answer when no decision can be made: closed for tool calls in enforce mode, open otherwise.
// Shared so agd-hook (daemon unreachable) and the daemon (bad payload, handler error) agree.
export function fallbackResponse(event: HookEvent, mode: Mode, code: string, reason: string): HookResponse {
  if (event !== "PreToolUse") return {};
  if (mode === "monitor") return { decision: "allow" };
  return { decision: "deny", reason: `ArmorIQ blocked this call [${code}]: ${reason}` };
}
