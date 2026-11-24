import { expect, test } from "bun:test";
import contract from "../fixtures/runs-v1.json";
import { RUNS, countRunAttempt, noPlanReason, runCapability, settleRunRequest, type RunState } from "../../src/core/runs.ts";
const RUN_CAPABILITIES = contract.capabilities.armoropencode.rules;

test("run constants agree with the shared contract", () => {
  expect(contract.endReasons).toEqual([...RUNS.endReasons]);
  expect(contract.noPlanReasons).toEqual([...RUNS.noPlanReasons]);
  expect(contract.limits).toEqual(RUNS.limits);
});

test("the first matching capability rule counts before enforcement bypasses", () => {
  for (const tool of ["read", "grep", "glob", "list", "webfetch", "websearch", "todoread", "todowrite"])
    expect(runCapability(tool, RUN_CAPABILITIES)).toEqual({ counted: true, gated: false });
  for (const tool of ["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"])
    expect(runCapability(tool, RUN_CAPABILITIES)).toEqual({ counted: false, gated: false });
  for (const tool of ["bash", "edit", "task", "external_read", "unknown"])
    expect(runCapability(tool, RUN_CAPABILITIES)).toEqual({ counted: true, gated: true });
  expect(runCapability("policy_read", RUN_CAPABILITIES, false)).toEqual({ counted: true, gated: true });
});

test("reasons follow AC 4 order and a confirmed plan suppresses every reason", () => {
  const base: RunState = { runId: "r", sessionId: "s", startedAt: 0, binding: null, owner: { id: "owner", pid: 1 }, version: 1, reportSeq: 1, callIds: [], end: null, closed: false,
    enforcing: true, enforcementNeeded: true, toolCalls: 2, gatedToolCalls: 1, planIds: [], requests: {}, rejected: false, unreachable: false };
  const reason = (facts: Partial<RunState> = {}) => noPlanReason({ ...base, ...facts });
  expect(reason({ enforcing: false, enforcementNeeded: false, toolCalls: 0, gatedToolCalls: 0, unreachable: true })).toBe("monitor_mode");
  expect(reason({ toolCalls: 0, gatedToolCalls: 0, rejected: true })).toBe("no_tool_use");
  expect(reason({ gatedToolCalls: 0, unreachable: true })).toBe("read_only");
  expect(reason({ enforcing: true, enforcementNeeded: false, gatedToolCalls: 1 })).toBe("not_registered");
  expect(reason({ unreachable: true, requests: { a: "failed" }, rejected: true })).toBe("backend_unreachable");
  expect(reason({ requests: { a: "failed", b: "failed" }, rejected: true })).toBe("request_failed");
  expect(reason({ rejected: true })).toBe("plan_rejected");
  expect(reason()).toBe("not_registered");
  expect(reason({ planIds: ["11111111-1111-4111-8111-111111111111"], enforcing: false, unreachable: true })).toBeUndefined();
});

// regression: #0013
test("run counting uses the supplied host capability rules", () => {
  const run: RunState = { runId: "r", sessionId: "s", startedAt: 0, binding: null, owner: { id: "owner", pid: 1 }, version: 1, reportSeq: 1,
    callIds: [], end: null, closed: false, enforcing: true, enforcementNeeded: false, toolCalls: 0, gatedToolCalls: 0, planIds: [], requests: {}, rejected: false, unreachable: false };
  const rules = [{ patterns: ["^bash$"], counted: true, gated: false }];
  expect(countRunAttempt(run, "call", "bash", true, rules)).toMatchObject({ toolCalls: 1, gatedToolCalls: 0 });
});

test("vendored run transitions deduplicate attempts and logical registrations without changing their input", () => {
  const run: RunState = { runId: "r", sessionId: "s", startedAt: 0, binding: null, owner: { id: "owner", pid: 1 }, version: 1, reportSeq: 1,
    callIds: [], end: null, closed: false, enforcing: true, enforcementNeeded: false, toolCalls: 0, gatedToolCalls: 0, planIds: [], requests: {}, rejected: false, unreachable: false };
  const counted = countRunAttempt(run, "call", "bash", true, RUN_CAPABILITIES)!;
  expect(counted).toMatchObject({ toolCalls: 1, gatedToolCalls: 1, enforcementNeeded: true });
  expect(countRunAttempt(counted, "call", "bash", true, RUN_CAPABILITIES)).toBeNull();
  expect(countRunAttempt(run, "own", "policy_read", true, RUN_CAPABILITIES)).toBeNull();
  expect(run.toolCalls).toBe(0);
  const pending = settleRunRequest(counted, "logical-request", "pending");
  const failed = settleRunRequest(pending, "logical-request", "failed", undefined, true);
  const confirmed = settleRunRequest(failed, "logical-request", "confirmed", "11111111-1111-4111-8111-111111111111");
  expect(Object.keys(confirmed.requests)).toEqual(["logical-request"]);
  expect(confirmed.planIds).toHaveLength(1);
  expect(noPlanReason(confirmed)).toBeUndefined();
  expect(run.requests).toEqual({});
});
