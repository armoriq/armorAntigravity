import { describe, expect, test } from "bun:test";
import { checkCall, parsePlan, planToolName } from "../../src/core/intent.ts";
import type { Plan, SessionID } from "../../src/types.ts";

const ARGS = {
  goal: "fix the test",
  steps: [
    { action: "read", description: "look", metadata: { inputs: { filePath: "a.ts" } } },
    { action: "Edit" },
    { action: "bash", metadata: { inputs: { command: "bun test" } } },
    { action: "bash", metadata: { inputs: { command: "bun run lint" } } },
  ],
};

function plan(raw: unknown = ARGS): Plan {
  const r = parsePlan(raw, 1, "msg-1");
  if (!r.ok) throw new Error(r.error);
  return { ...r.plan, id: "plan-1" };
}

function call(tool: string, args: Record<string, unknown> = {}) {
  return { sessionId: "s" as SessionID, callId: "c", tool, args };
}

describe("parsePlan", () => {
  test("parses the canonical shape into OpenCode tool names", () => {
    const r = parsePlan(ARGS, 2, "msg-9");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.goal).toBe("fix the test");
    expect(r.plan.revision).toBe(2);
    expect(r.plan.registeredInMessage).toBe("msg-9");
    expect(r.plan.steps).toEqual([
      { action: "read", tool: "read", params: { filePath: "a.ts" } },
      { action: "Edit", tool: "edit" },
      { action: "bash", tool: "bash", params: { command: "bun test" } },
      { action: "bash", tool: "bash", params: { command: "bun run lint" } },
    ]);
  });

  test("an explicit step tool wins over a prose action", () => {
    const r = parsePlan({ goal: "g", steps: [{ action: "list the files", tool: "Bash" }] }, 1, "m1");
    expect(r.ok && r.plan.steps).toEqual([{ action: "list the files", tool: "bash" }]);
  });

  test("accepts steps as a JSON string and the plan wrapped in `plan`, as models send them", () => {
    const canonical = plan();
    const stringSteps = parsePlan({ goal: ARGS.goal, steps: JSON.stringify(ARGS.steps) }, 1, "msg-1");
    const wrapped = parsePlan({ plan: JSON.stringify(ARGS) }, 1, "msg-1");
    const wrappedObject = parsePlan({ plan: ARGS }, 1, "msg-1");
    for (const r of [stringSteps, wrapped, wrappedObject]) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.plan.hash).toBe(canonical.hash);
    }
  });

  test("the hash changes when a step changes and not when the message does", () => {
    const a = parsePlan(ARGS, 1, "m1");
    const b = parsePlan(ARGS, 3, "m2");
    const c = parsePlan({ ...ARGS, steps: [...ARGS.steps, { action: "write" }] }, 1, "m1");
    if (!a.ok || !b.ok || !c.ok) throw new Error("parse failed");
    expect(a.plan.hash).toBe(b.plan.hash);
    expect(a.plan.hash).not.toBe(c.plan.hash);
  });

  test("explains what is wrong with a malformed plan", () => {
    expect(parsePlan("do things", 1, "m")).toEqual({ ok: false, error: "plan must be an object with goal and steps" });
    expect(parsePlan({ steps: ARGS.steps }, 1, "m")).toEqual({ ok: false, error: "goal: a one-line summary is required" });
    expect(parsePlan({ goal: "x", steps: [] }, 1, "m")).toEqual({
      ok: false,
      error: "steps: a non-empty array of {action, description?, metadata?: {inputs?}} is required",
    });
    expect(parsePlan({ goal: "x", steps: "[not json" }, 1, "m").ok).toBe(false);
    expect(parsePlan({ goal: "x", steps: [{ description: "no action" }] }, 1, "m")).toEqual({
      ok: false,
      error: "steps[0].action is required (a tool name such as bash, edit, read)",
    });
    expect(parsePlan({ goal: "x", steps: [{ action: "bash", metadata: { inputs: "ls" } }] }, 1, "m")).toEqual({
      ok: false,
      error: "steps[0].metadata.inputs must be an object",
    });
  });
});

describe("planToolName", () => {
  test("maps ArmorClaude names to OpenCode names", () => {
    expect(planToolName("Bash")).toBe("bash");
    expect(planToolName("MultiEdit")).toBe("edit");
    expect(planToolName("Agent")).toBe("task");
    expect(planToolName("mcp__github__create_issue")).toBe("github_create_issue");
    expect(planToolName("mcp__my.svc__do-it")).toBe("my_svc_do-it");
    expect(planToolName("mcp__srv__a__b")).toBe("srv_a__b");
    expect(planToolName("mcp____x")).toBe("mcp____x");
    expect(planToolName("mcp__only")).toBe("mcp__only");
  });
});

describe("checkCall", () => {
  test("a tool outside the plan is not in plan", () => {
    expect(checkCall(plan(), call("write", { filePath: "x" }), 0)).toEqual({ inPlan: false, stepIndex: null, paramMismatch: false });
  });

  test("prefers the step whose inputs the call satisfies", () => {
    expect(checkCall(plan(), call("bash", { command: "bun run lint" }), 0)).toEqual({ inPlan: true, stepIndex: 3, paramMismatch: false });
    expect(checkCall(plan(), call("bash", { command: "bun test", workdir: "/w" }), 0)).toEqual({
      inPlan: true,
      stepIndex: 2,
      paramMismatch: false,
    });
  });

  test("params are advisory: a mismatch is reported, not refused", () => {
    expect(checkCall(plan(), call("bash", { command: "rm -rf /" }), 0)).toEqual({ inPlan: true, stepIndex: 2, paramMismatch: true });
  });

  test("a step without declared inputs accepts any params", () => {
    expect(checkCall(plan(), call("edit", { filePath: "z.ts" }), 0)).toEqual({ inPlan: true, stepIndex: 1, paramMismatch: false });
  });

  test("the cursor moves selection forward, falling back to the first match when every match is behind it", () => {
    expect(checkCall(plan(), call("bash", { command: "x" }), 3).stepIndex).toBe(3);
    expect(checkCall(plan(), call("bash", { command: "bun test" }), 3)).toEqual({ inPlan: true, stepIndex: 3, paramMismatch: false });
    expect(checkCall(plan(), call("read", { filePath: "a.ts" }), 4).stepIndex).toBe(0);
  });

  test("plans written with ArmorClaude names match OpenCode calls", () => {
    const p = plan({ goal: "g", steps: [{ action: "MultiEdit" }, { action: "mcp__github__create_issue" }] });
    expect(checkCall(p, call("edit"), 0).stepIndex).toBe(0);
    expect(checkCall(p, call("github_create_issue"), 0).stepIndex).toBe(1);
  });
});
