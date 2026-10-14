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

// Unix socket framing: one JSON object per line, request then response.
export const PROTOCOL_VERSION = 1;

export interface DaemonRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly receivedAt: number;
  readonly payload: HookPayload;
}

export interface DaemonResponse {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly response: HookResponse;
}

export const SOCKET_PATH_ENV = "ARMORANTIGRAVITY_SOCKET";
export const DEFAULT_SOCKET_PATH = "~/.armoriq/armorantigravity/agd.sock";
