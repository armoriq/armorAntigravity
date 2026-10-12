import { describe, expect, test } from "bun:test";
import { checkIntent, denyReason, intentAuditRow, policySpanResult, type IntentVerdict } from "../src/decision.ts";
import type { Conversation } from "../src/registry.ts";
import { conversationKey, type Plan, type Token } from "../src/types.ts";

const NOW = 1_000_000;

const plan: Plan = {
  id: "plan-9",
  hash: "h",
  goal: "fix the build",
  steps: [{ action: "run_command", tool: "run_command" }],
  revision: 1,
  registeredInMessage: "turn-1",
};

const active = (over: Partial<Extract<Token, { status: "active" }>> = {}): Token => ({
  status: "active",
  jwt: "j",
  expiresAt: NOW + 60_000,
  deniedTools: new Set(),
  heldTools: new Set(),
  ...over,
});

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  const ref = { surface: "cli" as const, conversationId: id };
  return { key: conversationKey(ref), ref, parent: null, plan, token: active(), stepCursor: 0, turn: 1, revisionsThisTurn: 0, lastActivity: NOW, ...over };
}

const check = (root: Conversation | null, tool: string, readOnly = false) => checkIntent({ root, tool, args: {}, readOnly, now: NOW });

describe("checkIntent order", () => {
  test("read-only tools skip the plan but honour the backend's lists", () => {
    expect(check(conv("c", { plan: null, token: null }), "view_file", true)).toEqual({ kind: "allow", stepIndex: null, paramMismatch: false });
    expect(check(conv("c", { token: active({ deniedTools: new Set(["view_file"]) }) }), "view_file", true)).toEqual({
      kind: "deny",
      code: "backend_denied_tool",
      reason: "ArmorIQ denied view_file for this plan",
    });
  });

  test("a refused token denies before the plan is looked at", () => {
    expect(check(conv("c", { token: { status: "refused", code: "billing_blocked" } }), "run_command")).toEqual({
      kind: "deny",
      code: "billing_blocked",
      reason: "the ArmorIQ subscription is inactive or over quota",
    });
  });

  test("missing plan, expired token, drift, then backend lists", () => {
    expect(check(conv("c", { plan: null, token: null }), "run_command")).toMatchObject({ code: "intent_plan_missing" });
    expect(check(conv("c", { token: active({ expiresAt: NOW }) }), "run_command")).toMatchObject({ code: "intent_token_expired" });
    expect(check(conv("c"), "write_to_file")).toEqual({
      kind: "deny",
      code: "intent_drift",
      reason: "write_to_file not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.",
    });
    expect(check(conv("c", { token: active({ heldTools: new Set(["run_command"]) }) }), "run_command")).toEqual({
      kind: "hold",
      reason: "ArmorIQ holds run_command for approval",
    });
  });
});

describe("drift output", () => {
  const drift = check(conv("c"), "write_to_file");
  if (drift.kind !== "deny") throw new Error("expected deny");

  test("the hook reason carries the code and a suggested register_intent_plan payload", () => {
    const reason = denyReason(drift, { plan, tool: "write_to_file", args: { TargetFile: "src/a.ts", CodeContent: "x".repeat(500) } });
    expect(reason).toBe(
      [
        "ArmorIQ blocked this call [intent_drift]: write_to_file not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.",
        "",
        "To unblock: call register_intent_plan with this JSON:",
        "```json",
        JSON.stringify(
          {
            goal: "fix the build",
            steps: [{ action: "run_command" }, { action: "write_to_file", description: "Use write_to_file to fix the build", metadata: { inputs: { TargetFile: "src/a.ts" } } }],
            reason: "Add write_to_file, which the registered plan does not cover",
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  });

  test("the audit row is blocked, step -1, without plan_id, with the child id for a subagent", () => {
    const root = conv("root");
    const child = conv("kid", { parent: root.key, plan: null, token: null });
    expect(intentAuditRow({ verdict: drift, conversation: child, root, tool: "write_to_file", input: { TargetFile: "a" }, userId: "u", at: NOW })).toEqual({
      session_id: "root",
      agent_id: "antigravity",
      client_id: "armorantigravity",
      user_id: "u",
      step_index: -1,
      action: "write_to_file",
      tool: "write_to_file",
      input: { TargetFile: "a", _antigravity_session: "kid" },
      status: "blocked",
      error_message:
        "intent_drift: write_to_file not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.",
      executed_at: new Date(NOW).toISOString(),
    });
  });

  test("an expired-token row keeps plan_id", () => {
    const expired: IntentVerdict = { kind: "deny", code: "intent_token_expired", reason: "r" };
    const root = conv("root");
    expect(intentAuditRow({ verdict: expired, conversation: root, root, tool: "run_command", input: {}, userId: null, at: NOW }).plan_id).toBe("plan-9");
  });

  test("policy span results", () => {
    expect(policySpanResult(drift)).toEqual({ decision: "block", policyReasonCode: "intent_drift" });
    expect(policySpanResult({ kind: "allow", stepIndex: 0, paramMismatch: true })).toEqual({ decision: "allow", policyReasonCode: "intent_param_mismatch" });
  });
});
