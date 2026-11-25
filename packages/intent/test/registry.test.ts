import { describe, expect, test } from "bun:test";
import { createRegistry } from "../src/registry.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey, type Plan, type Token } from "../src/types.ts";
import { LOGIN } from "./helpers.ts";

const REF = { surface: "cli" as const, conversationId: "root" };
const KEY = conversationKey(REF);
const plan: Plan = { id: "plan-1", hash: "hash", goal: "work", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "prompt" };
const token: Token = { status: "active", jwt: "test", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() };

describe("prompt session state", () => {
  test("closing a parent keeps its running child attached and unable to become a root", () => {
    const registry = createRegistry();
    const child = { ...REF, conversationId: "child" };
    registry.link(child, REF);
    registry.close(KEY);
    registry.beginPrompt(conversationKey(child), 0);
    expect(registry.get(conversationKey(child))).toMatchObject({ parent: KEY, promptId: null });
    expect(registry.root(conversationKey(child))).toBeNull();
  });

  test("retirements advance the epoch within a prompt and a new prompt resets it", () => {
    const registry = createRegistry();
    registry.syncAuth(LOGIN, "enforce");
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    expect(registry.get(KEY)?.retirementEpoch).toBe(0);
    registry.setPlan(KEY, plan, token);
    const retired = registry.generation(KEY)!;
    registry.clearPlan(KEY);
    expect(registry.get(KEY)?.retirementEpoch).toBe(1);
    expect(registry.setToken(KEY, token, retired)).toBe(false);
    registry.syncAuth(null, "monitor");
    registry.syncAuth(LOGIN, "enforce");
    expect(registry.get(KEY)?.retirementEpoch).toBe(3);
    registry.beginPrompt(KEY, 8);
    expect(registry.get(KEY)?.retirementEpoch).toBe(0);
  });

  test("linking a possible child clears its provisional prompt and fences late results", () => {
    const registry = createRegistry();
    const child = { ...REF, conversationId: "child" };
    const key = registry.open(child).key;
    registry.beginPrompt(key, 0);
    const generation = registry.generation(key)!;
    expect(registry.link(child, REF)).toBe(true);
    expect(registry.get(key)).toMatchObject({ promptId: null, promptOpenSince: null });
    expect(registry.setPlan(key, plan, token, generation)).toBe(false);
  });

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
test("request state is durable before send and is retired on a restored auth change", () => {
  const dir = mkdtempSync(join(tmpdir(), "intent-state-"));
  const file = join(dir, "state.json");
  try {
    const registry = createRegistry(Date.now, file);
    registry.syncAuth(LOGIN, "enforce");
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    const request = { key: "pcc1:key", headers: { "X-ArmorIQ-Plan-Kind": "new" }, body: { plan: { goal: "g" } } };
    registry.setPendingRequest(KEY, request, registry.generation(KEY)!);
    expect(readFileSync(file, "utf8")).not.toContain(LOGIN.apiKey);
    const restored = createRegistry(Date.now, file);
    restored.syncAuth(LOGIN, "enforce");
    expect(restored.get(KEY)?.pendingRequest).toEqual(request);
    expect(restored.get(KEY)?.promptId).toBe(registry.get(KEY)?.promptId);
    restored.syncAuth(null, "monitor");
    expect(restored.get(KEY)?.pendingRequest).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity after thirty idle minutes cannot reopen the old prompt", () => {
  let clock = 0;
  const registry = createRegistry(() => clock);
  registry.open(REF);
  registry.beginPrompt(KEY, 0);
  clock = 30 * 60_000;
  registry.open(REF);
  expect(registry.get(KEY)?.promptOpenSince).toBeNull();
  registry.beginPrompt(KEY, 8);
  expect(registry.get(KEY)?.promptOpenSince).toBe(clock);
});

for (const text of ["{broken", JSON.stringify({ v: 2, conversations: [], authIdentity: "future" }), JSON.stringify({ v: 1, conversations: [] })]) {
  test("an invalid state file is preserved and reported before starting with empty state", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-invalid-"));
    const file = join(dir, "state.json");
    const warnings: string[] = [];
    try {
      writeFileSync(file, text);
      const registry = createRegistry(Date.now, file, { warn: message => { warnings.push(message); } });
      expect([...registry.all()]).toEqual([]);
      const backup = readdirSync(dir).find(name => name.startsWith("state.json.invalid."));
      expect(backup).toBeDefined();
      expect(readFileSync(join(dir, backup!), "utf8")).toBe(text);
      expect(warnings).toHaveLength(1);
      registry.syncAuth(LOGIN, "enforce");
      expect(createRegistry(Date.now, file).open(REF).plan).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the retirement epoch survives a restart and older state starts at zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "intent-epoch-"));
  const file = join(dir, "state.json");
  try {
    const registry = createRegistry(Date.now, file);
    registry.syncAuth(LOGIN, "enforce");
    registry.open(REF);
    registry.beginPrompt(KEY, 0);
    registry.setPlan(KEY, plan, token);
    registry.clearPlan(KEY);
    expect(createRegistry(Date.now, file).get(KEY)?.retirementEpoch).toBe(1);
    const old = JSON.parse(readFileSync(file, "utf8"));
    delete old.conversations[0].conversation.retirementEpoch;
    writeFileSync(file, JSON.stringify(old));
    expect(createRegistry(Date.now, file).get(KEY)?.retirementEpoch).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
