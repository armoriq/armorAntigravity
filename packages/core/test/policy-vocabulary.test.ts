import { describe, expect, test } from "bun:test";
import { compilePolicy } from "../src/policy.ts";
import type { CompiledPolicy, SessionID } from "../src/types.ts";
import { EXAMPLE_HOST } from "./support/example-host.ts";

function compile(raw: unknown): CompiledPolicy {
  const r = compilePolicy(raw, EXAMPLE_HOST);
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

const evaluate = (policy: CompiledPolicy, tool: string, args: Record<string, unknown>) =>
  policy.evaluate({ sessionId: "s" as SessionID, callId: "c", tool, args });

const policy = compile({
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [
    { id: "no-rm", effect: "forbid", action: { type: "tool", eq: "Bash" }, conditions: [{ field: "bash.raw", op: "matches", value: "rm\\s+-rf" }] },
    { id: "no-secrets", effect: "forbid", action: { type: "tool", eq: "Edit" }, conditions: [{ field: "file.path", op: "starts_with", value: "secrets/" }] },
  ],
});

describe("compilePolicy with a non-OpenCode vocabulary", () => {
  test("ArmorClaude tool names reach the host's tools and conditions read its argument fields", () => {
    expect(evaluate(policy, "shell_exec", { Cmd: "rm -rf /" })).toMatchObject({ effect: "forbid", ruleId: "no-rm" });
    expect(evaluate(policy, "shell_exec", { command: "rm -rf /" }).effect).toBe("permit");
    expect(evaluate(policy, "patch_file", { Target: "secrets/key" })).toMatchObject({ effect: "forbid", ruleId: "no-secrets" });
  });

  test("a multi-file edit is judged per path", () => {
    expect(evaluate(policy, "multi_patch", { Targets: ["src/a.ts", "secrets/b"] })).toMatchObject({ effect: "forbid", ruleId: "no-secrets" });
    expect(evaluate(policy, "multi_patch", { Targets: ["src/a.ts"] }).effect).toBe("permit");
  });

  test("a legacy rule naming a native tool stays a tool rule", () => {
    const legacy = compile({ rules: [{ id: "r", action: "deny", tool: "grep" }] });
    expect(evaluate(legacy, "shell_exec", { Cmd: "grep x" })).toMatchObject({ effect: "forbid", ruleId: "r" });
    const asNative = compilePolicy({ rules: [{ id: "r", action: "deny", tool: "grep" }] }, { ...EXAMPLE_HOST, native: new Set(["grep"]) });
    if (!asNative.ok) throw new Error(asNative.error);
    expect(evaluate(asNative.policy, "shell_exec", { Cmd: "grep x" }).effect).toBe("permit");
    expect(evaluate(asNative.policy, "grep", {}).effect).toBe("forbid");
  });
});
