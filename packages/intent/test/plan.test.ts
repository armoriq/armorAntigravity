import { describe, expect, test } from "bun:test";
import { checkCall, parsePlan, planToolName } from "../src/plan.ts";

describe("parsePlan", () => {
  test("maps Claude and OpenCode names to Antigravity tools and hashes {goal, steps}", () => {
    const r = parsePlan(
      { goal: "fix the build", steps: [{ action: "Bash" }, { tool: "write_to_file", metadata: { inputs: { TargetFile: "a.ts" } } }] },
      1,
      "turn-3",
    );
    expect(r).toEqual({
      ok: true,
      plan: {
        hash: "6a62d41e280275b93a2d0079ca81cdf35f47d87c6dc82a36703b5fcc42eb60a7",
        goal: "fix the build",
        steps: [
          { action: "Bash", tool: "run_command" },
          { action: "write_to_file", tool: "write_to_file", params: { TargetFile: "a.ts" } },
        ],
        revision: 1,
        registeredInMessage: "turn-3",
      },
    });
  });

  test("accepts the plan wrapped in `plan` and steps as a JSON string", () => {
    const r = parsePlan({ plan: JSON.stringify({ goal: "g", steps: '[{"action":"edit"}]' }) }, 1, "turn-0");
    expect(r.ok && r.plan.steps).toEqual([{ action: "edit", tool: "replace_file_content" }]);
  });

  test("rejects a plan with no steps or a step with no action", () => {
    expect(parsePlan({ goal: "g", steps: [] }, 1, "turn-0")).toEqual({
      ok: false,
      error: "steps: a non-empty array of {action, description?, metadata?: {inputs?}} is required",
    });
    expect(parsePlan({ goal: "g", steps: [{ description: "x" }] }, 1, "turn-0")).toEqual({
      ok: false,
      error: "steps[0].action is required (a tool name such as run_command or write_to_file)",
    });
  });
});

describe("planToolName", () => {
  test("normalizes MCP spellings to the hook's mcp_<server>_<tool>", () => {
    expect(planToolName("mcp__chrome-devtools__list_pages")).toBe("mcp_chrome_devtools_list_pages");
    expect(planToolName("mcp(chrome-devtools/list_pages)")).toBe("mcp_chrome_devtools_list_pages");
    expect(planToolName("run_command")).toBe("run_command");
  });
});

describe("checkCall", () => {
  const steps = [
    { action: "run_command", tool: "run_command", params: { CommandLine: "npm test" } },
    { action: "edit", tool: "replace_file_content" },
  ];

  test("a tool outside the plan is not in plan", () => {
    expect(checkCall(steps, "write_to_file", {}, 0)).toEqual({ inPlan: false });
  });

  test("params are advisory: a mismatch still matches, flagged", () => {
    expect(checkCall(steps, "run_command", { CommandLine: "rm -rf /" }, 0)).toEqual({ inPlan: true, stepIndex: 0, paramMismatch: true });
    expect(checkCall(steps, "run_command", { CommandLine: "npm test", Cwd: "/r" }, 0)).toEqual({ inPlan: true, stepIndex: 0, paramMismatch: false });
  });

  test("the two replace tools count as one", () => {
    expect(checkCall(steps, "multi_replace_file_content", {}, 0)).toEqual({ inPlan: true, stepIndex: 1, paramMismatch: false });
  });
});
