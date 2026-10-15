import { describe, expect, test } from "bun:test";
import { decide } from "../src/decide.ts";
import { parsePlan } from "../src/intent.ts";
import { compilePolicy, DEFAULT_POLICY_SOURCE } from "../src/policy.ts";
import type { Plan, Session, SessionID, ToolCall } from "../src/types.ts";
import { EXAMPLE_HOST } from "./support/example-host.ts";

const NOW = 1_800_000_000_000;
const compiled = compilePolicy(DEFAULT_POLICY_SOURCE, EXAMPLE_HOST);
if (!compiled.ok) throw new Error(compiled.error);
const policy = compiled.policy;

const parsed = parsePlan({ goal: "g", steps: [{ action: "Bash" }, { action: "Edit" }] }, 1, "m1", EXAMPLE_HOST);
if (!parsed.ok) throw new Error(parsed.error);
const plan: Plan = { ...parsed.plan, id: "plan-1" };

const session = (over: Partial<Session> = {}): Session => ({
  id: "root" as SessionID,
  parentId: null,
  mode: "enforce",
  plan,
  token: { status: "active", jwt: "jwt", expiresAt: NOW + 60_000, deniedTools: new Set(), heldTools: new Set() },
  stepCursor: 0,
  revisionsThisMessage: 0,
  currentMessageId: "m1",
  ...over,
});

function run(tool: string, args: Record<string, unknown>, root = session()) {
  return decide({
    policy,
    session: root,
    root,
    call: { sessionId: root.id, callId: "c", tool, args },
    now: NOW,
    builtin: { armoriqDir: "/home/dev/.armoriq", ownTools: new Set(["register_intent_plan"]), shadowedTools: new Set() },
    tools: EXAMPLE_HOST,
  });
}

describe("decide with a non-OpenCode vocabulary", () => {
  test("plan steps written with ArmorClaude names match the host's tools", () => {
    expect(plan.steps.map((s) => s.tool)).toEqual(["shell_exec", "patch_file"]);
    expect(run("shell_exec", { Cmd: "ls" })).toEqual({ kind: "allow", stepIndex: 0, paramMismatch: false });
    expect(run("patch_file", { Target: "a.ts" })).toEqual({ kind: "allow", stepIndex: 1, paramMismatch: false });
  });

  test("a tool outside the plan is drift, with the upstream reason", () => {
    expect(run("multi_patch", { Targets: ["a.ts"] })).toEqual({
      kind: "deny",
      code: "intent_drift",
      reason: "multi_patch not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.",
      ruleId: null,
    });
  });

  test("the host's read-only list skips the plan, and OpenCode's does not apply", () => {
    expect(run("open_file", { Target: "a.ts" }, session({ plan: null, token: null }))).toMatchObject({ kind: "allow" });
    expect(run("read", { filePath: "a.ts" }, session({ plan: null, token: null }))).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
  });

  test("the ArmorIQ directory is protected through the host's path fields", () => {
    expect(run("open_file", { Target: "/home/dev/.armoriq/credentials.json" })).toMatchObject({ kind: "deny", code: "builtin_protected" });
    expect(run("multi_patch", { Targets: ["a.ts", "/home/dev/.armoriq/x"] })).toMatchObject({ kind: "deny", code: "builtin_protected" });
    expect(run("patch_file", { Target: "notes.md", Content: "see ~/.armoriq" })).toMatchObject({ kind: "allow" });
  });

  test("a search root is checked even for a tool with no path fields", () => {
    const tools = { ...EXAMPLE_HOST, searchRoot: (call: ToolCall) => (call.tool === "search_dir" && typeof call.args.Root === "string" ? call.args.Root : null) };
    const root = session();
    const at = (Root: string) =>
      decide({
        policy,
        session: root,
        root,
        call: { sessionId: root.id, callId: "c", tool: "search_dir", args: { Root } },
        now: NOW,
        builtin: { armoriqDir: "/home/dev/.armoriq", ownTools: new Set(), shadowedTools: new Set() },
        tools,
      });
    expect(at("/home/dev")).toMatchObject({ kind: "deny", code: "builtin_protected" });
    expect(at("/home/dev/project")).toMatchObject({ kind: "deny", code: "intent_drift" });
  });
});
