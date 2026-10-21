import type { Conversation, Registry } from "./registry.ts";
import type { ConversationKey, IntentBackend, Log, Login, Plan } from "./types.ts";

export const REFRESH_BEFORE_MS = 60_000;
export const CHECK_EVERY_MS = 15_000;
// ASSUMPTION(P0 #8): Antigravity has no conversation-deleted event, so a conversation counts as ended once it
// has had a Stop and then this long with no hook from it or its subagents. Replace with the trigger the spike settles on.
export const IDLE_AFTER_STOP_MS = 30 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
const RETRY_MAX_MS = 5 * 60_000;
// Long enough for one revoke: two attempts of 5 s each.
const STOP_WAIT_MS = 11_000;

export interface TokenPump {
  start(): void;
  kick(): void;
  noteStop(key: ConversationKey): void;
  revoke(key: ConversationKey, reason: string): void;
  // Revokes every live plan with cascade, then stops. Called when the daemon shuts down.
  stop(): Promise<void>;
}

// Refresh 60 s before expiry with per-conversation backoff; revoke on idle and shutdown. Never on the hook path.
export function createTokenPump(deps: {
  registry: Registry;
  backend: IntentBackend;
  login: () => Login | null;
  log: Log;
  now?: () => number;
  checkEveryMs?: number;
  idleAfterStopMs?: number;
}): TokenPump {
  const { registry, backend, login, log } = deps;
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleAfterStopMs ?? IDLE_AFTER_STOP_MS;
  const inflight = new Set<Promise<void>>();
  const failing = new Map<ConversationKey, { count: number; retryAt: number }>();
  const stoppedAt = new Map<ConversationKey, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const track = (p: Promise<void>) => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const live = (c: Conversation): c is Conversation & { plan: Plan } =>
    c.parent === null && c.plan !== null && c.plan.id !== "" && c.token?.status === "active";

  const due = (c: Conversation) =>
    live(c) && c.token?.status === "active" && c.token.expiresAt - now() <= REFRESH_BEFORE_MS && now() >= (failing.get(c.key)?.retryAt ?? 0);

  // A subagent keeps running after its parent's Stop (spike capture), so its hooks count as the root's activity.
  const activityByRoot = (): Map<ConversationKey, number> => {
    const latest = new Map<ConversationKey, number>();
    for (const c of registry.all()) {
      const root = registry.root(c.key)?.key ?? c.key;
      latest.set(root, Math.max(latest.get(root) ?? 0, c.lastActivity));
    }
    return latest;
  };

  async function cycle(): Promise<void> {
    const auth = login();
    for (const key of failing.keys()) if (!registry.has(key)) failing.delete(key);
    const activity = activityByRoot();
    const idle = (c: Conversation) => {
      const at = stoppedAt.get(c.key);
      const last = activity.get(c.key) ?? c.lastActivity;
      return at !== undefined && now() - Math.max(at, last) >= idleMs;
    };
    for (const c of [...registry.all()]) {
      if (stopped) return;
      if (now() - (activity.get(c.key) ?? c.lastActivity) >= FORGET_AFTER_MS) {
        if (auth && live(c)) revokePlan(auth, c.key, c.plan.id, "antigravity conversation expired");
        registry.close(c.key);
        stoppedAt.delete(c.key);
        continue;
      }
      if (idle(c)) {
        stoppedAt.delete(c.key);
        if (auth && live(c)) revokePlan(auth, c.key, c.plan.id, "antigravity conversation idle");
        registry.clearPlan(c.key);
        continue;
      }
      if (auth && due(c) && c.plan) await refresh(auth, c, c.plan);
    }
  }

  async function refresh(auth: Login, c: Conversation, plan: Plan): Promise<void> {
    const { id: _id, ...unminted } = plan;
    const result = await backend.mint(auth, unminted, c.ref.conversationId);
    if (!result.ok) return failed(c.key, result.reason);
    failing.delete(c.key);
    const { planId, token } = result.value;
    const current = registry.get(c.key);
    // stop() already revoked the plan ids it could see; this one was minted after.
    if (stopped) {
      if (planId && planId !== plan.id) revokePlan(auth, c.key, planId, "armoriq-agd shutting down");
      return;
    }
    if (!current || current.plan !== plan) {
      // Re-registered or closed while the mint ran, so nothing will ever use or revoke this plan id.
      if (planId && planId !== plan.id) revokePlan(auth, c.key, planId, current ? "plan replaced during token refresh" : "antigravity conversation closed");
      return;
    }
    if (token.status === "refused" || planId === plan.id) return registry.setToken(c.key, token);
    const cursor = current.stepCursor;
    registry.setPlan(c.key, { ...plan, id: planId }, token);
    if (cursor > 0) registry.advance(c.key, cursor - 1);
  }

  function failed(key: ConversationKey, reason: string): void {
    const count = (failing.get(key)?.count ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, CHECK_EVERY_MS * 2 ** (count - 1));
    failing.set(key, { count, retryAt: now() + delay });
    log.warn("intent token refresh failed", { conversation: key, reason, retryInMs: delay });
  }

  function revokePlan(auth: Login, key: ConversationKey, planId: string, reason: string): void {
    track(
      backend.revoke(auth, planId, reason).then((r) => {
        if (!r.ok) log.warn("intent token revoke failed", { conversation: key, planId, reason: r.reason });
      }),
    );
  }

  const kick = () => {
    if (stopped || running) return;
    running = cycle()
      .catch((error) => log.error("token pump failed", { error: String(error) }))
      .finally(() => {
        running = null;
      });
    track(running);
  };

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(kick, deps.checkEveryMs ?? CHECK_EVERY_MS);
      timer.unref?.();
    },

    kick,

    noteStop(key) {
      stoppedAt.set(key, now());
    },

    revoke(key, reason) {
      const c = registry.get(key);
      const auth = login();
      if (!c || !auth || !live(c)) return;
      revokePlan(auth, key, c.plan.id, reason);
      registry.clearPlan(key);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const auth = login();
      if (auth) for (const c of registry.all()) if (live(c)) revokePlan(auth, c.key, c.plan.id, "armoriq-agd shutting down");
      if (inflight.size === 0) return;
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => (wait = setTimeout(r, STOP_WAIT_MS)))]);
      clearTimeout(wait);
    },
  };
}
