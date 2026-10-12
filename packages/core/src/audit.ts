import type { ProductConfig } from "./product.ts";
import { MAX_PARAM_CHARS, redactText, sanitizeParams } from "./sanitize.ts";
import type { AuditRow, AuditStatus, Decision, Session, ToolCall } from "./types.ts";

export type AuditInput = {
  call: ToolCall;
  session: Session;
  root: Session;
  status: AuditStatus;
  decision: Decision | null;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  at: number;
  userId?: string | undefined;
  userEmail?: string | undefined;
};

export type AuditProduct = Pick<ProductConfig, "slug" | "agentId" | "childSessionKey">;

const PLANLESS_CODES = new Set(["intent_drift", "intent_plan_missing"]);

// Redact before cutting so a secret straddling the limit is not left half-visible.
const clip = (text: string) => redactText(text.slice(0, MAX_PARAM_CHARS * 2)).slice(0, MAX_PARAM_CHARS);

function denialText(decision: Decision): string | undefined {
  if (decision.kind === "deny") return clip(`${decision.code}: ${decision.reason}`);
  if (decision.kind === "hold") return clip(`approval_required: ${decision.reason}`);
  return undefined;
}

export function toAuditRow(input: AuditInput, product: AuditProduct): AuditRow {
  const { call, session, root, status } = input;
  const step = matchedStep(input);
  const params = sanitizeParams(call.args);
  // A subagent's rows carry the root session id; the child id rides along so the run stays traceable.
  const args = session.id === root.id ? params : { ...params, [product.childSessionKey]: session.id };
  const row: AuditRow = {
    session_id: root.id,
    agent_id: product.agentId,
    client_id: product.slug,
    step_index: step?.index ?? -1,
    action: step?.action ?? call.tool,
    tool: call.tool,
    input: args,
    status,
    executed_at: new Date(input.at - (input.durationMs ?? 0)).toISOString(),
  };
  return Object.assign(row, optionalFields(input));
}

function matchedStep({ status, decision, root }: AuditInput): { index: number; action: string } | null {
  if (status === "blocked" || status === "held" || decision?.kind !== "allow" || decision.stepIndex === null) return null;
  const step = root.plan?.steps[decision.stepIndex];
  return step ? { index: decision.stepIndex, action: step.action } : null;
}

function optionalFields(input: AuditInput): Partial<AuditRow> {
  const out: Partial<AuditRow> = {};
  const plan = input.root.plan;
  if (plan && !isPlanless(input.decision)) out.plan_id = plan.id;
  if (input.userId) out.user_id = input.userId;
  if (input.userEmail) out.user_email = input.userEmail;
  if (input.status === "success") out.output = { title: input.call.tool, output: clip(input.output ?? "") };
  const error = errorText(input);
  if (error) out.error_message = error;
  if (input.durationMs !== null) out.duration_ms = input.durationMs;
  return out;
}

// Drift and plan-missing rows omit plan_id so the backend does not fail the plan (design Q2).
const isPlanless = (decision: Decision | null) => decision?.kind === "deny" && PLANLESS_CODES.has(decision.code);

function errorText({ status, error, decision }: AuditInput): string | undefined {
  if (status === "success") return undefined;
  if (error !== null) return clip(error);
  return decision ? denialText(decision) : undefined;
}
