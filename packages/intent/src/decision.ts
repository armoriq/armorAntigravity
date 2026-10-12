import { checkCall, planToolName } from "./plan.ts";
import type { Conversation } from "./registry.ts";
import { AGENT_ID, CLIENT_ID, type AuditRow, type Plan } from "./types.ts";

export type IntentDenyCode =
  | "intent_plan_missing"
  | "intent_token_expired"
  | "intent_drift"
  | "backend_denied_tool"
  | "account_revoked"
  | "billing_blocked";

export type IntentVerdict =
  | { readonly kind: "allow"; readonly stepIndex: number | null; readonly paramMismatch: boolean }
  | { readonly kind: "deny"; readonly code: IntentDenyCode; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string };

export const RECOVER = "Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.";

const allowUnplanned: IntentVerdict = { kind: "allow", stepIndex: null, paramMismatch: false };

export interface IntentCheckInput {
  readonly root: Conversation | null;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
  readonly now: number;
}

// Steps 5 to 10 of the PRD check order. The caller (packages/core decide) has already run builtin rules,
// own-tool allow, policy forbid/hold and the monitor-mode short circuit, and merges its policy hold into
// an allow returned here.
export function checkIntent({ root, tool, args, readOnly, now }: IntentCheckInput): IntentVerdict {
  const token = root?.token ?? null;
  const live = token?.status === "active" && now < token.expiresAt ? token : null;

  if (readOnly) {
    if (live?.deniedTools.has(tool)) return { kind: "deny", code: "backend_denied_tool", reason: `ArmorIQ denied ${tool} for this plan` };
    if (live?.heldTools.has(tool)) return { kind: "hold", reason: `ArmorIQ holds ${tool} for approval` };
    return allowUnplanned;
  }

  if (token?.status === "refused") {
    return token.code === "account_revoked"
      ? { kind: "deny", code: "account_revoked", reason: "the ArmorIQ API key was revoked; run `armoriq login` again" }
      : { kind: "deny", code: "billing_blocked", reason: "the ArmorIQ subscription is inactive or over quota" };
  }

  const plan = root?.plan ?? null;
  if (!plan) {
    return {
      kind: "deny",
      code: "intent_plan_missing",
      reason: `no intent plan is registered for this conversation. Call register_intent_plan with your goal and the tools you will use (including ${tool}), then retry.`,
    };
  }
  if (!token) return { kind: "deny", code: "intent_plan_missing", reason: `the intent plan has no token. ${RECOVER}` };
  if (!live) return { kind: "deny", code: "intent_token_expired", reason: `the intent token expired. ${RECOVER}` };

  const check = checkCall(plan.steps, tool, args, root?.stepCursor ?? 0);
  if (!check.inPlan) return { kind: "deny", code: "intent_drift", reason: `${tool} not in plan. ${RECOVER}` };

  const step = plan.steps[check.stepIndex];
  const named = (set: ReadonlySet<string>) => set.has(tool) || (step !== undefined && set.has(step.action));
  if (named(live.deniedTools)) return { kind: "deny", code: "backend_denied_tool", reason: `ArmorIQ denied ${tool} for this plan` };
  if (named(live.heldTools)) return { kind: "hold", reason: `ArmorIQ holds ${tool} for approval` };
  return { kind: "allow", stepIndex: check.stepIndex, paramMismatch: check.paramMismatch };
}

const HINTED: ReadonlySet<IntentDenyCode> = new Set(["intent_drift", "intent_plan_missing", "intent_token_expired"]);
const HINT_VALUE_MAX = 200;

// Only short scalar inputs go into the hint: a write_to_file body would otherwise be echoed back whole,
// and inputs are advisory, so a long value adds nothing to the match.
function hintInputs(args: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const kept = Object.entries(args).filter(
    ([, v]) => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= HINT_VALUE_MAX),
  );
  return kept.length ? Object.fromEntries(kept) : null;
}

const planStepJson = (step: Plan["steps"][number]) => (step.params ? { action: step.tool, metadata: { inputs: step.params } } : { action: step.tool });

// ArmorClaude hook-output.mjs denyPreToolWithHint: the deny tells the model the exact plan to register.
export function suggestedPlan(plan: Plan | null, tool: string, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const action = planToolName(tool);
  const goal = plan?.goal;
  const inputs = hintInputs(args);
  const step = {
    action,
    description: `Use ${action} to ${goal ?? "make progress on the user's task"}`,
    ...(inputs ? { metadata: { inputs } } : {}),
  };
  const steps = plan && plan.steps.length ? [...plan.steps.map(planStepJson), step] : [step];
  return { goal: goal ?? `Run ${action}`, steps, ...(plan ? { reason: `Add ${action}, which the registered plan does not cover` } : {}) };
}

export function denyReason(verdict: Extract<IntentVerdict, { kind: "deny" }>, ctx: { plan: Plan | null; tool: string; args: Readonly<Record<string, unknown>> }): string {
  const base = `ArmorIQ blocked this call [${verdict.code}]: ${verdict.reason}`;
  if (!HINTED.has(verdict.code)) return base;
  const json = JSON.stringify(suggestedPlan(ctx.plan, ctx.tool, ctx.args), null, 2);
  return `${base}\n\nTo unblock: call register_intent_plan with this JSON:\n\`\`\`json\n${json}\n\`\`\``;
}

export const CHILD_SESSION_KEY = "_antigravity_session";
const PLANLESS: ReadonlySet<IntentDenyCode> = new Set(["intent_drift", "intent_plan_missing"]);
const ERROR_MAX = 2000;

// Blocked or held audit row for an intent verdict (ArmorOpenCode core/audit.ts toAuditRow). `input` must
// already be sanitized by the caller.
export function intentAuditRow(args: {
  verdict: Exclude<IntentVerdict, { kind: "allow" }>;
  conversation: Conversation;
  root: Conversation;
  tool: string;
  input: Readonly<Record<string, unknown>>;
  userId: string | null;
  at: number;
}): AuditRow {
  const { verdict, conversation, root } = args;
  const isChild = conversation.key !== root.key;
  const error = verdict.kind === "deny" ? `${verdict.code}: ${verdict.reason}` : `approval_required: ${verdict.reason}`;
  const omitPlan = verdict.kind === "deny" && PLANLESS.has(verdict.code);
  return {
    ...(root.plan && root.plan.id && !omitPlan ? { plan_id: root.plan.id } : {}),
    session_id: root.ref.conversationId,
    agent_id: AGENT_ID,
    client_id: CLIENT_ID,
    ...(args.userId ? { user_id: args.userId } : {}),
    step_index: -1,
    action: args.tool,
    tool: args.tool,
    input: isChild ? { ...args.input, [CHILD_SESSION_KEY]: conversation.ref.conversationId } : args.input,
    status: verdict.kind === "deny" ? "blocked" : "held",
    error_message: error.slice(0, ERROR_MAX),
    executed_at: new Date(args.at).toISOString(),
  };
}

export type PolicySpanResult =
  | { readonly decision: "block"; readonly policyReasonCode: string; readonly ruleId?: string }
  | { readonly decision: "hold"; readonly policyReasonCode: "require_approval"; readonly ruleId?: string }
  | { readonly decision: "allow"; readonly policyReasonCode?: "intent_param_mismatch" };

// ArmorOpenCode pumps/traces.ts policyResult, for the verdicts this package produces.
export function policySpanResult(verdict: IntentVerdict): PolicySpanResult {
  switch (verdict.kind) {
    case "deny":
      return { decision: "block", policyReasonCode: verdict.code };
    case "hold":
      return { decision: "hold", policyReasonCode: "require_approval" };
    case "allow":
      return verdict.paramMismatch ? { decision: "allow", policyReasonCode: "intent_param_mismatch" } : { decision: "allow" };
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}
