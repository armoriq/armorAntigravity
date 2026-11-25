import { describe, expect, test } from "bun:test";
import { createTokenPump } from "../src/pump.ts";
import { createRegistry, type PendingRequest } from "../src/registry.ts";
import { requestKey } from "../src/plan-request.ts";
import { conversationKey, type CallResult, type IntentBackend, type Login, type Minted, type Mode, type Plan } from "../src/types.ts";
import { LOGIN, silentLog } from "./helpers.ts";

const REF = { surface: "app" as const, conversationId: "conv-1" };
const KEY = conversationKey(REF);
const plan: Plan = { id: "plan-1", hash: "h", goal: "g", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "turn-1" };

function setup(mintResult: () => CallResult<Minted>, onUnauthorized?: () => void, options: { validitySeconds?: number; mode?: () => Mode; login?: () => Login | null } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const registry = createRegistry(now);
  const mints: string[] = [];
  const requests: PendingRequest[] = [];
  const revokes: { planId: string; reason: string }[] = [];
  let beforeMintReturns: () => void | Promise<void> = () => {};
  const backend: IntentBackend = {
    async mint(_l, _p, contextId, request) {
      mints.push(contextId);
      requests.push(request);
      expect(registry.get(KEY)?.pendingRequest).toBe(request);
      await beforeMintReturns();
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
  const pump = createTokenPump({ registry, backend, login: () => LOGIN, log: silentLog, now, idleAfterStopMs: 1000, ...options, ...(onUnauthorized ? { onUnauthorized } : {}) });
  registry.open(REF);
  registry.beginPrompt(KEY, 0);
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
    requests,
    revokes,
    cycle,
    token,
    advance: (ms: number) => {
      // Long running prompts keep producing hooks before the idle limit.
      while (ms > 15 * 60_000) {
        clock += 15 * 60_000;
        registry.open(REF);
        ms -= 15 * 60_000;
      }
      clock += ms;
    },
    idle: (ms: number) => { clock += ms; },
    now,
    onMint: (f: () => void | Promise<void>) => (beforeMintReturns = f),
  };
}

describe("token pump", () => {
  test("a slow pre tool refresh returns within the hook budget and stays single flight", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "refresh-1", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    let release!: () => void;
    s.onMint(() => new Promise<void>(resolve => { release = resolve; }));
    s.registry.setToken(KEY, s.token(s.now()));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const guards = Promise.all([s.pump.beforeTool(KEY), s.pump.beforeTool(KEY)]).then(() => "returned");
      const result = await Promise.race([guards, new Promise<string>(resolve => { timeout = setTimeout(() => resolve("hook still waiting"), 4000); })]);
      expect(result).toBe("returned");
      expect(s.mints).toHaveLength(1);
      expect(s.registry.get(KEY)?.tokenPlanId).toBe("plan-1");
    } finally {
      clearTimeout(timeout);
      release();
      await s.cycle();
      await s.pump.stop();
    }
  });

  for (const retirement of ["idle", "expired", "session_end", "shutdown"] as const) {
    test(`${retirement} revokes the live token after a refresh`, async () => {
      const s = setup(() => ({ ok: true, value: { planId: "refresh-1", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
      s.registry.setToken(KEY, s.token(s.now()));
      await s.pump.beforeTool(KEY);
      expect(s.registry.get(KEY)?.tokenPlanId).toBe("refresh-1");
      if (retirement === "shutdown") await s.pump.stop();
      if (retirement === "session_end") s.pump.revoke(KEY, "session ended");
      if (retirement === "idle") { s.pump.noteStop(KEY); s.idle(1001); await s.cycle(); }
      if (retirement === "expired") { s.idle(24 * 60 * 60_000); await s.cycle(); }
      expect(s.revokes.map(r => r.planId)).toContain("refresh-1");
    });
  }

  test("validity 180 refreshes at sixty seconds remaining with the fixture key", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "network error" }), undefined, { validitySeconds: 180 });
    const expiry = s.now() + 180_000;
    s.registry.setToken(KEY, s.token(expiry));
    s.advance(119_999);
    await s.cycle();
    expect(s.requests).toEqual([]);
    s.advance(1);
    await s.cycle();
    const request = s.requests[0]!;
    expect(request.headers).toEqual({ "Idempotency-Key": request.key, "X-ArmorIQ-Plan-Kind": "refresh", "X-ArmorIQ-Parent-Plan-Id": "plan-1", "X-ArmorIQ-Prompt-Id": s.registry.get(KEY)!.promptId! });
    expect(request.key).toBe(requestKey({ kind: "refresh", countedPlanId: "plan-1", tokenExpiresAt: new Date(expiry).toISOString() }));
    expect(request.body.expires_in).toBe(180);
    s.advance(15_000);
    await s.cycle();
    expect(s.requests[1]).toBe(request);
  });

  test("logged out never refreshes or runs the pre tool refresh", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }), undefined, { login: () => null });
    s.advance(3_600_001);
    s.registry.open(REF);
    await s.cycle();
    await s.pump.beforeTool(KEY);
    expect(s.mints).toEqual([]);
  });

  test("signed in, Monitor refreshes in the pump and before a tool exactly as Enforce does", async () => {
    const refreshed = { ok: true as const, value: { planId: "refresh-1", token: { status: "active" as const, jwt: "j", expiresAt: 9e12, deniedTools: new Set<string>(), heldTools: new Set<string>() } } };
    const s = setup(() => refreshed, undefined, { mode: () => "monitor" });
    s.advance(3_600_000 - 120_000);
    s.registry.open(REF);
    await s.cycle();
    expect(s.requests.map(r => r.headers["X-ArmorIQ-Plan-Kind"])).toEqual(["refresh"]);
    expect(s.registry.get(KEY)?.tokenPlanId).toBe("refresh-1");

    const guard = setup(() => refreshed, undefined, { mode: () => "monitor" });
    guard.advance(3_600_001);
    guard.registry.open(REF);
    await guard.pump.beforeTool(KEY);
    expect(guard.mints).toHaveLength(1);
    expect(guard.registry.get(KEY)?.tokenPlanId).toBe("refresh-1");
  });

  test("the tool guard joins the pump's in flight refresh", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "refresh-1", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    let release!: () => void;
    s.onMint(() => new Promise<void>(resolve => { release = resolve; }));
    s.advance(3_600_001);
    s.registry.open(REF);
    s.pump.kick();
    const guards = [s.pump.beforeTool(KEY), s.pump.beforeTool(KEY)];
    expect(s.mints).toHaveLength(1);
    release();
    await Promise.all(guards);
    expect(s.mints).toHaveLength(1);
    expect(s.registry.get(KEY)?.tokenPlanId).toBe("refresh-1");
  });

  test.each(["prompt", "auth"])("a late refresh cannot install after the %s generation changes", async change => {
    const s = setup(() => ({ ok: true, value: { planId: "refresh-late", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.onMint(() => { if (change === "prompt") s.registry.beginPrompt(KEY, 7); else s.registry.syncAuth(null, "monitor"); });
    s.advance(3_600_001);
    s.registry.open(REF);
    await s.cycle();
    expect(s.registry.get(KEY)?.token).toBeNull();
    expect(s.registry.get(KEY)?.countedPlanId).toBeNull();
  });

  test("a previous Stop cannot retire the next prompt", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    s.pump.noteStop(KEY);
    s.registry.beginPrompt(KEY, 8);
    s.registry.setPlan(KEY, plan, s.token(s.now() + 3_600_000));
    s.advance(1001);
    await s.cycle();
    expect(s.registry.get(KEY)?.countedPlanId).toBe("plan-1");
    expect(s.revokes).toEqual([]);
  });
  test("never refreshes after Stop even if a token is expired", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    s.registry.endPrompt(KEY);
    s.advance(3_600_001);
    await s.cycle();
    expect(s.mints).toEqual([]);
  });

  test("never refreshes a prompt idle for thirty minutes without Stop", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "unused" }));
    s.idle(3_600_001);
    await s.cycle();
    expect(s.mints).toEqual([]);
  });

  test("refresh keeps the counted plan and uses a linked durable descriptor", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "refresh-1", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.advance(3_600_000 - 120_000);
    s.registry.open(REF);
    await s.cycle();
    expect(s.mints).toHaveLength(1);
    expect(s.registry.get(KEY)).toMatchObject({ countedPlanId: "plan-1", tokenPlanId: "refresh-1", kind: "new" });
  });

  test("a pre tool guard refreshes an expired token once", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "refresh-1", token: { status: "active", jwt: "j", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.advance(3_600_001);
    s.registry.open(REF);
    await s.pump.beforeTool(KEY);
    await s.pump.beforeTool(KEY);
    expect(s.mints).toHaveLength(1);
    expect(s.registry.get(KEY)?.countedPlanId).toBe("plan-1");
  });
  test("a 401 on refresh signs out and retires the plan through the daemon auth path", async () => {
    let unauthorized = 0;
    let login: Login | null = LOGIN;
    const s = setup(() => ({ ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" } } }), () => { unauthorized++; login = null; }, { login: () => login, mode: () => login ? "enforce" : "monitor" });
    s.advance(3_600_000 - 59_000);
    s.registry.open(REF);
    await s.cycle();
    expect(s.mints).toEqual(["conv-1"]);
    expect(unauthorized).toBe(1);
    expect(s.registry.get(KEY)?.token).toBeNull();
    expect(s.registry.get(KEY)?.plan).toBeNull();
    expect(s.registry.get(KEY)?.retirementEpoch).toBe(1);
  });

  test("refreshes with the raw conversationId and keeps the counted plan and step cursor", async () => {
    const s = setup(() => ({ ok: true, value: { planId: "plan-2", token: { status: "active", jwt: "j2", expiresAt: 9e12, deniedTools: new Set(), heldTools: new Set() } } }));
    s.registry.advance(KEY, 0);
    await s.cycle();
    expect(s.mints).toEqual([]);
    s.advance(3_600_000 - 59_000);
    s.registry.open(REF);
    await s.cycle();
    expect(s.mints).toEqual(["conv-1"]);
    expect(s.registry.get(KEY)?.plan?.id).toBe("plan-1");
    expect(s.registry.get(KEY)?.tokenPlanId).toBe("plan-2");
    expect(s.registry.get(KEY)?.stepCursor).toBe(1);
  });

  test("backs off 15 s, then 30 s, after failures", async () => {
    const s = setup(() => ({ ok: false, retryable: true, reason: "HTTP 503" }));
    s.advance(3_600_000 - 30_000);
    s.registry.open(REF);
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
    s.onMint(() => { s.registry.setPlan(KEY, { ...plan, id: "plan-new", hash: "h2" }, s.token(9e12)); });
    s.advance(3_600_000 - 10_000);
    s.registry.open(REF);
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
    s.registry.open(REF);
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
