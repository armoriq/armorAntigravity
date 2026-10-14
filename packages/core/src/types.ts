// Shared contract for every module, vendored from armorOpenCode src/types.ts.

export type SessionID = string & { readonly __brand: "SessionID" };
export type Mode = "enforce" | "monitor";

export type ToolCall = {
  sessionId: SessionID;
  callId: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
};

export type DenyCode =
  | "policy_forbid"
  | "builtin_protected"
  | "intent_plan_missing"
  | "intent_drift"
  | "intent_token_expired"
  | "backend_denied_tool"
  | "account_revoked"
  | "billing_blocked"
  | "own_tool_shadowed"
  | "internal_error";

export type Decision =
  | { kind: "allow"; stepIndex: number | null; paramMismatch: boolean }
  | { kind: "deny"; code: DenyCode; reason: string; ruleId: string | null }
  | { kind: "hold"; ruleId: string | null; reason: string };

export type PlanStep = {
  action: string;
  tool: string;
  params?: Readonly<Record<string, unknown>>;
};

export type Plan = {
  id: string;
  hash: string;
  goal: string;
  steps: readonly PlanStep[];
  revision: number;
  registeredInMessage: string;
};

export type Token =
  | {
      status: "active";
      jwt: string;
      expiresAt: number;
      deniedTools: ReadonlySet<string>;
      heldTools: ReadonlySet<string>;
    }
  | { status: "refused"; code: "account_revoked" | "billing_blocked" };

export type Session = {
  id: SessionID;
  parentId: SessionID | null;
  mode: Mode;
  plan: Plan | null;
  token: Token | null;
  stepCursor: number;
  revisionsThisMessage: number;
  currentMessageId: string | null;
};

export type PolicyEffect = "permit" | "forbid" | "require_approval";

export type CompiledPolicy = {
  hash: string;
  intentRequired: boolean;
  evaluate(call: ToolCall): { effect: PolicyEffect; ruleId: string | null; reason: string };
};

export type AuditStatus = "success" | "failed" | "error" | "blocked" | "held";

export type AuditRow = {
  // Backend CreateAuditLogDto dedupe key (UUID); armorOpenCode does not send it yet.
  client_row_id?: string;
  plan_id?: string;
  session_id: string;
  agent_id?: string;
  user_id?: string;
  user_email?: string;
  client_id?: string;
  step_index: number;
  action: string;
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: AuditStatus;
  error_message?: string;
  duration_ms?: number;
  executed_at: string;
};

export type BatchAck = {
  written: number;
  failures: readonly { index: number; error: string }[];
};

export type Login = {
  backend: string;
  apiKey: string;
  userId: string;
  orgId: string;
  email: string;
  deviceId: string;
  deviceName: string;
};

export type TokenUsageEntry = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type StepUsage = {
  sessionId: SessionID;
  messageId: string;
  partId: string;
  at: number;
  repo: string;
  entry: TokenUsageEntry;
  reasoningTokens: number;
};

export type TurnEvent =
  | { kind: "prompt"; sessionId: SessionID; text: string; at: number }
  | { kind: "decision"; call: ToolCall; decision: Decision; at: number }
  | { kind: "result"; call: ToolCall; status: AuditStatus; output: string; at: number }
  | { kind: "model"; step: StepUsage; at: number }
  | { kind: "turn_end"; sessionId: SessionID; at: number };

export interface Log {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface Pump {
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}
