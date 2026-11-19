import { describe, expect, test } from "bun:test";
import { checkIntent } from "../src/decision.ts";
import { AMBIGUOUS_OUTCOME, callDigest, createOwnTools, ownToolName } from "../src/own-tools.ts";
import { createRegistry } from "../src/registry.ts";
import { conversationKey, type ConversationRef, type IntentBackend, type Login, type Minted, type Mode, type PolicyView } from "../src/types.ts";
import { createTokenPump } from "../src/pump.ts";
import { harness, LOGIN, permitAll, recordingBackend, silentLog } from "./helpers.ts";
import { planHash, requestKey } from "../src/plan-request.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(await Promise.all([ra, rb])).toEqual([expect.stringMatching(/^Intent registered: plan plan-1 \(new\), 1 steps\./), expect.stringMatching(/^Intent registered: plan plan-2 \(new\), 1 steps\./)]);

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
  test("an injected validity is stable when the environment changes after startup", async () => {
    const previous = process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
    const registry = createRegistry();
    const rec = recordingBackend();
    let tools: ReturnType<typeof createOwnTools>;
    try {
      process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = "3600";
      tools = createOwnTools({ registry, backend: rec.backend, login: () => LOGIN, mode: () => "enforce", validitySeconds: 180, policy: () => permitAll, audit() {}, log: silentLog });
    } finally {
      if (previous === undefined) delete process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
      else process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = previous;
    }
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    await tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(rec.mints[0]?.request.body.expires_in).toBe(180);
  });

  test.each(["logged_out", "monitor_mode"])("reanchor records a local plan in %s", async state => {
    const registry = createRegistry();
    const rec = recordingBackend();
    const tools = createOwnTools({ registry, backend: rec.backend, login: () => state === "logged_out" ? null : LOGIN, mode: () => "monitor", policy: () => permitAll, audit() {}, log: silentLog });
    expect(await tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "run_command"), reason: "changed" })).toBe(`Plan recorded locally, not registered (${state}).`);
    expect(registry.get(conversationKey(A))?.unregisteredLocalPlan?.goal).toBe("g");
    expect(rec.mints).toEqual([]);
  });

  test("a confirmed reply keeps the denied and held tool guidance", async () => {
    const h = harness();
    const args = plan("g", "run_command");
    await h.tools.handle(A, "register_intent_plan", args);
    h.registry.setToken(conversationKey(A), { status: "active", jwt: "jwt", expiresAt: 9e12, deniedTools: new Set(["write_to_file"]), heldTools: new Set(["run_command"]) });
    const reply = await h.tools.handle(A, "register_intent_plan", args);
    expect(reply).toStartWith("Intent registered: plan plan-1 (new), 1 steps.");
    expect(reply).toContain("Denied by backend: write_to_file");
    expect(reply).toContain("Held for approval by backend: run_command");
  });

  for (const retirement of ["revoke", "mode", "login"] as const) {
    test(`the same plan after ${retirement} cannot replay a retired backend response`, async () => {
      let clock = Date.now();
      let login: Login | null = LOGIN;
      let mode: Mode = "enforce";
      const registry = createRegistry(() => clock);
      registry.syncAuth(login, mode);
      registry.open(A);
      registry.beginPrompt(conversationKey(A), 0);
      const ledger = new Map<string, Minted>();
      const keys: string[] = [];
      const backend: IntentBackend = { ...recordingBackend().backend, async mint(_login, _draft, _context, request) {
        keys.push(request.key);
        let value = ledger.get(request.key);
        if (!value) {
          value = { planId: `plan-${ledger.size + 1}`, token: { status: "active", jwt: "jwt", expiresAt: clock + 180_000, deniedTools: new Set(), heldTools: new Set() } };
          ledger.set(request.key, value);
        }
        return { ok: true, value };
      } };
      const tools = createOwnTools({ registry, backend, login: () => login, mode: () => mode, now: () => clock, policy: () => permitAll, audit() {}, log: silentLog });
      const args = plan("same plan", "run_command");
      await tools.handle(A, "register_intent_plan", args);
      const promptId = registry.get(conversationKey(A))!.promptId;
      if (retirement === "revoke") await tools.handle(A, "trust_revoke", { reason: "retire this plan" });
      if (retirement === "mode") {
        mode = "monitor";
        registry.syncAuth(login, mode);
        mode = "enforce";
        registry.syncAuth(login, mode);
      }
      if (retirement === "login") {
        login = null;
        registry.syncAuth(login, mode);
        clock += 180_001;
        login = LOGIN;
        registry.syncAuth(login, mode);
      }
      expect(await tools.handle(A, "register_intent_plan", args)).toStartWith("Intent registered: plan plan-2 (new)");
      expect(keys[1]).not.toBe(keys[0]);
      expect(registry.get(conversationKey(A))?.promptId).toBe(promptId);
    });
  }

  for (const operation of ["trust_revoke", "trust_delegate", "trust_reanchor"] as const) {
    test(`${operation} after a refresh targets the live token while revisions retain the counted parent`, async () => {
      let clock = Date.now();
      const registry = createRegistry(() => clock);
      const rec = recordingBackend({ now: () => clock });
      const delegated: string[] = [];
      const backend: IntentBackend = { ...rec.backend, async delegate(login, planId, request) {
        delegated.push(planId);
        return rec.backend.delegate(login, planId, request);
      } };
      const tools = createOwnTools({ registry, backend, login: () => LOGIN, mode: () => "enforce", now: () => clock, policy: () => permitAll, audit() {}, log: silentLog });
      registry.open(A);
      registry.beginPrompt(conversationKey(A), 0);
      await tools.handle(A, "register_intent_plan", plan("g", "run_command"));
      const pump = createTokenPump({ registry, backend, login: () => LOGIN, now: () => clock, log: silentLog });
      clock += 1000;
      registry.setToken(conversationKey(A), { status: "active", jwt: "expired", expiresAt: clock, deniedTools: new Set(), heldTools: new Set() });
      await pump.beforeTool(conversationKey(A));
      expect(registry.get(conversationKey(A))?.tokenPlanId).toBe("plan-2");
      const args = operation === "trust_reanchor" ? { updatedPlan: plan("changed", "run_command"), reason: "changed" }
        : operation === "trust_delegate" ? { delegatePublicKey: "public", subtreePath: "/steps/[0]" } : { reason: "done" };
      await tools.handle(A, operation, args);
      await tools.settled();
      if (operation === "trust_revoke") expect(rec.revokes).toContainEqual({ planId: "plan-2", reason: "done" });
      if (operation === "trust_delegate") expect(delegated).toEqual(["plan-2"]);
      if (operation === "trust_reanchor") {
        expect(rec.reanchors).toEqual([{ planId: "plan-2", reason: "changed" }]);
        expect(rec.mints[2]?.request.headers["X-ArmorIQ-Parent-Plan-Id"]).toBe("plan-1");
      }
      await pump.stop();
    });
  }

  for (const tool of ["register_intent_plan", "trust_reanchor"] as const) {
    test(`settled waits for the background ${tool} registration`, async () => {
      const h = harness({ gate: true });
      if (tool === "trust_reanchor") {
        const initial = h.tools.handle(A, "register_intent_plan", plan("initial", "run_command"));
        h.release();
        await initial;
      }
      const updated = plan("slow registration", "run_command");
      const pending = h.tools.handle(A, tool, tool === "trust_reanchor" ? { updatedPlan: updated, reason: "changed task" } : updated);
      let finished = false;
      const settled = h.tools.settled().then(() => { finished = true; });
      try {
        await Bun.sleep(0);
        expect(finished).toBe(false);
      } finally {
        h.release();
        await Promise.all([pending, settled]);
      }
      expect(finished).toBe(true);
      expect(h.registry.get(conversationKey(A))?.countedPlanId).toBe(tool === "trust_reanchor" ? "plan-2" : "plan-1");
    });
  }

  test("after a restart the retry sends the saved body even when policy and validity changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-retry-"));
    const file = join(dir, "state.json");
    try {
      const registry = createRegistry(Date.now, file);
      registry.syncAuth(LOGIN, "enforce");
      registry.open(A);
      registry.beginPrompt(conversationKey(A), 0);
      const first = createOwnTools({ registry, backend: { ...recordingBackend().backend, mint: async () => ({ ok: false, retryable: true, reason: "timeout" }) }, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, mintPolicy: () => ({ source: "first" }), validitySeconds: 180, audit() {}, log: silentLog });
      await first.handle(A, "register_intent_plan", plan("g", "run_command"));
      const saved = registry.get(conversationKey(A))!.pendingRequest!;
      const restored = createRegistry(Date.now, file);
      const rec = recordingBackend();
      const retry = createOwnTools({ registry: restored, backend: rec.backend, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, mintPolicy: () => ({ source: "changed" }), validitySeconds: 3600, audit() {}, log: silentLog });
      expect(await retry.handle(A, "register_intent_plan", plan("g", "run_command"))).toStartWith("Intent registered: plan plan-1 (new)");
      expect(rec.mints[0]?.request).toEqual(saved);
      expect(rec.mints[0]?.request.body.expires_in).toBe(180);
      expect(restored.get(conversationKey(A))?.pendingRequest).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("new, revision and reanchor send the prompt, counted parent and canonical plan key", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    const promptId = h.registry.get(conversationKey(A))!.promptId!;
    await h.tools.handle(A, "register_intent_plan", { ...plan("g", "write_to_file"), reason: "new work" });
    await h.tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "write_to_file"), reason: "reanchor the same plan" });
    expect(h.mints).toHaveLength(3);
    for (const [i, m] of h.mints.entries()) {
      const kind = i === 0 ? "new" : "revision";
      const parent = i === 0 ? null : `plan-${i}`;
      expect(m.request.headers).toEqual({ "Idempotency-Key": m.request.key, "X-ArmorIQ-Plan-Kind": kind, "X-ArmorIQ-Prompt-Id": promptId, ...(parent ? { "X-ArmorIQ-Parent-Plan-Id": parent } : {}) });
      expect(m.request.key).toBe(requestKey({ kind, promptId, parentPlanId: parent, planHash: planHash(m.request.body.plan) }));
    }
    expect(h.registry.get(conversationKey(A))?.revisionsThisTurn).toBe(2);
  });

  test("an expired or empty token never makes an identical plan a no op", async () => {
    for (const jwt of ["jwt", ""]) {
      const h = harness();
      await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
      h.registry.setToken(conversationKey(A), { status: "active", jwt, expiresAt: jwt ? 1 : 9e12, deniedTools: new Set(), heldTools: new Set() });
      expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toStartWith("Plan not registered:");
      await h.tools.handle(A, "register_intent_plan", { ...plan("g", "run_command"), reason: "replace unusable token" });
      expect(h.mints).toHaveLength(2);
      expect(h.mints[1]?.request.headers["X-ArmorIQ-Plan-Kind"]).toBe("revision");
    }
  });

  test("a different plan cannot replace an uncertain counted request", async () => {
    const registry = createRegistry();
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    let calls = 0;
    const tools = createOwnTools({ registry, backend: { ...recordingBackend().backend, async mint() { calls++; return { ok: false, retryable: true, reason: "timeout" }; } }, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: silentLog });
    await tools.handle(A, "register_intent_plan", plan("first", "run_command"));
    const pending = registry.get(conversationKey(A))?.pendingRequest;
    expect(await tools.handle(A, "register_intent_plan", plan("different", "write_to_file"))).toBe("Plan registration not confirmed: a different request is awaiting confirmation; retry that plan first. It will be retried with the same request id.");
    expect(calls).toBe(1);
    expect(registry.get(conversationKey(A))?.pendingRequest).toBe(pending);
  });

  test("a failed reanchor leaves its confirmed revision installed and logs the failure", async () => {
    const registry = createRegistry();
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    const rec = recordingBackend();
    const warnings: string[] = [];
    const tools = createOwnTools({ registry, backend: { ...rec.backend, reanchor: async () => ({ ok: false, retryable: false, reason: "unavailable" }) }, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: { ...silentLog, warn: text => warnings.push(text) } });
    await tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(await tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "run_command"), reason: "reanchor" })).toStartWith("Intent registered: plan plan-2 (revision)");
    await tools.settled();
    expect(registry.get(conversationKey(A))?.countedPlanId).toBe("plan-2");
    expect(warnings).toContain("reanchor failed");
  });

  test("without a prompt there is no backend registration or reanchor", async () => {
    const registry = createRegistry();
    const rec = recordingBackend();
    const tools = createOwnTools({ registry, backend: rec.backend, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: silentLog });
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe("Plan not registered: no current user prompt.");
    expect(await tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "run_command"), reason: "reanchor" })).toStartWith("Plan not registered:");
    expect(rec.mints).toEqual([]);
  });
  test("an identical confirmed plan is a no op with the exact committed reply", async () => {
    const h = harness();
    const first = await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    const state = h.registry.get(conversationKey(A))!;
    expect(first).toBe(`Intent registered: plan plan-1 (new), 1 steps. Token valid until ${new Date(state.tokenExpiresAt!).toISOString()}.`);
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe(first);
    expect(h.mints).toHaveLength(1);
  });

  test("forced monitor while logged in records an explicit local plan and sends nothing", async () => {
    const registry = createRegistry();
    const rec = recordingBackend();
    const tools = createOwnTools({ registry, backend: rec.backend, login: () => LOGIN, mode: () => "monitor", policy: () => permitAll, audit() {}, log: silentLog });
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe("Plan recorded locally, not registered (monitor_mode).");
    expect(rec.mints).toEqual([]);
    expect(registry.get(conversationKey(A))?.unregisteredLocalPlan?.goal).toBe("g");
    expect(registry.get(conversationKey(A))?.countedPlanId).toBeNull();
  });

  test("an uncertain request remains pending and the same plan resends its descriptor", async () => {
    const registry = createRegistry();
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    const descriptors: unknown[] = [];
    const tools = createOwnTools({ registry, backend: { ...recordingBackend().backend, async mint(...args) {
      descriptors.push(args[3]);
      expect(registry.get(conversationKey(A))?.pendingRequest).toBe(args[3]);
      return { ok: false, retryable: true, reason: "network error" };
    } }, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: silentLog });
    const expected = "Plan registration not confirmed: network error. It will be retried with the same request id.";
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe(expected);
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe(expected);
    expect(descriptors[0]).toBeDefined();
    expect(descriptors[1]).toBe(descriptors[0]);
  });

  test("a confirmed backend rejection uses the exact failure reply", async () => {
    const registry = createRegistry();
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    const tools = createOwnTools({ registry, backend: { ...recordingBackend().backend, mint: async () => ({ ok: false, retryable: false, reason: "org_required" }) }, login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: silentLog });
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe("Plan not registered: org_required.");
  });
  test("only one registration may be in flight per conversation", async () => {
    const h = harness({ gate: true });
    const first = h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    await Bun.sleep(0);
    expect(await h.tools.handle(A, "register_intent_plan", plan("g2", "run_command"))).toBe(
      "Plan not registered: A plan registration is already in progress for this conversation. Wait for it to finish.",
    );
    h.release();
    await first;
  });

  test("a revision needs a reason and at most two are allowed per user message", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "write_to_file"))).toBe(
      'Plan not registered: a plan is already registered. Pass a "reason" explaining why the plan changed.',
    );
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "write_to_file"), reason: "need a file" })).toMatch(/^Intent registered: plan plan-2 \(revision\)/);
    expect(await h.tools.handle(A, "trust_reanchor", { updatedPlan: plan("g", "view_file"), reason: "r2" })).toMatch(/^Intent registered: plan plan-3 \(revision\)/);
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "run_command"), reason: "r3" })).toBe(
      "Plan not registered: at most 2 revisions are allowed per user message.",
    );
    h.registry.beginPrompt(conversationKey(A), 7);
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toMatch(/^Intent registered:/);
    expect(await h.tools.handle(A, "register_intent_plan", { ...plan("g", "view_file"), reason: "next prompt revision" })).toMatch(/^Intent registered: plan plan-5 \(revision\)/);
  });

  test("a revision re-anchors the old plan without writing an audit row", async () => {
    const h = harness();
    await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"));
    const old = h.registry.root(conversationKey(A))!.plan!;
    await h.tools.handle(A, "register_intent_plan", { ...plan("g", "write_to_file"), reason: "need a file" });
    await h.tools.settled();
    const next = h.registry.root(conversationKey(A))!.plan!;
    expect(h.reanchors).toEqual([{ planId: "plan-1", reason: "need a file" }]);
    expect(next.id).not.toBe(old.id);
    expect(h.audit).toEqual([]);
  });

  test("a step the local policy forbids rejects the whole plan", async () => {
    const policy: PolicyView = {
      hash: "h",
      intentRequired: true,
      evaluate: (tool) => (tool === "run_command" ? { effect: "forbid", ruleId: "no-shell", reason: "shell is off" } : { effect: "permit", ruleId: null, reason: "" }),
    };
    const h = harness({ policy });
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "write_to_file", "Bash"))).toBe(
      "Plan not registered: step 2 uses run_command, which the current policy forbids (rule no-shell): shell is off.",
    );
    expect(h.mints).toEqual([]);
    expect(h.registry.root(conversationKey(A))?.plan).toBeNull();
  });

  test("logged out, the plan is kept locally with an empty id and nothing is minted", async () => {
    const h = harness({ login: null });
    expect(await h.tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe(
      "Plan recorded locally, not registered (logged_out).",
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
      "Plan not registered: This is a subagent conversation. It inherits the plan registered by its parent and cannot register its own. Continue within the parent plan.",
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

  test("digests ignore the toolAction and toolSummary Antigravity adds to hook args", () => {
    expect(callDigest("trust_revoke", { reason: "done", toolAction: "Revoking plan", toolSummary: "Revoke" })).toBe(callDigest("trust_revoke", { reason: "done" }));
    expect(callDigest("trust_revoke", { reason: "done" })).not.toBe(callDigest("trust_revoke", { reason: "other" }));
  });

  test("digests ignore key order", () => {
    expect(callDigest("register_intent_plan", { goal: "g", plan: { b: 1, c: 2 } })).toBe(callDigest("register_intent_plan", { plan: { c: 2, b: 1 }, goal: "g" }));
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

describe("a 401 on mint", () => {
  test("reports signed out instead of storing an account_revoked token", async () => {
    const registry = createRegistry();
    registry.open(A);
    registry.beginPrompt(conversationKey(A), 0);
    let unauthorized = 0;
    const tools = createOwnTools({
      registry,
      backend: { ...recordingBackend().backend, mint: async () => ({ ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" } } }) },
      login: () => LOGIN,
      mode: () => "enforce",
      policy: () => permitAll,
      audit: () => {},
      log: silentLog,
      onUnauthorized: () => unauthorized++,
    });
    expect(await tools.handle(A, "register_intent_plan", plan("g", "run_command"))).toBe("Plan not registered: account_revoked.");
    expect(unauthorized).toBe(1);
    expect(registry.root(conversationKey(A))?.token ?? null).toBeNull();
  });
});
