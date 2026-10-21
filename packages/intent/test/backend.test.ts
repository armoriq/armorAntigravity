import { describe, expect, test } from "bun:test";
import { toSdkPlan } from "../src/backend.ts";
import { compileMintPolicy } from "../src/mint-policy.ts";

describe("mint payload pieces", () => {
  test("plan steps carry mcp antigravity and the registered source", () => {
    expect(
      toSdkPlan({ hash: "abc", goal: "g", revision: 1, registeredInMessage: "turn-1", steps: [{ action: "Bash", tool: "run_command", params: { CommandLine: "ls" } }] }),
    ).toEqual({
      goal: "g",
      steps: [{ action: "run_command", tool: "run_command", mcp: "antigravity", description: "Bash", metadata: { inputs: { CommandLine: "ls" } } }],
      metadata: { goal: "g", source: "antigravity-registered", plan_hash: "abc" },
    });
  });

  test("the local policy compiles as ArmorClaude sends it", () => {
    const statements = [
      { id: "a", effect: "forbid" as const, action: { eq: "run_command" } },
      { id: "b", effect: "permit" as const, action: { in: ["view_file", "write_to_file"] } },
      { id: "c", effect: "require_approval" as const, action: {} },
    ];
    expect(compileMintPolicy({ schemaVersion: "armor.policy.v1", statements }, "ph")).toEqual({
      allow: ["*"],
      deny: [],
      allowed_tools: ["view_file", "write_to_file", "*"],
      denied_tools: ["run_command"],
      statements,
      metadata: { source: "armorantigravity", schemaVersion: "armor.policy.v1", policyHash: "ph" },
    });
  });
});
