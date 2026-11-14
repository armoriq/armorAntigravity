import { describe, expect, test } from "bun:test";
import { toAuditRow, type AuditInput } from "../src/audit.ts";
import { OPENCODE } from "../src/products/opencode.ts";
import type { Decision, Plan, Session, SessionID } from "../src/types.ts";

const AT = Date.parse("2026-10-11T10:00:01.000Z");
const plan: Plan = {
  id: "plan-1",
  hash: "h",
  goal: "list files",
  steps: [
    { action: "list the repo", tool: "bash" },
    { action: "read the readme", tool: "read" },
  ],
  revision: 0,
  registeredInMessage: "msg-1",
};

function session(id: string, parentId: string | null = null, withPlan = true): Session {
  return {
    id: id as SessionID,
    parentId: parentId as SessionID | null,
    mode: "enforce",
    plan: withPlan ? plan : null,
    token: null,
    stepCursor: 0,
    revisionsThisMessage: 0,
    currentMessageId: null,
  };
}

const root = session("ses_root");
const allowStep1: Decision = { kind: "allow", stepIndex: 1, paramMismatch: false };

function build(overrides: Partial<AuditInput>) {
  return toAuditRow({
    call: { sessionId: root.id, callId: "call-1", tool: "read", args: { filePath: "README.md" } },
    session: root,
    root,
    status: "success",
    decision: allowStep1,
    output: "hello",
    error: null,
    durationMs: 1000,
    at: AT,
    userId: "user-1",
    userEmail: "dev@example.com",
    ...overrides,
  }, OPENCODE);
}

describe("toAuditRow", () => {
  test("a successful in-plan call carries the plan, its step and armorClaude's attribution", () => {
    expect(build({})).toEqual({
      plan_id: "plan-1",
      session_id: "ses_root",
      agent_id: "opencode",
      client_id: "armoropencode",
      user_id: "user-1",
      user_email: "dev@example.com",
      step_index: 1,
      action: "read the readme",
      tool: "read",
      input: { filePath: "README.md" },
      output: { title: "read", output: "hello" },
      status: "success",
      duration_ms: 1000,
      executed_at: "2026-10-11T10:00:00.000Z",
    });
  });

  test("output text is cut to 2000 characters", () => {
    const row = build({ output: "y".repeat(5000) });
    expect((row.output!.output as string).length).toBe(2000);
  });

  test("a call that matches no step gets step_index -1 and the tool as action", () => {
    const row = build({ decision: { kind: "allow", stepIndex: null, paramMismatch: false } });
    expect([row.step_index, row.action, row.plan_id]).toEqual([-1, "read", "plan-1"]);
  });

  test("a failed call carries the error and no output", () => {
    const row = build({ status: "failed", output: null, error: "ENOENT: README.md" });
    expect([row.status, row.error_message, row.output]).toEqual(["failed", "ENOENT: README.md", undefined]);
  });

  test("an error row carries the error message", () => {
    const row = build({ status: "error", output: null, error: "tool crashed" });
    expect([row.status, row.error_message, row.step_index]).toEqual(["error", "tool crashed", 1]);
  });

  test("a policy block names the deny code, keeps the plan and has step_index -1", () => {
    const row = build({
      status: "blocked",
      decision: { kind: "deny", code: "policy_forbid", reason: "no curl", ruleId: "no-curl" },
      output: null,
      durationMs: 0,
    });
    expect([row.status, row.error_message, row.step_index, row.plan_id, row.output, row.duration_ms]).toEqual([
      "blocked",
      "policy_forbid: no curl",
      -1,
      "plan-1",
      undefined,
      0,
    ]);
  });

  test("a held call is recorded as held with the approval reason", () => {
    const row = build({ status: "held", decision: { kind: "hold", ruleId: "r", reason: "deploys need approval" }, output: null });
    expect([row.status, row.error_message, row.step_index]).toEqual(["held", "approval_required: deploys need approval", -1]);
  });

  test("drift and plan-missing rows omit plan_id", () => {
    for (const code of ["intent_drift", "intent_plan_missing"] as const) {
      const row = build({ status: "blocked", decision: { kind: "deny", code, reason: "bash not in plan", ruleId: null }, output: null });
      expect([row.plan_id, row.step_index, row.error_message]).toEqual([undefined, -1, `${code}: bash not in plan`]);
    }
  });

  test("a subagent call is attributed to the root session with the child id in input", () => {
    const child = session("ses_child", "ses_root", false);
    const row = build({ session: child, call: { sessionId: child.id, callId: "c", tool: "read", args: { filePath: "a" } } });
    expect([row.session_id, row.agent_id, row.input, row.plan_id]).toEqual([
      "ses_root",
      "opencode",
      { filePath: "a", _opencode_session: "ses_child" },
      "plan-1",
    ]);
  });

  test("a planless session omits plan_id and user fields when logged out of them", () => {
    const bare = session("ses_bare", null, false);
    const row = build({ session: bare, root: bare, decision: null, userId: undefined, userEmail: undefined });
    expect([row.plan_id, row.user_id, row.user_email, row.step_index]).toEqual([undefined, undefined, undefined, -1]);
  });
});
