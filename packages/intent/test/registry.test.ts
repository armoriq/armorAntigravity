import { describe, expect, test } from "bun:test";
import { createRegistry } from "../src/registry.ts";
import { conversationKey, type Plan, type Token } from "../src/types.ts";
import { LOGIN } from "./helpers.ts";

const REF = { surface: "cli" as const, conversationId: "root" };
const KEY = conversationKey(REF);
const plan: Plan = { id: "plan-1", hash: "hash", goal: "work", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "prompt" };
const token: Token = { status: "active", jwt: "test", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() };

describe("prompt session state", () => {
  test("a new prompt clears the previous plan and its request state", () => {
    const registry = createRegistry(() => 100);
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    registry.setPlan(KEY, plan, token);
    expect(registry.get(KEY)).toMatchObject({ countedPlanId: "plan-1", tokenPlanId: "plan-1", planHash: "hash", kind: "new", tokenExpiresAt: 9e12 });
    registry.beginPrompt(KEY, 5);
    expect(registry.get(KEY)).toMatchObject({
      promptGeneration: 2, promptOpenSince: 100, lastActivityAt: 100, plan: null, token: null,
      countedPlanId: null, tokenPlanId: null, planHash: null, kind: null, tokenExpiresAt: null,
      pendingRequest: null, unregisteredLocalPlan: null, revisionsThisTurn: 0,
    });
  });

  test("duplicate prompt hooks preserve the installed plan and revision count", () => {
    const registry = createRegistry();
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    registry.setPlan(KEY, plan, token);
    registry.noteRevision(KEY);
    registry.beginPrompt(KEY, 0);
    expect(registry.get(KEY)?.plan).toBe(plan);
    expect(registry.get(KEY)?.revisionsThisTurn).toBe(1);
  });

  test("a result installs only in the prompt and auth generations that requested it", () => {
    const registry = createRegistry();
    registry.syncAuth(LOGIN, "enforce");
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    const first = registry.generation(KEY)!;
    registry.beginPrompt(KEY, 7);
    expect(registry.setPlan(KEY, plan, token, first)).toBe(false);
    const second = registry.generation(KEY)!;
    registry.syncAuth(null, "monitor");
    expect(registry.setPlan(KEY, plan, token, second)).toBe(false);
    expect(registry.setToken(KEY, token, second)).toBe(false);
    const current = registry.generation(KEY)!;
    expect(registry.setPlan(KEY, plan, token, current)).toBe(true);
  });

  test("closing and reopening a conversation drops a result for its old state", () => {
    const registry = createRegistry();
    registry.open(REF);
    const old = registry.generation(KEY)!;
    registry.close(KEY);
    registry.open(REF);
    expect(registry.setPlan(KEY, plan, token, old)).toBe(false);
  });

  test("unchanged credential values preserve state, while a changed organization retires it", () => {
    const registry = createRegistry();
    registry.syncAuth({ ...LOGIN, orgId: "org-a" }, "enforce");
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    registry.setPlan(KEY, plan, token);
    registry.syncAuth({ ...LOGIN, orgId: "org-a" }, "enforce");
    expect(registry.get(KEY)?.plan).toBe(plan);
    expect(registry.get(KEY)?.authGeneration).toBe(0);
    registry.syncAuth({ ...LOGIN, orgId: "org-b" }, "enforce");
    expect(registry.get(KEY)?.plan).toBeNull();
    expect(registry.get(KEY)?.authGeneration).toBe(1);
  });

  test("one root operation at a time leaves other conversations free", () => {
    const registry = createRegistry();
    registry.open(REF);
    const other = registry.open({ ...REF, conversationId: "other" }).key;
    const release = registry.acquire(KEY)!;
    expect(registry.acquire(KEY)).toBeNull();
    const releaseOther = registry.acquire(other)!;
    expect(releaseOther).toBeFunction();
    release();
    const next = registry.acquire(KEY)!;
    release();
    expect(registry.busy(KEY)).toBe(true);
    next();
    releaseOther();
    expect(registry.busy(KEY)).toBe(false);
    expect(registry.busy(other)).toBe(false);
  });
});
