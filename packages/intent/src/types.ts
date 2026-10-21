import type { Surface } from "@armorantigravity/protocol";

export type Mode = "enforce" | "monitor";

// Plans are keyed by surface plus conversationId, so the app, the IDE and the CLI never share one
// even if two of them report the same conversationId.
export type ConversationKey = string & { readonly __brand: "ConversationKey" };

export interface ConversationRef {
  readonly surface: Surface;
  readonly conversationId: string;
}

export const conversationKey = (ref: ConversationRef): ConversationKey => `${ref.surface}:${ref.conversationId}` as ConversationKey;

export interface PlanStep {
  readonly action: string;
  readonly tool: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface Plan {
  readonly id: string;
  readonly hash: string;
  readonly goal: string;
  readonly steps: readonly PlanStep[];
  readonly revision: number;
  readonly registeredInMessage: string;
}

export type Draft = Omit<Plan, "id">;

export type Token =
  | {
      readonly status: "active";
      readonly jwt: string;
      readonly expiresAt: number;
      readonly deniedTools: ReadonlySet<string>;
      readonly heldTools: ReadonlySet<string>;
    }
  | { readonly status: "refused"; readonly code: "account_revoked" | "billing_blocked" };

export interface Login {
  readonly backend: string;
  readonly apiKey: string;
  readonly userId: string;
}

export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string; readonly relogin?: true };

export interface Minted {
  readonly planId: string;
  readonly token: Token;
}

export interface DelegateRequest {
  readonly delegatePublicKey: string;
  readonly subtreePath: string;
  readonly validitySeconds?: number;
  readonly targetAgent?: string;
}

export interface Delegation {
  readonly trustId: string | null;
  readonly subtreeRoot: string;
  readonly inclusionProofLength: number;
}

export interface IntentBackend {
  mint(login: Login, plan: Draft, contextId: string): Promise<CallResult<Minted>>;
  reanchor(login: Login, planId: string, plan: Draft, reason: string): Promise<CallResult<{ readonly trustId: string | null }>>;
  revoke(login: Login, planId: string, reason: string): Promise<CallResult<void>>;
  delegate(login: Login, planId: string, request: DelegateRequest): Promise<CallResult<Delegation>>;
}

export type PolicyEffect = "permit" | "forbid" | "require_approval";

export interface PolicyVerdict {
  readonly effect: PolicyEffect;
  readonly ruleId: string | null;
  readonly reason: string;
}

// The slice of the compiled policy (packages/core) this package reads.
export interface PolicyView {
  readonly hash: string;
  readonly intentRequired: boolean;
  evaluate(tool: string, args: Readonly<Record<string, unknown>>): PolicyVerdict;
}

export type AuditStatus = "success" | "failed" | "error" | "blocked" | "held";

export interface AuditRow {
  readonly plan_id?: string;
  readonly session_id: string;
  readonly agent_id?: string;
  readonly client_id?: string;
  readonly user_id?: string;
  readonly step_index: number;
  readonly action: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly status: AuditStatus;
  readonly error_message?: string;
  readonly executed_at: string;
}

export interface Log {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export const AGENT_ID = "antigravity";
export const CLIENT_ID = "armorantigravity";
