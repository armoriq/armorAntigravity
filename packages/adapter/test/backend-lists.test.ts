import { describe, expect, test } from "bun:test";
import { backendToolLists } from "../src/backend-lists.ts";

// Shapes from conmap-auto origin/dev src/policies/v2/enforce/plan-check.service.ts.
const requested = ["run_command", "write_to_file", "view_file"];

describe("backendToolLists", () => {
  test("org with no agent: validated:false lists every tool as denied, which means no opinion", () => {
    const unvalidated = {
      validated: false,
      requested_tools: requested,
      allowed_tools: [],
      denied_tools: requested,
      held_tools: [],
      denied_reasons: requested.map((t) => `${t}: agent_unresolved`),
      matched_policies: [],
      default_enforcement_action: "block",
      decision_source: "v2",
      policy_version: "2",
      reason: "agent_unresolved",
    };
    const lists = backendToolLists(unvalidated);
    expect(lists.deniedTools.size).toBe(0);
    expect(lists.heldTools.size).toBe(0);
  });

  test("org with no active policy (ungoverned) has empty lists", () => {
    const lists = backendToolLists({ validated: false, requested_tools: requested, allowed_tools: requested, denied_tools: [], held_tools: [], reason: "no_active_policy" });
    expect(lists.deniedTools.size + lists.heldTools.size).toBe(0);
  });

  test("validated:true keeps both lists", () => {
    const lists = backendToolLists({
      validated: true,
      requested_tools: requested,
      allowed_tools: ["view_file", "write_to_file"],
      denied_tools: ["run_command"],
      held_tools: ["write_to_file"],
      matched_policies: [{ policyId: "p1", name: "default" }],
      default_enforcement_action: "allow",
    });
    expect([...lists.deniedTools]).toEqual(["run_command"]);
    expect([...lists.heldTools]).toEqual(["write_to_file"]);
  });

  test("a missing validation block, or one without the flag, is read like OpenCode: lists as given", () => {
    expect(backendToolLists(undefined).deniedTools.size).toBe(0);
    expect([...backendToolLists({ denied_tools: ["Bash", 7, null] }).deniedTools].sort()).toEqual(["Bash", "run_command"]);
  });
});
