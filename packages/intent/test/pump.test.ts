import { describe, expect, test } from "bun:test";
import { createTokenPump } from "../src/pump.ts";
import { createRegistry } from "../src/registry.ts";
import { conversationKey, type CallResult, type IntentBackend, type Minted, type Plan } from "../src/types.ts";
import { LOGIN, silentLog } from "./helpers.ts";

const REF = { surface: "app" as const, conversationId: "conv-1" };
const KEY = conversationKey(REF);
const plan: Plan = { id: "plan-1", hash: "h", goal: "g", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "turn-1" };

function setup(mintResult: () => CallResult<Minted>) {
  let clock = 1_000_000;
  const now = () => clock;
  const registry = createRegistry(now);
  const mints: string[] = [];
  const revokes: { planId: string; reason: string }[] = [];
  let beforeMintReturns: () => void = () => {};
  const backend: IntentBackend = {
    async mint(_l, _p, contextId) {
      mints.push(contextId);
      beforeMintReturns();
      return mintResult();
    },
    async reanchor() {
      return { ok: true, value: { trustId: null } };
    },
    async revoke(_l, planId, reason) {
      revokes.push({ planId, reason });
      return { ok: true, value: undefined };
    },
    async delegate() {
      return { ok: false, retryable: false, reason: "unused" };
    },
  };
  const pump = createTokenPump({ registry, backend, login: () => LOGIN, log: silentLog, now, idleAfterStopMs: 1000 });
  registry.open(REF);
  const token = (expiresAt: number) => ({ status: "active" as const, jwt: "j", expiresAt, deniedTools: new Set<string>(), heldTools: new Set<string>() });
  registry.setPlan(KEY, plan, token(clock + 3_600_000));
  const cycle = async () => {
    pump.kick();
    await Bun.sleep(5);
  };
  return {
    registry,
    pump,
    mints,
    revokes,
    cycle,
    token,
    advance: (ms: number) => (clock += ms),
    now,
    onMint: (f: () => void) => (beforeMintReturns = f),
  };
}

describe("token pump", () => {
  test("re-mints within 60 s of expiry with the raw conversationId and keeps the step cursor", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "plan-2", token: { status: "active", jwt: "j2", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.registry.advance(KEY, 0);
    await s.cycle();
    expect(s.mints).toEqual([]);
    s.advance(3_600_000 - 59_000);
    await s.cycle();
    expect(s.mints).toEqual(["conv-1"]);
    expect(s.registry.get(KEY)?.plan?.id).toBe("plan-2");
    expect(s.registry.get(KEY)?.stepCursor).toBe(1);
  });

  test("backs off 15 s, then 30 s, after failures", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "HTTP 503" }));
    s.advance(3_600_000 - 30_000);
    await s.cycle();
    await s.cycle();
    expect(s.mints.length).toBe(1);
    s.advance(15_000);
    await s.cycle();
    expect(s.mints.length).toBe(2);
    s.advance(15_000);
    await s.cycle();
    expect(s.mints.length).toBe(2);
    s.advance(15_000);
    await s.cycle();
    expect(s.mints.length).toBe(3);
  });

  test("a plan replaced while the mint ran has its new plan id revoked", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "plan-stale", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.onMint(() => s.registry.setPlan(KEY, { ...plan, id: "plan-new", hash: "h2" }, s.token(9e12)));
    s.advance(3_600_000 - 10_000);
    await s.cycle();
    expect(s.revokes).toEqual([{ planId: "plan-stale", reason: "plan replaced during token refresh" }]);
    expect(s.registry.get(KEY)?.plan?.id).toBe("plan-new");
  });

  test("after a Stop, the idle timeout counts from the last hook and then revokes and clears the plan", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    await s.cycle();
    s.advance(5000);
    await s.cycle();
    expect(s.revokes).toEqual([]);
    s.pump.noteStop(KEY);
    s.advance(500);
    s.registry.open(REF);
    s.advance(900);
    await s.cycle();
    expect(s.revokes).toEqual([]);
    s.advance(200);
    await s.cycle();
    expect(s.revokes).toEqual([{ planId: "plan-1", reason: "antigravity conversation idle" }]);
    expect(s.registry.get(KEY)?.plan).toBeNull();
  });

  test("a subagent calling tools after the parent's Stop keeps the parent's plan alive", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    const child = { surface: "app" as const, conversationId: "child-1" };
    s.registry.link(child, REF);
    s.pump.noteStop(KEY);
    s.advance(800);
    s.registry.open(child);
    s.advance(800);
    await s.cycle();
    expect(s.revokes).toEqual([]);
    expect(s.registry.get(KEY)?.plan?.id).toBe("plan-1");
    s.advance(300);
    await s.cycle();
    expect(s.revokes).toEqual([{ planId: "plan-1", reason: "antigravity conversation idle" }]);
  });

  test("a refresh that completes after shutdown revokes the plan id it minted", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "plan-late", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    let stopping: Promise<void> = Promise.resolve();
    s.onMint(() => {
      stopping = s.pump.stop();
    });
    s.advance(3_600_000 - 10_000);
    await s.cycle();
    await stopping;
    expect(s.revokes).toEqual([
      { planId: "plan-1", reason: "armoriq-agd shutting down" },
      { planId: "plan-late", reason: "armoriq-agd shutting down" },
    ]);
  });

  test("shutdown revokes every live plan", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    await s.pump.stop();
    expect(s.revokes).toEqual([{ planId: "plan-1", reason: "armoriq-agd shutting down" }]);
  });
});
