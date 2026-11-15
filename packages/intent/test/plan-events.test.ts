import { expect, test } from "bun:test";
import { createOwnTools } from "../src/own-tools.ts";
import { createRegistry } from "../src/registry.ts";
import type { CallResult, Minted } from "../src/types.ts";
import { harness, LOGIN, permitAll, recordingBackend, silentLog } from "./helpers.ts";

// Import inside the test so the initial failure identifies the missing event API.
test("plan successes emit once for local and minted register and reanchor, never for refusals or duplicate hooks", async () => {
  const events = await import("../src/plan-events.ts").catch(() => null);
  expect(events?.onPlanSuccess).toBeFunction();
  if (!events) return;
  let successes = 0;
  const off = events.onPlanSuccess(() => successes++);
  const ref = { surface: "cli" as const, conversationId: "events" };
  const plan = { goal: "test", steps: [{ action: "run_command" }] };
  try {
    for (const login of [null, undefined]) {
      const h = harness(login === null ? { login } : {});
      const before = successes;
      await h.tools.handle(ref, "register_intent_plan", {}, 0);
      await h.tools.handle(ref, "trust_reanchor", { updatedPlan: plan, reason: "missing" }, 1);
      expect(successes).toBe(before);
      const first = await h.tools.handle(ref, "register_intent_plan", plan, 2);
      expect(first).toMatch(/Intent (registered|recorded locally)/);
      expect(successes).toBe(before + 1);
      await h.tools.handle(ref, "register_intent_plan", plan, 2);
      expect(successes).toBe(before + 1);
      await h.tools.handle(ref, "trust_reanchor", { updatedPlan: plan, reason: "change" }, 3);
      expect(successes).toBe(before + 2);
      await h.tools.handle(ref, "trust_revoke", { reason: "done" }, 4);
      await h.tools.handle(ref, "policy_read", {}, 5);
      expect(successes).toBe(before + 2);
      await h.tools.settled();
    }
    const refused = harness({ policy: { hash: "off", intentRequired: true, evaluate: () => ({ effect: "forbid", ruleId: "off", reason: "off" }) } });
    const before = successes;
    await refused.tools.handle(ref, "register_intent_plan", plan);
    expect(successes).toBe(before);
  } finally {
    off();
  }
});

test("a failing plan listener never changes a successful plan reply and unsubscribe removes it", async () => {
  const events = await import("../src/plan-events.ts").catch(() => null);
  expect(events?.onPlanSuccess).toBeFunction();
  if (!events) return;
  let calls = 0;
  const off = events.onPlanSuccess(() => { calls++; throw new Error("listener failed"); });
  const h = harness({ login: null });
  const ref = { surface: "cli" as const, conversationId: "listener" };
  const plan = { goal: "test", steps: [{ action: "run_command" }] };
  try {
    expect(await h.tools.handle(ref, "register_intent_plan", plan)).toMatch(/^Intent recorded locally/);
    expect(calls).toBe(1);
  } finally { off(); }
  await h.tools.handle(ref, "register_intent_plan", plan);
  expect(calls).toBe(1);
});

test("mint errors, refused tokens, and policy or child refusals never emit plan success", async () => {
  const { onPlanSuccess } = await import("../src/plan-events.ts");
  let successes = 0;
  const off = onPlanSuccess(() => successes++);
  const ref = { surface: "cli" as const, conversationId: "refusal" };
  const plan = { goal: "test", steps: [{ action: "run_command" }] };
  try {
    const replies: CallResult<Minted>[] = [
      { ok: false, retryable: true, reason: "unavailable" },
      { ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" } } },
      { ok: true, value: { planId: "", token: { status: "refused", code: "billing_blocked" } } },
    ];
    for (const reply of replies) {
      const tools = createOwnTools({
        registry: createRegistry(), backend: { ...recordingBackend().backend, mint: async () => reply },
        login: () => LOGIN, mode: () => "enforce", policy: () => permitAll, audit() {}, log: silentLog,
      });
      expect(await tools.handle(ref, "register_intent_plan", plan)).toMatch(/^Plan not registered/);
    }
    expect(successes).toBe(0);
    const h = harness();
    await h.tools.handle(ref, "register_intent_plan", plan);
    const child = { surface: "cli" as const, conversationId: "child" };
    h.registry.link(child, ref);
    await h.tools.handle(child, "register_intent_plan", plan);
    await h.tools.handle(ref, "trust_reanchor", { updatedPlan: plan });
    expect(successes).toBe(1);
  } finally { off(); }
});
