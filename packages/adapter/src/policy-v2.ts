import { evaluate, VERDICT_RANK, type CallInput, type Evaluation, type PolicyDocument, type Verdict } from "@armoriq/policy-ir";
import { backendRequest, type BackendAccess, type Fetch } from "./backend-http.ts";
import type { Log } from "./core-contract.ts";
import { isRecord } from "./tools.ts";

// The product slug conmap resolves to this org's Antigravity agent (policy v2 shared contract).
export const V2_AGENT = "armorantigravity";
export const BUNDLE_REVALIDATE_MS = 60_000;

export type V2Policy = {
  readonly policyId: string;
  readonly name: string;
  readonly policyHash: string | null;
  readonly document: PolicyDocument;
  readonly targetType: "org" | "agent";
  readonly status: "active" | "shadow";
};

type V2Tool = { readonly name: string; readonly qualifiedName?: string; readonly server?: string; readonly schemaHash: string | null; readonly capabilities: readonly string[] };
type V2Member = { readonly membershipId: string; readonly email: string };

export type V2Agent = {
  readonly inactive: boolean;
  readonly policies: readonly V2Policy[];
  readonly tools: readonly V2Tool[];
  readonly members: readonly V2Member[];
};

export type V2BundleOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "applied"; etag: string; policies: number }
  | { kind: "unchanged" }
  | { kind: "failed"; reason: string };

export interface PolicyBundle {
  // Null until a bundle arrives, and while logged out: v1 and the local file decide alone.
  current(): V2Agent | null;
  refresh(): Promise<V2BundleOutcome>;
  stop(): void;
}

export type PolicyBundleOptions = {
  readonly access: () => BackendAccess | null;
  readonly log: Log;
  readonly agent?: string;
  readonly fetch?: Fetch;
  readonly revalidateMs?: number;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function parsePolicy(raw: unknown, fallback?: Pick<V2Policy, "targetType" | "status">): V2Policy | null {
  if (!isRecord(raw)) return null;
  const policyId = str(raw.policyId);
  const name = str(raw.name);
  const document = raw.document;
  const targetType = raw.targetType ?? fallback?.targetType;
  const status = raw.status ?? fallback?.status;
  if (!policyId || !name || !isRecord(document) || !Array.isArray(document.statements)) return null;
  if ((targetType !== "org" && targetType !== "agent") || (status !== "active" && status !== "shadow")) return null;
  return { policyId, name, policyHash: str(raw.policyHash), document: document as unknown as PolicyDocument, targetType, status };
}

function parseTool(raw: unknown): V2Tool | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const qualifiedName = str(raw.qualifiedName);
  const server = str(raw.server);
  return {
    name,
    ...(qualifiedName ? { qualifiedName } : {}),
    ...(server ? { server } : {}),
    schemaHash: str(raw.schemaHash),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c): c is string => typeof c === "string") : [],
  };
}

// conmap feat/policy-v2-org-target: `policies[]` carries org-wide and agent documents, active and
// shadow. Older backends send only `policy`, the agent's own active document.
export function parseBundleAgent(bundle: unknown, agent: string): V2Agent | null {
  if (!isRecord(bundle) || !Array.isArray(bundle.agents)) return null;
  const entry = bundle.agents.find((a) => isRecord(a) && (a.agentId === agent || a.name === agent));
  if (!isRecord(entry)) return null;
  const policies = Array.isArray(entry.policies)
    ? entry.policies.map((p) => parsePolicy(p)).filter((p): p is V2Policy => p !== null)
    : [parsePolicy(entry.policy, { targetType: "agent", status: "active" })].filter((p): p is V2Policy => p !== null);
  const members = Array.isArray(entry.members)
    ? entry.members.flatMap((m) => (isRecord(m) && str(m.membershipId) && str(m.email) ? [{ membershipId: String(m.membershipId), email: String(m.email) }] : []))
    : [];
  return {
    inactive: entry.inactive === true,
    policies,
    tools: Array.isArray(entry.tools) ? entry.tools.map(parseTool).filter((t): t is V2Tool => t !== null) : [],
    members,
  };
}

export function createPolicyBundle(options: PolicyBundleOptions): PolicyBundle {
  const agent = options.agent ?? V2_AGENT;
  const { log } = options;
  let cached: { apiKey: string; etag: string; agent: V2Agent | null } | null = null;
  let stopped = false;
  let inFlight: Promise<V2BundleOutcome> | null = null;

  const pull = async (): Promise<V2BundleOutcome> => {
    const access = options.access();
    if (!access) {
      if (cached?.agent) log.info("logged out; dropping the v2 policy bundle");
      cached = null;
      return { kind: "skipped", reason: "not logged in" };
    }
    const prior = cached?.apiKey === access.login.apiKey ? cached : null;
    const res = await backendRequest(access, {
      method: "GET",
      path: `/policy/bundles/current?agent=${encodeURIComponent(agent)}`,
      headers: prior?.etag ? { "If-None-Match": prior.etag } : {},
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (stopped || options.access()?.login.apiKey !== access.login.apiKey) return { kind: "skipped", reason: "login changed" };
    if (!res.ok) {
      // A failed pull keeps the last bundle: it never loosens what is enforced.
      log.warn("v2 policy bundle pull failed; keeping the current bundle", { reason: res.reason });
      return { kind: "failed", reason: res.reason };
    }
    if (res.status === 304 && prior) return { kind: "unchanged" };
    if (!isRecord(res.data)) {
      log.warn("v2 policy bundle rejected; keeping the current bundle");
      return { kind: "failed", reason: "bundle is not an object" };
    }
    const parsed = parseBundleAgent(res.data, agent);
    const etag = res.headers.get("etag") ?? "";
    cached = { apiKey: access.login.apiKey, etag, agent: parsed };
    log.info("v2 policy bundle applied", { etag, policies: parsed?.policies.map((p) => `${p.targetType}:${p.status}:${p.name}`) ?? [] });
    return { kind: "applied", etag, policies: parsed?.policies.length ?? 0 };
  };

  const refresh = (): Promise<V2BundleOutcome> => (inFlight ??= pull().finally(() => (inFlight = null)));
  const timer = setInterval(() => void refresh(), options.revalidateMs ?? BUNDLE_REVALIDATE_MS);
  timer.unref?.();

  return {
    current: () => {
      const login = options.access()?.login.apiKey;
      return cached && cached.apiKey === login ? cached.agent : null;
    },
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export type V2Call = {
  // Names the call may go by in a policy; the first is the one an unmatched call is decided by.
  readonly names: readonly string[];
  readonly mcpServer?: string;
  readonly args: Readonly<Record<string, unknown>>;
  // From the tool's category; the inventory's tags for the tool are added to these.
  readonly capabilities: readonly string[];
  readonly derived: Readonly<Record<string, unknown>>;
  readonly userEmail?: string;
  readonly at: number;
};

export type V2Verdict = {
  readonly verdict: Verdict;
  // Null only for an inactive agent with no document.
  readonly policy: V2Policy | null;
  readonly rule: string;
};

export type V2Outcome = {
  // Null when no active v2 document applies: v1 and the local file decide.
  readonly enforced: V2Verdict | null;
  readonly shadow: readonly V2Verdict[];
};

type Bound = { floor?: PolicyDocument; agent?: PolicyDocument };

function bound(org: V2Policy | undefined, own: V2Policy | undefined): Bound {
  return { ...(org ? { floor: org.document } : {}), ...(own ? { agent: own.document } : {}) };
}

function inputsFor(agent: V2Agent, call: V2Call, name: string): CallInput[] {
  const base: CallInput = {
    tool: name,
    arguments: { ...call.args },
    schemaHash: null,
    capabilities: [...call.capabilities],
    derived: { ...call.derived },
    timestamp: new Date(call.at).toISOString(),
  };
  if (call.userEmail) {
    const email = call.userEmail.trim().toLowerCase();
    const known = agent.members.find((m) => m.email === email);
    base.member = { email: call.userEmail, ...(known ? { membershipId: known.membershipId } : {}) };
  }
  const named = agent.tools.filter((t) => t.name === name || t.qualifiedName === name);
  const owned = call.mcpServer ? named.filter((t) => t.server === call.mcpServer) : [];
  const known = owned.length ? owned : named;
  if (!known.length) return [base];
  return known.map((t) => ({ ...base, schemaHash: t.schemaHash, capabilities: [...new Set([...call.capabilities, ...t.capabilities])], ...(t.qualifiedName && t.server === call.mcpServer ? { qualifiedName: t.qualifiedName } : {}) }));
}

const strictest = (all: readonly Evaluation[]): Evaluation => all.reduce((best, next) => (VERDICT_RANK[next.verdict] > VERDICT_RANK[best.verdict] ? next : best));

// A rule may name the call by any of its names (an org-wide `Bash` rule reaches run_command), but a
// default is only read for the primary name: an allow-list must not block run_command because
// nothing in it names `Bash`.
function evaluateCall(agent: V2Agent, call: V2Call, docs: Bound): Evaluation {
  const byName = call.names.map((name) => strictest(inputsFor(agent, call, name).map((input) => evaluate(input, docs))));
  const matched = byName.filter((e) => e.provenance.statementId !== null);
  return matched.length ? strictest(matched) : (byName[0] ?? strictest([]));
}

function verdictOf(evaluation: Evaluation, candidates: readonly (V2Policy | undefined)[]): V2Verdict {
  const p = evaluation.provenance;
  const policy = candidates.find((c) => c?.document.policyId === p.policyId) ?? candidates.find((c) => c !== undefined) ?? null;
  return { verdict: evaluation.verdict, policy, rule: p.statementId ? `${p.ruleKey}#${p.variant}` : "tools.default" };
}

export function decideV2(agent: V2Agent | null, call: V2Call): V2Outcome {
  if (!agent) return { enforced: null, shadow: [] };
  const active = (t: V2Policy["targetType"]) => agent.policies.find((p) => p.targetType === t && p.status === "active");
  const org = active("org");
  const own = active("agent");
  let enforced: V2Verdict | null = null;
  if (org || own) enforced = verdictOf(evaluateCall(agent, call, bound(org, own)), [org, own]);
  else if (agent.inactive) enforced = { verdict: "block", policy: null, rule: "agent_inactive" };

  const shadow = agent.policies
    .filter((p) => p.status === "shadow")
    .map((p) => {
      const layers = p.targetType === "org" ? [p, own] : [org, p];
      return { ...verdictOf(evaluateCall(agent, call, bound(layers[0], layers[1])), layers), policy: p };
    });
  return { enforced, shadow };
}
