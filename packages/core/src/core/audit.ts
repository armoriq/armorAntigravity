import { createHash } from "node:crypto";
import type { AuditRow, AuditStatus, Decision, DecisionCode, Session, ToolCall } from "../types.ts";
import type { Capability } from "./capability.ts";
import { MAX_PARAM_CHARS, redactText, sanitizeParams } from "./sanitize.ts";

export type AuditInput = {
  call: ToolCall;
  session?: Session;
  root?: Session;
  status: AuditStatus;
  decision: Decision | null;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  at: number;
  userId?: string;
  userEmail?: string;
  capability?: Capability;
  snapshot?: AuditSnapshot;
};

export const DECISION_CODES = {
  policy_forbid: "policy_deny", backend_denied_tool: "policy_deny",
  builtin_protected: "protected_resource", own_tool_shadowed: "protected_resource",
  intent_plan_missing: "missing_plan", intent_drift: "out_of_scope", intent_token_expired: "token_expired",
  account_revoked: "account", billing_blocked: "account", hold: "approval_required",
  backend_unreachable: "outage", internal_error: "internal_error",
} as const satisfies Record<string, DecisionCode>;

const ROW_NAMESPACE = Buffer.from("38e3839fd44e5317b41fb2738b0a247a", "hex");

export function clientRowId(rootSessionId: string, callId: string, phase: "decision" | "result"): string {
  const bytes = createHash("sha1").update(ROW_NAMESPACE).update(`${rootSessionId}:${callId}:${phase}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AuditSnapshot = {
  sessionId: string;
  rootSessionId: string;
  planId?: string;
  contextPlanId?: string;
  promptId?: string;
  step: { index: number; action: string } | null;
  enforcing: boolean;
};

export function snapshotAuditContext(session: Session, root: Session, decision: Decision | null): AuditSnapshot {
  const planId = isPlanless(decision) ? undefined : root.tokenPlanId || root.plan?.id || undefined;
  const context = root.countedPlanId || root.plan?.id;
  const index = decision?.kind === "allow" ? decision.stepIndex : null;
  const step = index === null ? undefined : root.plan?.steps[index];
  return {
    sessionId: session.id, rootSessionId: root.id,
    ...(planId ? { planId } : {}),
    ...(context && context !== planId ? { contextPlanId: context } : {}),
    ...(root.promptId ? { promptId: root.promptId } : {}),
    step: step && index !== null ? { index, action: step.action } : null,
    enforcing: session.mode === "enforce",
  };
}

// A guard failure keeps only fields that do not depend on parsing the tool payload.
export function fallbackAuditRow(clientId: string, sessionId: string | undefined, at: number, code: DecisionCode = "internal_error") {
  return {
    client_row_id: clientId,
    ...(sessionId ? { session_id: sessionId } : {}),
    tool: "unknown", action: "unknown", input: {}, executed_at: new Date(at).toISOString(),
    decision_code: code, status: "blocked" as const,
  };
}

export const AGENT_ID = "opencode";
export const CLIENT_ID = "armoropencode";
export const CHILD_SESSION_KEY = "_opencode_session";

const PLANLESS_CODES = new Set(["intent_drift", "intent_plan_missing"]);

// Redact before cutting so a secret straddling the limit is not left half-visible.
const clip = (text: string) => redactText(text.slice(0, MAX_PARAM_CHARS * 2)).slice(0, MAX_PARAM_CHARS);

function denialText(decision: Decision): string | undefined {
  if (decision.kind === "deny") return `${decision.code}: ${clip(decision.reason)}`.slice(0, MAX_PARAM_CHARS);
  if (decision.kind === "hold") return `approval_required: ${clip(decision.reason)}`.slice(0, MAX_PARAM_CHARS);
  return undefined;
}

export function toAuditRow(input: AuditInput): AuditRow {
  const { call, session, root, status } = input;
  const snapshot = input.snapshot ?? snapshotAuditContext(session!, root!, input.decision);
  const stopped = status === "blocked" || status === "held";
  const step = stopped ? null : snapshot.step;
  const params = sanitizeParams(call.args);
  // A subagent's rows carry the root session id; the child id rides along so the run stays traceable.
  const args = snapshot.sessionId === snapshot.rootSessionId ? params : { ...params, [CHILD_SESSION_KEY]: snapshot.sessionId };
  const row: AuditRow = {
    client_row_id: clientRowId(snapshot.rootSessionId, call.callId, stopped ? "decision" : "result"),
    session_id: snapshot.rootSessionId,
    agent_id: AGENT_ID,
    client_id: CLIENT_ID,
    step_index: step?.index ?? -1,
    action: step?.action ?? call.tool,
    tool: call.tool,
    input: args,
    status: stopped ? input.decision?.kind === "hold" ? "held" : "blocked" : status,
    executed_at: new Date(input.at - (input.durationMs ?? 0)).toISOString(),
  };
  if (stopped) row.decision_code = input.decision?.kind === "hold" ? "approval_required" : input.decision?.kind === "deny" ? DECISION_CODES[input.decision.code] : "other";
  return Object.assign(row, optionalFields(input, snapshot));
}

function optionalFields(input: AuditInput, snapshot: AuditSnapshot): Partial<AuditRow> {
  const out: Partial<AuditRow> = {};
  if (snapshot.planId) out.plan_id = snapshot.planId;
  if (snapshot.contextPlanId) out.context_plan_id = snapshot.contextPlanId;
  if (snapshot.promptId) out.prompt_id = snapshot.promptId;
  if (input.userId) out.user_id = input.userId;
  if (input.userEmail) out.user_email = input.userEmail;
  if (input.status === "success") out.output = { title: input.call.tool, output: clip(input.output ?? "") };
  const error = errorText(input);
  if (error) out.error_message = error;
  if (input.durationMs !== null) out.duration_ms = input.durationMs;
  if (input.capability) out.capability = input.capability;
  // A row for a call that ran with a stop decision comes from Monitor: Block would have stopped it.
  const d = input.decision;
  if (d && d.kind !== "allow" && input.status !== "blocked" && input.status !== "held") {
    out.would_be = d.kind === "hold" ? "hold" : "block";
    out.would_be_code = d.kind === "hold" ? "approval_required" : d.code;
    out.would_be_reason = clip(d.reason);
  }
  return out;
}

// Drift and plan missing rows withhold plan_id and retain the evaluated plan in context_plan_id.
const isPlanless = (decision: Decision | null) => decision?.kind === "deny" && PLANLESS_CODES.has(decision.code);

function errorText({ status, error, decision }: AuditInput): string | undefined {
  if (status === "success") return undefined;
  if ((status === "held" || status === "blocked") && decision) return denialText(decision);
  if (error !== null) return clip(error);
  return decision ? denialText(decision) : undefined;
}
