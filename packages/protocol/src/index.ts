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
  | (BasePayload & { readonly event: "PreInvocation" | "PostInvocation" | "Stop" });

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
