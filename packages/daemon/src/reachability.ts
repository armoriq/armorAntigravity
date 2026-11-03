import type { Login } from "./auth.ts";
import type { Log } from "./log.ts";

// Spec 0002 posture: a probe that fails with a timeout over 2 s, a network error or a 5xx marks the
// backend unreachable for 30 s; any other answer marks it reachable for as long.
export const PROBE_TIMEOUT_MS = 2_000;
export const CACHE_MS = 30_000;
const PROBE_PATH = "/iap/validate-key";

export type Reach = { readonly kind: "reachable" } | { readonly kind: "unreachable"; readonly reason: string } | { readonly kind: "signed_out" };

export type ProbeResponse = { readonly status: number; readonly body: unknown } | { readonly status: null; readonly reason: string };

export interface ReachabilityOptions {
  readonly log: Log;
  readonly headers: Readonly<Record<string, string>>;
  // Every probe answer goes here, so the auth state applies 401 and relogin_required.
  onResponse(probed: Login, status: number, body: unknown): void;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cacheMs?: number;
}

export interface Reachability {
  // Answers from the cache while it is fresh; otherwise waits for one probe, shared by every caller.
  check(login: Login): Promise<Reach>;
}

export function createReachability(opts: ReachabilityOptions): Reachability {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  let cached: { key: string; reach: Reach; until: number } | null = null;
  let inflight: { key: string; done: Promise<Reach> } | null = null;

  async function probe(login: Login): Promise<ProbeResponse> {
    try {
      const res = await doFetch(`${login.backend}${PROBE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.apiKey}`, "X-API-Key": login.apiKey, ...opts.headers },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, body };
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      return { status: null, reason: timedOut ? `no answer in ${timeoutMs} ms` : String(error) };
    }
  }

  function toReach(res: ProbeResponse): Reach {
    if (res.status === null) return { kind: "unreachable", reason: res.reason };
    if (res.status >= 500) return { kind: "unreachable", reason: `HTTP ${res.status}` };
    if (res.status === 401) return { kind: "signed_out" };
    return { kind: "reachable" };
  }

  async function refresh(login: Login, key: string): Promise<Reach> {
    const res = await probe(login);
    if (res.status !== null) opts.onResponse(login, res.status, res.body);
    const reach = toReach(res);
    const previous = cached?.key === key ? cached.reach.kind : null;
    cached = { key, reach, until: now() + cacheMs };
    if (reach.kind !== previous) {
      const extra = { backend: login.backend, ...(reach.kind === "unreachable" ? { reason: reach.reason, recheckMs: cacheMs } : {}) };
      if (reach.kind === "unreachable") opts.log.warn("backend unreachable; side-effecting calls are blocked", extra);
      else opts.log.info(`backend ${reach.kind === "reachable" ? "reachable" : "rejected the key"}`, extra);
    }
    return reach;
  }

  return {
    check(login) {
      const key = `${login.backend}\n${login.apiKey}`;
      if (cached?.key === key && now() < cached.until) return Promise.resolve(cached.reach);
      if (inflight?.key === key) return inflight.done;
      const done = refresh(login, key).finally(() => {
        if (inflight?.done === done) inflight = null;
      });
      inflight = { key, done };
      return done;
    },
  };
}
