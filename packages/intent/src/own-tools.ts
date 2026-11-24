import { createHash } from "node:crypto";
import { logLegacyBackend, REQUEST_DEADLINE_MS } from "./backend.ts";
import { intentValiditySeconds, planRequest, requestBody } from "./plan-request.ts";
import { isPlainObject, mcpPart, parsePlan } from "./plan.ts";
import { safeRunRecorder } from "./reporting.ts";
import type { Conversation, Generation, PlanKind, PendingRequest, Registry } from "./registry.ts";
import { conversationKey, type AuditRow, type ConversationKey, type ConversationRef, type DelegateRequest, type Draft, type IntentBackend, type Log, type Login, type Plan, type PlanRequestHealth, type PolicyView, type RunRecorder, type Token } from "./types.ts";

export const OWN_TOOLS = ["register_intent_plan", "trust_reanchor", "trust_revoke", "trust_delegate", "policy_read"] as const;
export type OwnTool = (typeof OWN_TOOLS)[number];

// The argument names each tool declares in the MCP server's schema (ArmorOpenCode tools/intent.ts plus
// ArmorClaude's trust_delegate).
export const OWN_TOOL_ARGS: Readonly<Record<OwnTool, readonly string[]>> = {
  register_intent_plan: ["goal", "steps", "plan", "reason"],
  trust_reanchor: ["updatedPlan", "reason"],
  trust_revoke: ["reason"],
  trust_delegate: ["delegatePublicKey", "subtreePath", "validitySeconds", "targetAgent"],
  policy_read: ["tool"],
};

export const MCP_SERVER_NAME = "armoriq";
export const MAX_REVISIONS_PER_TURN = 2;

// The MCP call follows its PreToolUse within moments; a short TTL limits how long an unclaimed outcome waits.
const OUTCOME_TTL_MS = 15_000;

export const AMBIGUOUS_OUTCOME =
  "ArmorIQ handled this exact call for more than one conversation at the same moment, so it cannot tell which result belongs to this one. The call was processed; call policy_read to see this conversation's state.";

function isOwnTool(name: string): name is OwnTool {
  return (OWN_TOOLS as readonly string[]).includes(name);
}

const OWN_PREFIXES = [`mcp_${MCP_SERVER_NAME}_`, `mcp__${MCP_SERVER_NAME}__`];

export function ownToolName(name: string): OwnTool | null {
  const prefix = OWN_PREFIXES.find((p) => name.toLowerCase().startsWith(p));
  const bare = prefix ? name.slice(prefix.length) : name;
  return isOwnTool(bare) ? bare : null;
}

const MCP_CALL_TOOL = "call_mcp_tool";
// Same keys and server folding as the adapter's resolveMcpCall, so a call core allows as an own tool is always
// one intent handles. The first of each is what agy sent in a live run.
const SERVER_KEYS = ["ServerName", "serverName", "server"];
const TOOL_KEYS = ["ToolName", "toolName", "tool"];
const ARGUMENT_KEYS = ["Arguments", "arguments", "args"];

function firstOf(args: Record<string, unknown>, keys: readonly string[]): unknown {
  const key = keys.find((k) => args[k] !== undefined);
  return key === undefined ? undefined : args[key];
}

// The main agent reaches mcp_config.json servers through call_mcp_tool with ServerName, ToolName and Arguments
// (live agy CLI run); a per-tool mcp_<server>_<tool> name was captured only for the built-in browser server.
export function ownToolCall(name: string, args: unknown): { readonly tool: OwnTool; readonly args: unknown } | null {
  if (name !== MCP_CALL_TOOL) {
    const tool = ownToolName(name);
    return tool ? { tool, args } : null;
  }
  if (!isPlainObject(args)) return null;
  const server = firstOf(args, SERVER_KEYS);
  const tool = firstOf(args, TOOL_KEYS);
  if (typeof server !== "string" || mcpPart(server) !== mcpPart(MCP_SERVER_NAME) || typeof tool !== "string" || !isOwnTool(tool)) return null;
  return { tool, args: firstOf(args, ARGUMENT_KEYS) };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}

// MCP calls carry no conversation id, so the MCP server finds the outcome the hook computed for the same
// call by tool name plus a digest of the arguments. Only declared arguments count: the hook payload also
// carries Antigravity's own toolAction and toolSummary (spike capture), which the MCP server never sees.
export function callDigest(tool: OwnTool, args: unknown): string {
  const record = isPlainObject(args) ? args : {};
  const declared = Object.fromEntries(OWN_TOOL_ARGS[tool].filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
  return createHash("sha256").update(JSON.stringify([tool, stable(declared)])).digest("hex");
}

export interface OwnToolDeps {
  readonly registry: Registry;
  readonly backend: IntentBackend;
  login(): Login | null;
  mode(): "enforce" | "monitor";
  policy(): PolicyView;
  audit(row: AuditRow): void;
  onRelogin?(reason: string): void;
  // A 401 on mint: the key is not accepted, which spec 0002 treats as signed out, not as a revoked account.
  onUnauthorized?(): void;
  onAuthenticated?(login: Login): void;
  readonly log: Log;
  readonly now?: () => number;
  readonly validitySeconds?: number;
  readonly health?: PlanRequestHealth;
  readonly runs?: RunRecorder;
  mintPolicy?(): Record<string, unknown> | undefined;
}

export interface OwnTools {
  // Runs on PreToolUse for an own tool. Plan requests are persisted before the first send, and registrations
  // run in the background, tracked by settled(). The promise resolves to the eventual MCP outcome.
  // A repeat for the same conversation and stepIdx returns the first outcome without acting again.
  handle(ref: ConversationRef, tool: OwnTool, args: unknown, stepIdx?: number): Promise<string>;
  // The MCP server's view: the outcome text for a call the hook already handled, or null after waitMs.
  outcome(tool: OwnTool, args: unknown, waitMs: number): Promise<string | null>;
  settled(): Promise<void>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const notRegistered = (reason: string) => `Plan not registered: ${reason.replace(/\.+$/, "")}.`;
const notConfirmed = (reason: string) => `Plan registration not confirmed: ${reason.replace(/\.+$/, "")}. It will be retried with the same request id.`;

export function createOwnTools(deps: OwnToolDeps): OwnTools {
  const { registry, backend, log } = deps;
  const now = deps.now ?? Date.now;
  const validity = deps.validitySeconds ?? intentValiditySeconds(process.env);
  const background = new Set<Promise<void>>();
  const outcomes = new Map<string, { text: string; conversation: ConversationKey; at: number }[]>();
  const waiters = new Map<string, ((text: string | null) => void)[]>();
  const handled = new Map<string, { result: Promise<string>; at: number }>();

  const track = (p: Promise<void>) => {
    background.add(p);
    void p.finally(() => background.delete(p));
  };

  function publish(digest: string, conversation: ConversationKey, text: string): void {
    const cutoff = now() - OUTCOME_TTL_MS;
    const queue = (outcomes.get(digest) ?? []).filter((o) => o.at >= cutoff);
    queue.push({ text, conversation, at: now() });
    outcomes.set(digest, queue);
    const waiting = waiters.get(digest);
    const first = waiting?.shift();
    if (waiting && waiting.length === 0) waiters.delete(digest);
    if (first) first(take(digest));
  }

  // Outcomes are matched by digest alone, so when two conversations made the same call at once the text of
  // either could be the wrong one's. Then neither is handed out.
  function take(digest: string): string | null {
    const cutoff = now() - OUTCOME_TTL_MS;
    const queue = (outcomes.get(digest) ?? []).filter((o) => o.at >= cutoff);
    const next = queue.shift();
    if (queue.length) outcomes.set(digest, queue);
    else outcomes.delete(digest);
    if (!next) return null;
    return new Set([next.conversation, ...queue.map((o) => o.conversation)]).size > 1 ? AMBIGUOUS_OUTCOME : next.text;
  }

  async function register(conv: Conversation, raw: unknown, reason: string, forceRevision = false): Promise<string> {
    if (conv.parent !== null) {
      return notRegistered("This is a subagent conversation. It inherits the plan registered by its parent and cannot register its own. Continue within the parent plan");
    }
    if (registry.busy(conv.key)) return notRegistered("A plan registration is already in progress for this conversation. Wait for it to finish");
    const runId = conv.promptId;
    const rejected = (reason: string) => { safeRunRecorder(deps.runs, log)?.reject(runId); return notRegistered(reason); };
    const previous = conv.plan;
    // A plan recorded while logged out was never minted, so replacing it is a first registration.
    const revising = previous?.id && conv.countedPlanId ? previous : null;

    const parsed = parsePlan(raw, previous ? previous.revision + 1 : 1, conv.promptId ?? `turn-${conv.turn}`);
    if (!parsed.ok) return rejected(parsed.error);
    const forbidden = forbiddenStep(parsed.plan);
    if (forbidden) return rejected(forbidden);

    const login = deps.login();
    if (!login || deps.mode() === "monitor") {
      registry.setPlan(conv.key, { ...parsed.plan, id: "" }, null);
      return `Plan recorded locally, not registered (${login ? "monitor_mode" : "logged_out"}).`;
    }
    if (forceRevision && !revising) return rejected("no registered plan in the current prompt to reanchor");
    if (!conv.promptId) return notRegistered("no current user prompt");
    if (!forceRevision && revising && conv.planHash === parsed.plan.hash && conv.token?.status === "active" && conv.token.jwt && conv.token.expiresAt > now()) {
      return describeRegistered(revising, conv.token, conv.kind === "revision" ? "revision" : "new", conv.countedPlanId!);
    }
    if (revising && !reason.trim()) return rejected('a plan is already registered. Pass a "reason" explaining why the plan changed');
    if (revising && conv.revisionsThisTurn >= MAX_REVISIONS_PER_TURN) return rejected(`at most ${MAX_REVISIONS_PER_TURN} revisions are allowed per user message`);
    const release = registry.acquire(conv.key);
    if (!release) return notRegistered("A plan registration is already in progress for this conversation. Wait for it to finish");
    const generation = registry.generation(conv.key)!;
    const runs = safeRunRecorder(deps.runs, log);
    const settle = runs?.registration(runId);
    try {
      const kind = revising ? "revision" : "new";
      const request = planRequest({ kind, promptId: conv.promptId, parentPlanId: conv.countedPlanId, planHash: parsed.plan.hash, epoch: conv.retirementEpoch }, requestBody(login, parsed.plan, conv.ref.conversationId, validity, deps.mintPolicy?.()));
      const pending = conv.pendingRequest;
      if (pending && pending.key !== request.key && pending.headers["X-ArmorIQ-Plan-Kind"] !== "refresh") return notConfirmed("a different request is awaiting confirmation; retry that plan first");
      const saved = pending?.key === request.key ? pending : request;
      const descriptor = saved.deadlineAt === undefined ? { ...saved, deadlineAt: now() + REQUEST_DEADLINE_MS } : saved;
      runs?.request(runId, descriptor.key, "pending");
      try {
        if (!registry.setPendingRequest(conv.key, descriptor, generation)) {
          runs?.request(runId, descriptor.key, "failed");
          return notRegistered("the prompt or authentication changed");
        }
      } catch {
        runs?.request(runId, descriptor.key, "failed");
        return notRegistered("could not persist the plan request");
      }
      return await mint(login, conv, parsed.plan, revising, reason, generation, descriptor, kind, runId);
    } finally {
      release();
      settle?.();
    }
  }

  function forbiddenStep(draft: Draft): string | null {
    const policy = deps.policy();
    for (const [i, step] of draft.steps.entries()) {
      const verdict = policy.evaluate(step.tool, step.params ?? {});
      if (verdict.effect === "forbid") {
        return `step ${i + 1} uses ${step.tool}, which the current policy forbids${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ""}: ${verdict.reason}`;
      }
    }
    return null;
  }

  async function mint(login: Login, conv: Conversation, draft: Draft, revising: Plan | null, reason: string, generation: Generation, request: PendingRequest, kind: PlanKind, runId: string | null): Promise<string> {
    const previousTokenPlanId = conv.tokenPlanId ?? revising?.id;
    const cancelled = () => {
      registry.syncAuth(deps.login(), deps.mode());
      return !registry.isCurrent(conv.key, generation);
    };
    let unreachable = false;
    let minted: Awaited<ReturnType<IntentBackend["mint"]>>;
    try {
      minted = await backend.mint(login, draft, conv.ref.conversationId, request, {
        cancelled,
        now,
        onFailure: (reason, notBefore) => {
          unreachable ||= reason === "network" || reason === "timeout";
          return Promise.resolve().then(() => deps.health?.planRequestFailed(login, request.key, reason, notBefore)).catch(() => { log.error("plan failure reporting failed"); });
        },
        onSuccess: async () => { try { await deps.health?.planRequestSucceeded(login, request.key); } catch { log.error("plan success reporting failed"); } },
      });
    } catch (error) {
      safeRunRecorder(deps.runs, log)?.request(runId, request.key, "failed", undefined, unreachable);
      throw error;
    }
    const confirmed = minted.ok && minted.value.token.status === "active" && !!minted.value.planId && !!minted.value.token.jwt && minted.value.token.expiresAt > now();
    safeRunRecorder(deps.runs, log)?.request(runId, request.key, confirmed ? "confirmed" : "failed", minted.ok ? minted.value.planId : undefined, unreachable);
    registry.syncAuth(deps.login(), deps.mode());
    if (!registry.isCurrent(conv.key, generation)) return notRegistered("the prompt or authentication changed while registration was in progress");
    if (!minted.ok) {
      if (minted.relogin) deps.onRelogin?.(minted.reason);
      if (minted.retryable || minted.unconfirmed) return notConfirmed(minted.reason);
      registry.setPendingRequest(conv.key, null, generation);
      return notRegistered(minted.reason);
    }
    const { token, planId } = minted.value;
    if (token.status === "refused" && token.code === "account_revoked" && deps.onUnauthorized) {
      deps.onUnauthorized();
      registry.syncAuth(deps.login(), deps.mode());
      registry.setPendingRequest(conv.key, null, generation);
      return notRegistered("account_revoked");
    }
    if (token.status === "refused") {
      registry.setToken(conv.key, token, generation);
      registry.setPendingRequest(conv.key, null, generation);
      return notRegistered(token.code);
    }
    if (!planId || !token.jwt || token.expiresAt <= now()) return notConfirmed("token response has no usable token or expiry");
    deps.onAuthenticated?.(login);
    if (minted.value.legacy) logLegacyBackend(log);
    const plan: Plan = { ...draft, id: planId };
    registry.setPlan(conv.key, plan, token, generation, kind);
    if (revising) {
      registry.noteRevision(conv.key);
      track(recordRevision(login, conv, revising, plan, reason, previousTokenPlanId!).catch(() => log.warn("reanchor failed", { conversationId: conv.ref.conversationId })));
    }
    return describeRegistered(plan, token, minted.value.kind ?? kind, planId);
  }

  async function recordRevision(login: Login, conv: Conversation, previous: Plan, plan: Plan, reason: string, tokenPlanId: string): Promise<void> {
    const { id: _id, ...unminted } = plan;
    const r = await backend.reanchor(login, tokenPlanId, unminted, reason);
    if (!r.ok) log.warn("reanchor failed", { conversationId: conv.ref.conversationId, reason: r.reason });
  }

  async function revoke(conv: Conversation, reason: string): Promise<string> {
    if (conv.parent !== null) return "This is a subagent conversation; its plan belongs to the parent conversation and cannot be revoked here.";
    if (registry.busy(conv.key)) return "A plan registration is in progress for this conversation. Revoke after it finishes.";
    if (!conv.plan) return "No registered plan to revoke.";
    if (!reason.trim()) return 'Revoke rejected: pass a "reason".';
    const login = deps.login();
    const release = registry.acquire(conv.key)!;
    const generation = registry.generation(conv.key)!;
    try {
      if (login && conv.plan.id) {
        const r = await backend.revoke(login, conv.tokenPlanId ?? conv.plan.id, reason);
        registry.syncAuth(deps.login(), deps.mode());
        if (!registry.isCurrent(conv.key, generation)) return "The previous prompt or login state was retired while revoking its plan.";
        if (!r.ok) return `Revoke failed: ${r.reason}. The plan is still registered.`;
      }
      registry.clearPlan(conv.key);
      return "Intent token revoked. Side-effecting calls are blocked until a new plan is registered.";
    } finally {
      release();
    }
  }

  async function delegate(conv: Conversation, args: Record<string, unknown>): Promise<string> {
    if (conv.parent !== null) return "This is a subagent conversation; only the parent conversation can delegate its plan.";
    const delegatePublicKey = str(args.delegatePublicKey);
    const subtreePath = str(args.subtreePath);
    if (!delegatePublicKey || !subtreePath) return "Delegate rejected: delegatePublicKey and subtreePath are required.";
    const validity = args.validitySeconds;
    // The MCP schema rejects these too, so a call it would refuse must not change state here first.
    if (validity !== undefined && !(typeof validity === "number" && Number.isInteger(validity) && validity > 0)) {
      return "Delegate rejected: validitySeconds must be a positive integer.";
    }
    const login = deps.login();
    if (!login || !conv.plan?.id || conv.token?.status !== "active") return "No intent token for this conversation. Register a plan first.";
    const request: DelegateRequest = {
      delegatePublicKey,
      subtreePath,
      ...(typeof validity === "number" ? { validitySeconds: validity } : {}),
      ...(str(args.targetAgent) ? { targetAgent: str(args.targetAgent) } : {}),
    };
    const r = await backend.delegate(login, conv.tokenPlanId ?? conv.plan.id, request);
    if (!r.ok) return `Delegate failed: ${r.reason}`;
    return `Delegation issued. trustId=${r.value.trustId ?? "n/a"} subtreePath=${subtreePath} subtreeRoot=${r.value.subtreeRoot || "n/a"} inclusionProofLength=${r.value.inclusionProofLength}`;
  }

  function policyRead(conv: Conversation, tool: string): string {
    const policy = deps.policy();
    const lines = [`Policy hash: ${policy.hash}`, `Intent plan required: ${policy.intentRequired ? "yes" : "no"}`, `Mode: ${deps.mode()}`];
    if (tool) {
      const v = policy.evaluate(tool, {});
      lines.push(`${tool}: ${v.effect}${v.ruleId ? ` (rule ${v.ruleId})` : ""}${v.reason ? `: ${v.reason}` : ""}`);
    }
    const t = registry.root(conv.key)?.token;
    if (t?.status === "active") {
      if (t.deniedTools.size) lines.push(`Denied by backend: ${[...t.deniedTools].join(", ")}`);
      if (t.heldTools.size) lines.push(`Held for approval by backend: ${[...t.heldTools].join(", ")}`);
    }
    return lines.join("\n");
  }

  async function run(conv: Conversation, tool: OwnTool, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "register_intent_plan": {
        const { reason, ...raw } = args;
        return register(conv, raw, str(reason));
      }
      case "trust_reanchor":
        return register(conv, { plan: args.updatedPlan }, str(args.reason), true);
      case "trust_revoke":
        return revoke(conv, str(args.reason));
      case "trust_delegate":
        return delegate(conv, args);
      case "policy_read":
        return policyRead(conv, str(args.tool));
      default: {
        const _exhaustive: never = tool;
        return _exhaustive;
      }
    }
  }

  return {
    handle(ref, tool, rawArgs, stepIdx) {
      registry.syncAuth(deps.login(), deps.mode());
      const conv = registry.open(ref);
      const cutoff = now() - OUTCOME_TTL_MS;
      for (const [k, v] of handled) if (v.at < cutoff) handled.delete(k);
      // Antigravity runs every matching hook registration, so a global and a plugin hooks.json both deliver
      // the same PreToolUse (seen twice per call in the spike capture).
      const onceKey = stepIdx === undefined ? null : `${conv.key}:${conv.promptId}:${conv.promptGeneration}:${conv.authGeneration}:${stepIdx}:${tool}`;
      const seen = onceKey ? handled.get(onceKey) : undefined;
      if (seen) return seen.result;
      const result = (async () => {
        const args = isPlainObject(rawArgs) ? rawArgs : {};
        let text: string;
        try {
          text = await run(conv, tool, args);
        } catch (error) {
          log.error("own tool failed", { tool, conversationId: ref.conversationId, error: String(error) });
          text = tool === "register_intent_plan" || tool === "trust_reanchor" ? notConfirmed("internal error") : `ArmorIQ could not process ${tool}: internal error.`;
        }
        publish(callDigest(tool, rawArgs), conversationKey(ref), text);
        return text;
      })();
      if (onceKey) handled.set(onceKey, { result, at: now() });
      if (tool === "register_intent_plan" || tool === "trust_reanchor") track(result.then(() => {}));
      return result;
    },

    outcome(tool, args, waitMs) {
      const digest = callDigest(tool, args);
      const ready = take(digest);
      if (ready !== null) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const list = waiters.get(digest);
          const i = list?.indexOf(done) ?? -1;
          if (list && i >= 0) list.splice(i, 1);
          if (list?.length === 0) waiters.delete(digest);
          resolve(null);
        }, waitMs);
        const done = (text: string | null) => {
          clearTimeout(timer);
          resolve(text);
        };
        waiters.set(digest, [...(waiters.get(digest) ?? []), done]);
      });
    },

    async settled() {
      while (background.size) await Promise.allSettled([...background]);
    },
  };
}

function describeRegistered(plan: Plan, token: Token, kind: PlanKind, countedPlanId: string): string {
  if (token.status !== "active") return notRegistered(token.code);
  const lines = [`Intent registered: plan ${countedPlanId} (${kind}), ${plan.steps.length} steps. Token valid until ${new Date(token.expiresAt).toISOString()}.`];
  if (token.deniedTools.size) lines.push(`Denied by backend: ${[...token.deniedTools].join(", ")}`);
  if (token.heldTools.size) lines.push(`Held for approval by backend: ${[...token.heldTools].join(", ")}`);
  return lines.join("\n");
}
