import type { CompiledPolicy, Decision, Session, ToolCall } from "../types.ts";
import { checkBuiltin, type BuiltinContext } from "./builtin-rules.ts";
import { checkCall, READ_ONLY_TOOLS } from "./intent.ts";

export type DecideInput = {
  policy: CompiledPolicy;
  session: Session;
  root: Session;
  call: ToolCall;
  now: number;
  builtin: BuiltinContext;
};

const RECOVER =
  "Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.";

function deny(code: Extract<Decision, { kind: "deny" }>["code"], reason: string, ruleId: string | null = null): Decision {
  return { kind: "deny", code, reason, ruleId };
}

// Order: builtin rules, policy, then plan and token (memory checks only). Pure.
// A child session is checked against its root's plan and token. `token.expiresAt`
// and `now` are epoch milliseconds.
export function decide(input: DecideInput): Decision {
  const { policy, session, root, call, now, builtin } = input;

  const builtinDecision = checkBuiltin(call, builtin);
  if (builtinDecision) return builtinDecision;

  // The plugin's own tools are how a plan gets registered; gating them on a
  // plan, or on a default-deny policy, would deadlock the session.
  if (builtin.ownTools.has(call.tool)) return { kind: "allow", stepIndex: null, paramMismatch: false };

  const verdict = policy.evaluate(call);
  if (verdict.effect === "forbid") return deny("policy_forbid", verdict.reason, verdict.ruleId);
  const policyHold: Decision | null =
    verdict.effect === "require_approval" ? { kind: "hold", ruleId: verdict.ruleId, reason: verdict.reason } : null;

  if (session.mode === "monitor" || !policy.intentRequired) {
    return policyHold ?? { kind: "allow", stepIndex: null, paramMismatch: false };
  }

  const token = root.token;
  // Read-only tools need no plan, but the backend's veto on a live token still applies.
  if (READ_ONLY_TOOLS.has(call.tool)) {
    if (token?.status === "active" && now < token.expiresAt) {
      if (token.deniedTools.has(call.tool)) return deny("backend_denied_tool", `ArmorIQ denied ${call.tool} for this plan`);
      if (token.heldTools.has(call.tool)) return { kind: "hold", ruleId: null, reason: `ArmorIQ holds ${call.tool} for approval` };
    }
    return policyHold ?? { kind: "allow", stepIndex: null, paramMismatch: false };
  }

  if (token?.status === "refused") {
    return token.code === "account_revoked"
      ? deny("account_revoked", "the ArmorIQ API key was revoked; run `armoriq login` again")
      : deny("billing_blocked", "the ArmorIQ subscription is inactive or over quota");
  }

  const plan = root.plan;
  if (!plan) {
    return deny(
      "intent_plan_missing",
      `no intent plan is registered for this session. Call register_intent_plan with your goal and the tools you will use (including ${call.tool}), then retry.`,
    );
  }
  if (!token) {
    return deny("intent_plan_missing", `the intent plan has no token. ${RECOVER}`);
  }
  if (now >= token.expiresAt) {
    return deny("intent_token_expired", `the intent token expired. ${RECOVER}`);
  }

  const check = checkCall(plan, call, root.stepCursor);
  if (!check.inPlan) return deny("intent_drift", `${call.tool} not in plan. ${RECOVER}`);

  const step = check.stepIndex === null ? undefined : plan.steps[check.stepIndex];
  const named = (set: ReadonlySet<string>) => set.has(call.tool) || (step !== undefined && set.has(step.action));
  if (named(token.deniedTools)) {
    return deny("backend_denied_tool", `ArmorIQ denied ${call.tool} for this plan`);
  }
  if (named(token.heldTools)) return { kind: "hold", ruleId: null, reason: `ArmorIQ holds ${call.tool} for approval` };
  if (policyHold) return policyHold;

  return { kind: "allow", stepIndex: check.stepIndex, paramMismatch: check.paramMismatch };
}
