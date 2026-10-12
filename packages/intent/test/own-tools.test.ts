import { describe, expect, test } from "bun:test";
import { checkIntent } from "../src/decision.ts";
import { AMBIGUOUS_OUTCOME, callDigest, ownToolName } from "../src/own-tools.ts";
import { conversationKey, type ConversationRef, type PolicyView } from "../src/types.ts";
import { harness } from "./helpers.ts";

const A: ConversationRef = { surface: "cli", conversationId: "conv-a" };
const B: ConversationRef = { surface: "cli", conversationId: "conv-b" };

const plan = (goal: string, ...actions: string[]) => ({ goal, steps: actions.map((action) => ({ action })) });

describe("parallel conversations", () => {
  test("two conversations registering at the same time never see each other's plan", async () => {
    const h = harness({ gate: true });
    const ra = h.tools.handle(A, "register_intent_plan", plan("edit docs", "write_to_file"));
    const rb = h.tools.handle(B, "register_intent_plan", plan("run tests", "run_command"));
    await Bun.sleep(0);
    h.release();
    expect(await Promise.all([ra, rb])).toEqual([expect.stringMatching(/^Intent registered: 1 steps\./), expect.stringMatching(/^Intent registered: 1 steps\./)]);

    expect(h.mints.map((m) => [m.contextId, m.tools])).toEqual([
      ["conv-a", ["write_to_file"]],
      ["conv-b", ["run_command"]],
    ]);
    const rootA = h.registry.root(conversationKey(A));
    const rootB = h.registry.root(conversationKey(B));
    expect(rootA?.plan?.goal).toBe("edit docs");
    expect(rootB?.plan?.goal).toBe("run tests");

    const now = Date.now();
    expect(checkIntent({ root: rootA, tool: "run_command", args: {}, readOnly: false, now })).toMatchObject({ kind: "deny", code: "intent_drift" });
    expect(checkIntent({ root: rootB, tool: "run_command", args: {}, readOnly: false, now })).toEqual({ kind: "allow", stepIndex: 0, paramMismatch: false });
  });

  test("the same conversationId on two surfaces is two conversations", async () => {
    const h = harness();
    await h.tools.handle({ surface: "app", conversationId: "same" }, "register_intent_plan", plan("g", "run_command"));
    expect(h.registry.root(conversationKey({ surface: "ide", conversationId: "same" }))).toBeNull();
  });
});

describe("registration rules", () => {
  test("only one registration may be in flight per conversation", async () => {
    const h = harness({ gate: true });
    const first = h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    await Bun.sleep(0);
    expect(await h.tools.handle(A, "register_intent_plan", plan("g2", "run_command"))).toBe(
      "A plan registration is already in progress for this conversation. Wait for it to finish.",
    );
    h.release();
    await first;
  });

  test("a revision needs a reason and at most two are allowed per user message", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "write_to_file"))).toBe(
      'Plan revision rejected: a plan is already registered. Pass a "reason" explaining why the plan changed.',
    );
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "write_to_file"), reason: "need a file" })).toMatch(/^Intent revised \(revision 2\)/);
    expect(await h.tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "view_file"), reason: "r2" })).toMatch(/^Intent revised \(revision 3\)/);
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "run_command"), reason: "r3" })).toBe(
      "Plan revision rejected: at most 2 revisions are allowed per user message. Continue with the current plan or ask the user how to proceed.",
    );
    h.registry.beginTurn(conversationKey(A));
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "run_command"), reason: "r3" })).toMatch(/^Intent revised \(revision 4\)/);
  });

  test("a revision re-anchors the old plan and writes a held plan_revision row", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    const old = h.registry.root(conversationKey(A))!.plan!;
    await h.tools.handle(A, "register_intent_plan", { ...plan("g", "write_to_file"), reason: "need a file" });
    await h.tools.settled();
    const next = h.registry.root(conversationKey(A))!.plan!;
    expect(h.reanchors).toEqual([{ planId: "plan-1", reason: "need a file" }]);
    expect(h.audit).toEqual([
      {
        plan_id: "plan-2",
        session_id: "conv-a",
        agent_id: "antigravity",
        client_id: "armorantigravity",
        user_id: "user-1",
        step_index: -1,
        action: "plan_revision",
        tool: "register_intent_plan",
        input: { reason: "need a file", old_plan_id: "plan-1", old_plan_hash: old.hash, new_plan_hash: next.hash, revision: 2, trust_id: "trust-1" },
        status: "held",
        error_message: "plan_revision: need a file",
        executed_at: expect.any(String),
      },
    ]);
  });

  test("a step the local policy forbids rejects the whole plan", async () => {
    const policy: PolicyView = {
      hash: "h",
      intentRequired: true,
      evaluate: (tool) => (tool === "run_command" ? { effect: "forbid", ruleId: "no-shell", reason: "shell is off" } : { effect: "permit", ruleId: null, reason: "" }),
    };
    const h = harness({ policy });
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "write_to_file", "Bash"))).toBe(
      "Plan rejected: step 2 uses run_command, which the current policy forbids (rule no-shell): shell is off",
    );
    expect(h.mints).toEqual([]);
    expect(h.registry.root(conversationKey(A))?.plan).toBeNull();
  });

  test("logged out, the plan is kept locally with an empty id and nothing is minted", async () => {
    const h = harness({ login: null });
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe(
      "Intent recorded locally: 1 steps. ArmorIQ is not logged in, so calls are monitored, not enforced.",
    );
    expect(h.registry.root(conversationKey(A))?.plan?.id).toBe("");
    expect(h.mints).toEqual([]);
  });

  test("revoke is refused while a registration is minting", async () => {
    const h = harness({ gate: true });
    const pending = h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    await Bun.sleep(0);
    expect(await h.tools.handle(A, "trust_revoke", { reason: "stop" })).toBe(
      "A plan registration is in progress for this conversation. Revoke after it finishes.",
    );
    h.release();
    await pending;
    expect(h.revokes).toEqual([]);
  });

  test("delegate rejects a validitySeconds the MCP schema would reject, before calling the backend", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(await h.tools.handle(A, "trust_delegate", { delegatePublicKey: "k", subtreePath: "/steps/[0]", validitySeconds: 0 })).toBe(
      "Delegate rejected: validitySeconds must be a positive integer.",
    );
  });

  test("revoke clears the plan after the backend revokes it", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(await h.tools.handle(A, "trust_revoke", { reason: "done" })).toBe(
      "Intent token revoked. Side-effecting calls are blocked until a new plan is registered.",
    );
    expect(h.revokes).toEqual([{ planId: "plan-1", reason: "done" }]);
    expect(h.registry.root(conversationKey(A))?.plan).toBeNull();
  });
});

describe("subagents", () => {
  const CHILD: ConversationRef = { surface: "cli", conversationId: "child-1" };

  test("a child cannot register, revoke or delegate, and is checked against the root plan", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(h.registry.link(CHILD, A)).toBe(true);
    expect(await h.tools.handle(CHILD, "register_intent_plan", plan("mine", "write_to_file"))).toBe(
      "This is a subagent conversation. It inherits the plan registered by its parent and cannot register its own. Continue within the parent plan.",
    );
    expect(await h.tools.handle(CHILD, "trust_revoke", { reason: "x" })).toBe(
      "This is a subagent conversation; its plan belongs to the parent conversation and cannot be revoked here.",
    );
    expect(await h.tools.handle(CHILD, "trust_delegate", { delegatePublicKey: "k", subtreePath: "/steps/[0]" })).toBe(
      "This is a subagent conversation; only the parent conversation can delegate its plan.",
    );
    const root = h.registry.root(conversationKey(CHILD));
    expect(root?.key).toBe(conversationKey(A));
    expect(checkIntent({ root, tool: "run_command", args: {}, readOnly: false, now: Date.now() })).toEqual({ kind: "allow", stepIndex: 0, paramMismatch: false });
  });

  test("a link never forms a cycle", () => {
    const h = harness();
    expect(h.registry.link(CHILD, A)).toBe(true);
    expect(h.registry.link(A, CHILD)).toBe(false);
  });
});

describe("MCP outcome hand-off", () => {
  test("the MCP server gets the hook's outcome for the same arguments, in any key order", async () => {
    const h = harness();
    const text = await h.tools.handle(A, "policy_read", { tool: "run_command" });
    expect(text).toBe("Policy hash: policy-hash\nIntent plan required: yes\nMode: enforce\nrun_command: permit");
    expect(await h.tools.outcome("policy_read", { tool: "run_command" }, 10)).toBe(text);
    expect(await h.tools.outcome("policy_read", { tool: "run_command" }, 10)).toBeNull();
  });

  test("the same call from two conversations at once hands neither conversation's text to the other", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("a", "run_command"));
    await h.tools.handle(A, "policy_read", {});
    const b = await h.tools.handle(B, "policy_read", {});
    expect(await h.tools.outcome("policy_read", {}, 10)).toBe(AMBIGUOUS_OUTCOME);
    expect(await h.tools.outcome("policy_read", {}, 10)).toBe(b);
  });

  test("an MCP request that arrives first waits for the hook", async () => {
    const h = harness();
    const pending = h.tools.outcome("trust_revoke", { reason: "x" }, 1000);
    await h.tools.handle(A, "trust_revoke", { reason: "x" });
    expect(await pending).toBe("No registered plan to revoke.");
  });

  test("digests ignore key order", () => {
    expect(callDigest("trust_revoke", { a: 1, b: { c: 2, d: 3 } })).toBe(callDigest("trust_revoke", { b: { d: 3, c: 2 }, a: 1 }));
  });

  test("a duplicate PreToolUse for the same step acts once and publishes one outcome", async () => {
    const h = harness();
    const first = await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"), 4);
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"), 4)).toBe(first);
    expect(h.mints.length).toBe(1);
    expect(await h.tools.outcome("register_intent_plan", plan("g", "run_command"), 10)).toBe(first);
    expect(await h.tools.outcome("register_intent_plan", plan("g", "run_command"), 10)).toBeNull();
  });

  test("own tools are recognized bare or with the server prefix", () => {
    expect(ownToolName("register_intent_plan")).toBe("register_intent_plan");
    expect(ownToolName("mcp_armoriq_register_intent_plan")).toBe("register_intent_plan");
    expect(ownToolName("mcp__armoriq__trust_delegate")).toBe("trust_delegate");
    expect(ownToolName("run_command")).toBeNull();
  });
});
