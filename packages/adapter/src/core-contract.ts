// The slice of @armorantigravity/core's types (vendored from armorOpenCode
// src/types.ts) the adapter codes against. Copied byte for byte while core is
// in review (https://github.com/armoriq/armorAntigravity/pull/58); replace with
// re-exports from core once it merges. Structural typing keeps both
// interchangeable.

export type SessionID = string & { readonly __brand: "SessionID" };
export type Mode = "enforce" | "monitor";

export type CoreToolCall = {
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

export type PolicyEffect = "permit" | "forbid" | "require_approval";

export type CompiledPolicy = {
  hash: string;
  intentRequired: boolean;
  evaluate(call: CoreToolCall): { effect: PolicyEffect; ruleId: string | null; reason: string };
};

export type CompileResult = { ok: true; policy: CompiledPolicy } | { ok: false; error: string };

export type Login = {
  backend: string;
  apiKey: string;
  userId: string;
  orgId: string;
  email: string;
  deviceId: string;
  deviceName: string;
};

export interface Log {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}
