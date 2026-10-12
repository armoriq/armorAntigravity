import type { DecideFn } from "../../src/decision.ts";
import type { BackendToolLists } from "../../src/backend-lists.ts";

const READ_ONLY = new Set(["view_file", "list_dir", "find_by_name", "grep_search"]);
const OWN = new Set(["register_intent_plan", "trust_reanchor", "trust_revoke", "policy_read", "trust_delegate"]);

// Stand-in for core decide() until https://github.com/armoriq/armorAntigravity/pull/58 lands it:
// armorOpenCode's order for a session whose plan already covers the call and whose token is live
// (own tools, policy forbid/hold, monitor, then the backend's denied and held lists).
export function decideForTest(lists: BackendToolLists = { deniedTools: new Set(), heldTools: new Set() }): DecideFn {
  return ({ call, policy, mode }) => {
    if (OWN.has(call.tool)) return { kind: "allow", stepIndex: null, paramMismatch: false };
    const verdict = policy.evaluate(call);
    if (verdict.effect === "forbid") return { kind: "deny", code: "policy_forbid", reason: verdict.reason, ruleId: verdict.ruleId };
    const hold = verdict.effect === "require_approval" ? ({ kind: "hold", ruleId: verdict.ruleId, reason: verdict.reason } as const) : null;
    if (mode === "monitor") return hold ?? { kind: "allow", stepIndex: null, paramMismatch: false };
    if (lists.deniedTools.has(call.tool)) return { kind: "deny", code: "backend_denied_tool", reason: `ArmorIQ denied ${call.tool} for this plan`, ruleId: null };
    if (lists.heldTools.has(call.tool)) return { kind: "hold", ruleId: null, reason: `ArmorIQ holds ${call.tool} for approval` };
    if (hold) return hold;
    return { kind: "allow", stepIndex: READ_ONLY.has(call.tool) ? null : 0, paramMismatch: false };
  };
}
