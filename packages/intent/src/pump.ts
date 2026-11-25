import type { Conversation, Registry } from "./registry.ts";
import { logLegacyBackend } from "./backend.ts";
import { intentValiditySeconds, planRequest, requestBody } from "./plan-request.ts";
import type { ConversationKey, IntentBackend, Log, Login, Mode, Plan } from "./types.ts";

export const REFRESH_BEFORE_MS = 120_000;
export const CHECK_EVERY_MS = 15_000;
// ASSUMPTION(P0 #8): Antigravity has no conversation-deleted event, so a conversation counts as ended once it
// has had a Stop and then this long with no hook from it or its subagents. Replace with the trigger the spike settles on.
export const IDLE_AFTER_STOP_MS = 30 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
const RETRY_MAX_MS = 5 * 60_000;
const PROMPT_IDLE_MS = 30 * 60_000;
const PRE_TOOL_REFRESH_WAIT_MS = 3500;
// Long enough for one revoke: two attempts of 5 s each.
const STOP_WAIT_MS = 11_000;

export interface TokenPump {
  start(): void;
  kick(): void;
  noteStop(key: ConversationKey): void;
  revoke(key: ConversationKey, reason: string): void;
  beforeTool(key: ConversationKey): Promise<void>;
  // Revokes every live plan with cascade, then stops. Called when the daemon shuts down.
  stop(): Promise<void>;
}

// Refresh open prompts with backoff. The tool guard joins a refresh already in flight for up to 3.5 seconds.
export function createTokenPump(deps: {
  registry: Registry;
  backend: IntentBackend;
  login: () => Login | null;
  mode?: () => Mode;
  log: Log;
  onUnauthorized?: () => void;
  now?: () => number;
  checkEveryMs?: number;
  idleAfterStopMs?: number;
  validitySeconds?: number;
  mintPolicy?: () => Record<string, unknown> | undefined;
}): TokenPump {
  const { registry, backend, login, log } = deps;
  const now = deps.now ?? Date.now;
  const validity = deps.validitySeconds ?? intentValiditySeconds(process.env);
  const refreshBeforeMs = Math.min(120, validity / 3) * 1000;
  const idleMs = deps.idleAfterStopMs ?? IDLE_AFTER_STOP_MS;
  const inflight = new Set<Promise<void>>();
  const failing = new Map<ConversationKey, { count: number; retryAt: number }>();
  const stoppedAt = new Map<ConversationKey, { at: number; generation: number }>();
  const refreshing = new Map<ConversationKey, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const track = (p: Promise<void>) => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const live = (c: Conversation): c is Conversation & { plan: Plan } =>
    c.parent === null && c.plan !== null && c.plan.id !== "" && c.token?.status === "active";

  const promptOpen = (c: Conversation) => c.promptId !== null && c.promptOpenSince !== null && now() - c.lastActivityAt < PROMPT_IDLE_MS;
  const due = (c: Conversation) =>
    !stopped && (deps.mode?.() ?? "enforce") === "enforce" && promptOpen(c) && c.countedPlanId !== null && live(c) && c.token?.status === "active" && c.token.expiresAt - now() <= refreshBeforeMs && now() >= (failing.get(c.key)?.retryAt ?? 0);

  // A subagent keeps running after its parent's Stop (spike capture), so its hooks count as the root's activity.
  const activityByRoot = (): Map<ConversationKey, number> => {
    const latest = new Map<ConversationKey, number>();
    for (const c of registry.all()) {
      const root = registry.root(c.key)?.key ?? c.key;
      latest.set(root, Math.max(latest.get(root) ?? 0, c.lastActivityAt));
    }
    return latest;
  };

  async function cycle(): Promise<void> {
    const auth = login();
    registry.syncAuth(auth, deps.mode?.() ?? "enforce");
    for (const key of failing.keys()) if (!registry.has(key)) failing.delete(key);
    const activity = activityByRoot();
    const idle = (c: Conversation) => {
      const stop = stoppedAt.get(c.key);
      if (stop && stop.generation !== c.promptGeneration) {
        stoppedAt.delete(c.key);
        return false;
      }
      const last = activity.get(c.key) ?? c.lastActivityAt;
      return stop !== undefined && now() - Math.max(stop.at, last) >= idleMs;
    };
    for (const c of [...registry.all()]) {
      if (stopped) return;
      if (now() - (activity.get(c.key) ?? c.lastActivityAt) >= FORGET_AFTER_MS) {
        if (auth && live(c)) revokePlan(auth, c.key, c.tokenPlanId ?? c.plan.id, "antigravity conversation expired");
        registry.close(c.key);
        stoppedAt.delete(c.key);
        continue;
      }
      if (idle(c)) {
        stoppedAt.delete(c.key);
        if (auth && live(c)) revokePlan(auth, c.key, c.tokenPlanId ?? c.plan.id, "antigravity conversation idle");
        registry.clearPlan(c.key);
        continue;
      }
      if (auth && due(c) && c.plan) await refreshOnce(auth, c, c.plan);
    }
  }

  async function refresh(auth: Login, c: Conversation, plan: Plan): Promise<void> {
    const release = registry.acquire(c.key);
    if (!release) return;
    const generation = registry.generation(c.key)!;
    try {
      const { id: _id, ...unminted } = plan;
      const request = planRequest({ kind: "refresh", promptId: c.promptId!, countedPlanId: c.countedPlanId!, tokenExpiresAt: new Date(c.tokenExpiresAt!).toISOString() }, requestBody(auth, unminted, c.ref.conversationId, validity, deps.mintPolicy?.()));
      if (c.pendingRequest && c.pendingRequest.key !== request.key) return;
      const descriptor = c.pendingRequest ?? request;
      try {
        if (!registry.setPendingRequest(c.key, descriptor, generation)) return;
      } catch {
        failed(c.key, "could not persist the plan request");
        return;
      }
      const cancelled = () => {
        registry.syncAuth(login(), deps.mode?.() ?? "enforce");
        return stopped || !registry.isCurrent(c.key, generation) || !promptOpen(c);
      };
      const result = await backend.mint(auth, unminted, c.ref.conversationId, descriptor, { cancelled, now });
      registry.syncAuth(login(), deps.mode?.() ?? "enforce");
      if (!result.ok) {
        if (registry.isCurrent(c.key, generation)) {
          if (!result.retryable && !result.unconfirmed) registry.setPendingRequest(c.key, null, generation);
          failed(c.key, result.reason);
        }
        return;
      }
      failing.delete(c.key);
      const { planId, token } = result.value;
      const current = registry.get(c.key);
      // stop() already revoked the plan ids it could see; this one was minted after.
      if (stopped) {
        if (planId && planId !== plan.id) revokePlan(auth, c.key, planId, "armoriq-agd shutting down");
        return;
      }
      if (!current || !registry.isCurrent(c.key, generation) || current.plan !== plan || !promptOpen(c)) {
        // Replaced or retired while the mint ran, so this result cannot authorize tools.
        if (planId && planId !== plan.id) revokePlan(auth, c.key, planId, current ? "plan replaced during token refresh" : "antigravity conversation closed");
        return;
      }
      if (token.status === "refused" && token.code === "account_revoked" && deps.onUnauthorized) {
        deps.onUnauthorized();
        registry.syncAuth(login(), deps.mode?.() ?? "enforce");
        registry.setPendingRequest(c.key, null, generation);
        return;
      }
      if (result.value.legacy) logLegacyBackend(log);
      registry.setToken(c.key, token, generation, planId);
      registry.setPendingRequest(c.key, null, generation);
    } finally {
      release();
    }
  }

  function refreshOnce(auth: Login, c: Conversation, plan: Plan): Promise<void> {
    const active = refreshing.get(c.key);
    if (active) return active;
    const work = refresh(auth, c, plan).finally(() => refreshing.delete(c.key));
    refreshing.set(c.key, work);
    track(work);
    return work;
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

    async beforeTool(key) {
      registry.syncAuth(login(), deps.mode?.() ?? "enforce");
      const c = registry.root(key);
      if (!c || c.token?.status !== "active" || c.token.expiresAt > now()) return;
      const active = refreshing.get(c.key);
      const auth = login();
      const work = active ?? (auth && due(c) && c.plan ? refreshOnce(auth, c, c.plan) : null);
      if (!work) return;
      // The hook has a ten second budget. The normal decision can report an expired token while refresh continues.
      let wait: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([work, new Promise<void>(resolve => { wait = setTimeout(resolve, PRE_TOOL_REFRESH_WAIT_MS); })]);
      } finally {
        clearTimeout(wait);
      }
    },

    noteStop(key) {
      registry.endPrompt(key);
      const c = registry.get(key);
      if (c) stoppedAt.set(key, { at: now(), generation: c.promptGeneration });
    },

    revoke(key, reason) {
      const c = registry.get(key);
      const auth = login();
      if (!c || !auth || !live(c)) return;
      revokePlan(auth, key, c.tokenPlanId ?? c.plan.id, reason);
      registry.clearPlan(key);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const auth = login();
      if (auth) for (const c of registry.all()) if (live(c)) revokePlan(auth, c.key, c.tokenPlanId ?? c.plan.id, "armoriq-agd shutting down");
      if (inflight.size === 0) return;
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => (wait = setTimeout(r, STOP_WAIT_MS)))]);
      clearTimeout(wait);
    },
  };
}
