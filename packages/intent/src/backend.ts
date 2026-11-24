import type { IntentToken } from "@armoriq/sdk-dev";
import type { PendingRequest, PlanKind } from "./registry.ts";
import { toSdkPlan } from "./plan-request.ts";
import { AGENT_ID, type CallResult, type DelegateRequest, type Delegation, type IntentBackend, type Login, type Minted, type PlanFailureReason, type RetryOptions } from "./types.ts";
export { toSdkPlan, PLAN_SOURCE } from "./plan-request.ts";

export const TOKEN_VALIDITY_SECONDS = 3600;
export const REQUEST_DEADLINE_MS = 40_000;
const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;
const KEPT_TOKENS = 512;

type Sdk = typeof import("@armoriq/sdk-dev");
type Client = InstanceType<Sdk["ArmorIQClient"]>;
type Seen = { status?: number; body?: unknown; retryAfter?: string | undefined; now: () => number };
type StatusMap<T> = (status: number) => CallResult<T> | null;

export interface ClientIdentity {
  readonly product: string;
  readonly version: string;
}

export interface SdkBackendOptions {
  readonly client: ClientIdentity;
  readonly loadSdk?: () => Promise<Sdk>;
  readonly log?: Pick<import("./types.ts").Log, "error">;
}

// The SDK reads only planId and rawToken.token on revoke and reanchor; the backend resolves the rest from
// planId. `token: undefined` drops the field from the body, as ArmorOpenCode's request does.
function minimalToken(planId: string): IntentToken {
  return {
    tokenId: planId,
    planHash: "",
    planId,
    signature: planId,
    issuedAt: 0,
    expiresAt: 0,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: 0,
    rawToken: { token: undefined },
  };
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function createSdkBackend(options: SdkBackendOptions): IntentBackend {
  let sdkPromise: Promise<Sdk> | null = null;
  const loadSdk = () => (sdkPromise ??= (options.loadSdk ?? (() => import("@armoriq/sdk-dev")))());
  // trust_delegate needs the parent's full token, which only the mint response carries.
  const tokens = new Map<string, IntentToken>();

  const keep = (planId: string, token: IntentToken) => {
    tokens.set(planId, token);
    if (tokens.size > KEPT_TOKENS) tokens.delete(tokens.keys().next().value ?? planId);
  };

  async function withRetry<T>(login: Login, run: (client: Client, timeoutMs: number) => Promise<T>, mapStatus?: StatusMap<T>, retry: RetryOptions = {}, request?: PendingRequest): Promise<CallResult<T>> {
    const now = retry.now ?? Date.now;
    const sleep = retry.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = now() + REQUEST_DEADLINE_MS;
    let sdk: Sdk;
    try {
      sdk = await loadSdk();
    } catch (error) {
      return { ok: false, retryable: false, reason: `sdk unavailable: ${String(error)}` };
    }
    let last: CallResult<T> = { ok: false, retryable: true, reason: "no attempt" };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (retry.cancelled?.()) return { ok: false, retryable: false, reason: "the prompt or authentication changed" };
      const remaining = deadline - now();
      if (remaining <= 0) break;
      last = await attemptOnce(sdk, login, run, Math.min(TIMEOUT_MS, remaining), now, mapStatus, request);
      if (last.ok || !last.retryable || attempt + 1 === ATTEMPTS) return last;
      const delay = last.retryAfterMs ?? 0;
      if (delay >= deadline - now()) return last;
      if (delay > 0) await sleep(delay);
    }
    return last;
  }

  async function attemptOnce<T>(sdk: Sdk, login: Login, run: (client: Client, timeoutMs: number) => Promise<T>, timeoutMs: number, now: () => number, mapStatus?: StatusMap<T>, request?: PendingRequest): Promise<CallResult<T>> {
    const controller = new AbortController();
    const seen: Seen = { now };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const running = run(createClient(sdk, login, controller.signal, seen, timeoutMs, request), timeoutMs).then((value) => ({ value }));
      running.catch(() => {});
      const outcome = await Promise.race([running, timedOut]);
      if (outcome === "timeout") return { ok: false, retryable: true, reason: `timed out after ${timeoutMs} ms` };
      if (seen.status !== undefined && seen.status >= 400) return classify(sdk, seen, mapStatus, "");
      return { ok: true, value: outcome.value };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, retryable: true, reason: `timed out after ${timeoutMs} ms` };
      return classify(sdk, seen, mapStatus, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  function createClient(sdk: Sdk, login: Login, signal: AbortSignal, seen: Seen, timeoutMs: number, request?: PendingRequest): Client {
    // maxRetries is read by the SDK constructor but missing from its declared options; retries are ours.
    const clientOptions = {
      apiKey: login.apiKey,
      backendEndpoint: login.backend,
      userId: request ? String(request.body.user_id) : login.userId,
      agentId: AGENT_ID,
      timeout: timeoutMs,
      maxRetries: 0,
      client: options.client,
    };
    const client = new sdk.ArmorIQClient(clientOptions);
    const http = client._sessionInternals().httpClient;
    http.defaults.signal = signal;
    const observe = (response: { status: number; data: unknown; headers?: Record<string, string> }) => {
      seen.status = response.status;
      seen.body = response.data;
      seen.retryAfter = response.headers?.["retry-after"];
      return response;
    };
    http.interceptors.response.use(observe, (error: { response?: Parameters<typeof observe>[0] }) => {
      if (error?.response) observe(error.response);
      return Promise.reject(error);
    });
    return client;
  }

  return {
    async mint(login, _plan, _contextId, request, retry = {}) {
      const now = retry.now ?? Date.now;
      const deadlineAt = request.deadlineAt ?? now() + REQUEST_DEADLINE_MS;
      const result = await withRetry<Minted>(
        login,
        async (client, timeoutMs) => {
          const body = request.body;
          const capture = client.capturePlan(AGENT_ID, String((body.plan as Record<string, unknown>).goal), body.plan as Record<string, unknown>);
          const token = await client.getIntentToken(capture, body.policy as Record<string, unknown> | undefined, Number(body.expires_in), {
            contextId: String(body.context_id), idempotencyKey: request.key,
            planKind: request.headers["X-ArmorIQ-Plan-Kind"] as PlanKind,
            ...(request.headers["X-ArmorIQ-Parent-Plan-Id"] ? { parentPlanId: request.headers["X-ArmorIQ-Parent-Plan-Id"] } : {}),
            ...(request.headers["X-ArmorIQ-Prompt-Id"] ? { promptId: request.headers["X-ArmorIQ-Prompt-Id"] } : {}),
            timeoutMs,
          });
          const validation: Record<string, unknown> = token.policyValidation ?? {};
          // validated:false means the org has no agent or active policy, and the backend then lists every
          // requested tool as denied. That is "no opinion", not a deny (PRD appendix A).
          const backendChecked = validation.validated !== false;
          const expiresAtSec = Number((token.rawToken?.token as { expires_at?: unknown } | undefined)?.expires_at);
          if (!token.planId) throw new Error("token response has no plan_id");
          if (!Number.isFinite(expiresAtSec) || expiresAtSec * 1000 <= (retry?.now ?? Date.now)()) throw new Error("token response has no usable expiry");
          if (!token.jwtToken && !token.signature) throw new Error("token response has no usable token");
          if (token.kind !== undefined && token.kind !== request.headers["X-ArmorIQ-Plan-Kind"]) throw new Error("token response has a different plan kind");
          keep(token.planId, token);
          return {
            planId: token.planId,
            ...(token.kind ? { kind: token.kind as PlanKind } : {}),
            legacy: token.kind === undefined,
            token: {
              status: "active",
              jwt: token.jwtToken || token.signature,
              expiresAt: Math.round(expiresAtSec * 1000),
              deniedTools: new Set(backendChecked ? stringList(validation.denied_tools) : []),
              heldTools: new Set(backendChecked ? stringList(validation.held_tools) : []),
            },
          };
        },
        (status) => {
          if (status === 401) return { ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" } } };
          if (status === 402) return { ok: true, value: { planId: "", token: { status: "refused", code: "billing_blocked" } } };
          return null;
        },
        retry,
        { ...request, deadlineAt },
      );
      try { if (!retry.cancelled?.()) {
        if (result.ok) {
          if (result.value.token.status === "refused") await retry.onFailure?.("rejected");
          else await retry.onSuccess?.();
        } else {
          const reason: PlanFailureReason = result.status === 429 ? "rate_limited"
            : result.status !== undefined && result.status >= 500 ? "server_error"
            : result.status === 409 && result.retryable ? "request_in_progress"
            : result.status !== undefined ? "rejected"
            : result.retryable && /timed out|deadline|timeout|no attempt/i.test(result.reason) ? "timeout"
            : result.retryable && /network|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|connection|offline/i.test(result.reason) ? "network" : "rejected";
          await retry.onFailure?.(reason, (result.retryable || result.unconfirmed) && now() < deadlineAt ? deadlineAt : undefined);
        }
      } } catch { options.log?.error("plan health reporting failed"); }
      return result;
    },

    reanchor(login, planId, plan, reason) {
      return withRetry(login, async (client) => {
        const result: unknown = await client.reanchor(tokens.get(planId) ?? minimalToken(planId), toSdkPlan(plan), reason, { planId });
        const trustId = typeof result === "object" && result !== null && "trustId" in result ? result.trustId : null;
        return { trustId: typeof trustId === "string" ? trustId : null };
      });
    },

    async revoke(login, planId, reason) {
      const r = await withRetry(login, async (client) => {
        await client.revoke(tokens.get(planId) ?? minimalToken(planId), reason, { planId, cascade: true });
      });
      if (r.ok) tokens.delete(planId);
      return r;
    },

    delegate(login, planId, request: DelegateRequest) {
      const parent = tokens.get(planId);
      if (!parent) {
        return Promise.resolve<CallResult<Delegation>>({
          ok: false,
          retryable: false,
          reason: "the daemon restarted since this plan was minted; register the plan again to delegate",
        });
      }
      return withRetry(login, async (client) => {
        const result = await client.delegateSubtree(parent, { ...request, planId });
        return { trustId: result.trustId ?? null, subtreeRoot: result.subtreeRoot, inclusionProofLength: result.inclusionProof.length };
      });
    },
  };
}

function classify<T>(sdk: Sdk, seen: Seen, mapStatus: StatusMap<T> | undefined, message: string): CallResult<T> {
  const status = seen.status;
  if (status === undefined) return { ok: false, retryable: true, reason: message || "network error" };
  if (status < 400) return { ok: false, retryable: false, unconfirmed: true, reason: message || "invalid token response" };
  const mapped = mapStatus?.(status);
  if (mapped) return mapped;
  if (sdk.isReloginRequired(status, seen.body)) return { ok: false, retryable: false, status, relogin: true, reason: "relogin_required" };
  const detail = bodyMessage(seen.body) || message || `HTTP ${status}`;
  const code = (seen.body as { error?: unknown } | null)?.error;
  return { ok: false, status, retryable: status >= 500 || status === 429 || status === 409 && code === "request_in_progress", retryAfterMs: parseRetryAfter(seen.retryAfter, seen.now()), reason: `HTTP ${status}: ${detail}` };
}

export function parseRetryAfter(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const legacyLogged = new WeakSet<object>();
export function logLegacyBackend(log: import("./types.ts").Log): void {
  if (legacyLogged.has(log)) return;
  legacyLogged.add(log);
  log.warn("backend does not support the plan capture contract");
}

function bodyMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (typeof body === "object" && body !== null && "message" in body) {
    const m = body.message;
    if (typeof m === "string") return m.slice(0, 200);
    if (Array.isArray(m)) return m.join("; ").slice(0, 200);
  }
  return "";
}
