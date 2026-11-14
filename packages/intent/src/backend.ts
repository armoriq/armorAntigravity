import type { IntentToken } from "@armoriq/sdk-dev";
import { AGENT_ID, type CallResult, type DelegateRequest, type Delegation, type Draft, type IntentBackend, type Login, type Minted } from "./types.ts";

export const TOKEN_VALIDITY_SECONDS = 3600;
export const PLAN_SOURCE = "antigravity-registered";
const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;
const KEPT_TOKENS = 512;

type Sdk = typeof import("@armoriq/sdk-dev");
type Client = InstanceType<Sdk["ArmorIQClient"]>;
type Seen = { status?: number; body?: unknown };
type StatusMap<T> = (status: number) => CallResult<T> | null;

export interface ClientIdentity {
  readonly product: string;
  readonly version: string;
}

export interface SdkBackendOptions {
  readonly client: ClientIdentity;
  // The compiled local policy sent as `policy` on the mint (ArmorClaude intent.mjs); OpenCode sends undefined.
  mintPolicy(): Record<string, unknown> | undefined;
  readonly loadSdk?: () => Promise<Sdk>;
}

export function toSdkPlan(plan: Draft): { goal: string; steps: Record<string, unknown>[]; metadata: Record<string, unknown> } {
  return {
    goal: plan.goal,
    steps: plan.steps.map((s) => ({
      action: s.tool,
      tool: s.tool,
      mcp: AGENT_ID,
      description: s.action,
      metadata: s.params ? { inputs: s.params } : {},
    })),
    metadata: { goal: plan.goal, source: PLAN_SOURCE, plan_hash: plan.hash },
  };
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

  async function withRetry<T>(login: Login, run: (client: Client) => Promise<T>, mapStatus?: StatusMap<T>): Promise<CallResult<T>> {
    let sdk: Sdk;
    try {
      sdk = await loadSdk();
    } catch (error) {
      return { ok: false, retryable: false, reason: `sdk unavailable: ${String(error)}` };
    }
    let last: CallResult<T> = { ok: false, retryable: true, reason: "no attempt" };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      last = await attemptOnce(sdk, login, run, mapStatus);
      if (last.ok || !last.retryable) return last;
    }
    return last;
  }

  async function attemptOnce<T>(sdk: Sdk, login: Login, run: (client: Client) => Promise<T>, mapStatus?: StatusMap<T>): Promise<CallResult<T>> {
    const controller = new AbortController();
    const seen: Seen = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, TIMEOUT_MS);
    });
    try {
      const running = run(createClient(sdk, login, controller.signal, seen)).then((value) => ({ value }));
      running.catch(() => {});
      const outcome = await Promise.race([running, timedOut]);
      if (outcome === "timeout") return { ok: false, retryable: true, reason: `timed out after ${TIMEOUT_MS} ms` };
      if (seen.status !== undefined && seen.status >= 400) return classify(sdk, seen, mapStatus, "");
      return { ok: true, value: outcome.value };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, retryable: true, reason: `timed out after ${TIMEOUT_MS} ms` };
      return classify(sdk, seen, mapStatus, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  function createClient(sdk: Sdk, login: Login, signal: AbortSignal, seen: Seen): Client {
    // maxRetries is read by the SDK constructor but missing from its declared options; retries are ours.
    const clientOptions = {
      apiKey: login.apiKey,
      backendEndpoint: login.backend,
      userId: login.userId,
      agentId: AGENT_ID,
      timeout: TIMEOUT_MS,
      maxRetries: 0,
      client: options.client,
    };
    const client = new sdk.ArmorIQClient(clientOptions);
    const http = client._sessionInternals().httpClient;
    http.defaults.signal = signal;
    http.interceptors.response.use((response: { status: number; data: unknown }) => {
      seen.status = response.status;
      seen.body = response.data;
      return response;
    });
    return client;
  }

  return {
    mint(login, plan, contextId) {
      return withRetry<Minted>(
        login,
        async (client) => {
          const capture = client.capturePlan(AGENT_ID, plan.goal, toSdkPlan(plan), {
            source: AGENT_ID,
            session_id: contextId,
            plan_hash: plan.hash,
            revision: plan.revision,
          });
          const token = await client.getIntentToken(capture, options.mintPolicy(), TOKEN_VALIDITY_SECONDS, { contextId });
          const validation: Record<string, unknown> = token.policyValidation ?? {};
          // validated:false means the org has no agent or active policy, and the backend then lists every
          // requested tool as denied. That is "no opinion", not a deny (PRD appendix A).
          const backendChecked = validation.validated !== false;
          const expiresAtSec = Number(token.expiresAt);
          if (!token.planId) throw new Error("token response has no plan_id");
          if (!Number.isFinite(expiresAtSec)) throw new Error(`token response has an invalid expires_at: ${String(token.expiresAt)}`);
          keep(token.planId, token);
          return {
            planId: token.planId,
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
      );
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
  const mapped = mapStatus?.(status);
  if (mapped) return mapped;
  if (sdk.isReloginRequired(status, seen.body)) return { ok: false, retryable: false, relogin: true, reason: "relogin_required" };
  const detail = bodyMessage(seen.body) || message || `HTTP ${status}`;
  return { ok: false, retryable: status >= 500 || status === 429, reason: `HTTP ${status}: ${detail}` };
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
