// Shared contract for every module. See docs/architecture.md, section 4.

import type { Capability } from "./core/capability.ts";

export type SessionID = string & { readonly __brand: "SessionID" };
export type Mode = "enforce" | "monitor";

export type ToolCall = {
  sessionId: SessionID;
  callId: string;
  // V2 reuses an outer call id in code mode. Its stable attempt id also distinguishes nested calls.
  attemptId?: string;
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
  | "backend_unreachable"
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

export type PlanKind = "new" | "revision" | "refresh";

export type PendingPlanRequest = {
  key: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type PlanCaptureState = {
  promptId: string | null;
  promptGeneration: number;
  retirementEpoch: number;
  promptOpenSince: number | null;
  lastActivityAt: number | null;
  countedPlanId: string | null;
  tokenPlanId: string | null;
  planHash: string | null;
  kind: PlanKind | null;
  tokenExpiresAt: number | null;
  authGeneration: number;
  pendingRequest: PendingPlanRequest | null;
  unregisteredLocalPlan: Omit<Plan, "id"> | null;
  seenMessageIds: string[];
};

export type SessionGeneration = Pick<PlanCaptureState, "promptId" | "promptGeneration" | "authGeneration">;

export type Session = PlanCaptureState & {
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
export type DecisionCode = "policy_deny" | "protected_resource" | "missing_plan" | "out_of_scope" | "token_expired" | "plan_request_failed" | "integrity" | "account" | "approval_required" | "outage" | "internal_error" | "other";

export type AuditRow = {
  client_row_id?: string;
  plan_id?: string;
  context_plan_id?: string;
  prompt_id?: string;
  decision_code?: DecisionCode;
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
  capability?: Capability;
  // Set in workspace Monitor on a call that ran although Block would have stopped it.
  would_be?: "block" | "hold";
  would_be_code?: string;
  would_be_reason?: string;
};

export type BatchAck = {
  written: number;
  failures: readonly { index: number; error: string }[];
  results?: readonly { client_row_id: string; outcome: "accepted" | "duplicate" | "retryable" | "rejected"; error?: string }[];
  retryAfterMs?: number;
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

// One model step's token counts as the host reported them, before normalization.
export type StepTokens = {
  sessionId: SessionID;
  messageId: string;
  partId: string;
  repo: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
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
