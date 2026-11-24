import { expect, test } from "bun:test";
import * as audit from "../src/audit.ts";
import type { AuditInput } from "../src/audit.ts";
import type { Decision, Session, SessionID } from "../src/types.ts";
import contract from "../../intent/test/fixtures/block-capture-v1.json";
import { planCaptureState } from "./helpers/session.ts";

const product = { slug: "armorantigravity", agentId: "antigravity", childSessionKey: "_antigravity_session" };
const root: Session = { ...planCaptureState(), id: "root" as SessionID, parentId: null, mode: "enforce", plan: { id: "counted", hash: "h", goal: "g", steps: [], revision: 1, registeredInMessage: "prompt" }, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: "prompt" };
const input: AuditInput = { call: { sessionId: root.id, callId: "4", tool: "run_command", args: {} }, session: root, root, status: "blocked", decision: null, output: null, error: null, durationMs: null, at: 1000 };

test("action identity agrees with every shared UUID v5 vector", () => {
  for (const v of contract.clientRowId.vectors) expect((audit as any).clientRowId(v.rootSessionId, v.toolCallId, v.phase)).toBe(v.clientRowId);
});

test("every core stop has the shared code and only approval is held", () => {
  for (const { decisionCode, producers } of contract.reasonCodes) {
    for (const code of producers.armorantigravity.filter(code => !["mcp_server_denied", "daemon_unavailable"].includes(code))) {
      const decision: Decision = code === "approval_required" ? { kind: "hold", ruleId: null, reason: "approval" } : { kind: "deny", code: code as any, ruleId: null, reason: "stopped" };
      expect(audit.toAuditRow({ ...input, decision }, product)).toMatchObject({ decision_code: decisionCode, status: code === "approval_required" ? "held" : "blocked" });
    }
  }
});

test("a hold and later deny share one decision identity and a result uses its own", () => {
  const held = audit.toAuditRow({ ...input, status: "held", decision: { kind: "hold", ruleId: null, reason: "ask" } }, product);
  const denied = audit.toAuditRow({ ...input, decision: { kind: "deny", code: "policy_forbid", ruleId: null, reason: "no" } }, product);
  const result = audit.toAuditRow({ ...input, status: "success" }, product);
  expect(held.client_row_id).toBeDefined();
  expect(held.client_row_id).toBe(denied.client_row_id);
  expect(result.client_row_id).not.toBe(held.client_row_id);
});

test("a result retains the token plan, counted plan and prompt captured at decision time", () => {
  const session = { ...root, tokenPlanId: "token", countedPlanId: "counted", promptId: "first" };
  const snapshot = (audit as any).snapshotAuditContext(session, session, null);
  session.tokenPlanId = "later-token";
  session.countedPlanId = "later-plan";
  session.promptId = "later-prompt";
  const row = audit.toAuditRow({ ...input, status: "success", snapshot } as AuditInput, product);
  expect(row).toMatchObject({ plan_id: "token", context_plan_id: "counted", prompt_id: "first" });
  const drift = audit.toAuditRow({ ...input, root: session, session, decision: { kind: "deny", code: "intent_drift", reason: "outside", ruleId: null } }, product);
  expect(drift.plan_id).toBeUndefined();
  expect(drift).toMatchObject({ context_plan_id: "later-plan", prompt_id: "later-prompt" });
});
