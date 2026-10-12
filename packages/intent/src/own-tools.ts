import { createHash } from "node:crypto";
import { isPlainObject, parsePlan } from "./plan.ts";
import type { Conversation, Registry } from "./registry.ts";
import { AGENT_ID, CLIENT_ID, conversationKey, type AuditRow, type ConversationKey, type ConversationRef, type DelegateRequest, type Draft, type IntentBackend, type Log, type Login, type Plan, type PolicyView, type Token } from "./types.ts";

export const OWN_TOOLS = ["register_intent_plan", "trust_reanchor", "trust_revoke", "trust_delegate", "policy_read"] as const;
export type OwnTool = (typeof OWN_TOOLS)[number];

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

// Hooks report our MCP tools as mcp_armoriq_<tool> (the spike's capture of mcp_<server>_<tool>).
export function ownToolName(name: string): OwnTool | null {
  const prefix = OWN_PREFIXES.find((p) => name.toLowerCase().startsWith(p));
  const bare = prefix ? name.slice(prefix.length) : name;
  return isOwnTool(bare) ? bare : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}

// MCP calls carry no conversation id, so the MCP server finds the outcome the hook computed for the same
// call by tool name plus a digest of the arguments.
export function callDigest(tool: OwnTool, args: unknown): string {
  return createHash("sha256").update(JSON.stringify([tool, stable(args ?? {})])).digest("hex");
}

export interface OwnToolDeps {
  readonly registry: Registry;
  readonly backend: IntentBackend;
  login(): Login | null;
  mode(): "enforce" | "monitor";
  policy(): PolicyView;
  audit(row: AuditRow): void;
  onRelogin?(reason: string): void;
  readonly log: Log;
  readonly now?: () => number;
}

export interface OwnTools {
  // Runs on PreToolUse for an own tool. All state changes happen here, before the MCP server answers.
  // A repeat for the same conversation and stepIdx returns the first outcome without acting again.
  handle(ref: ConversationRef, tool: OwnTool, args: unknown, stepIdx?: number): Promise<string>;
  // The MCP server's view: the outcome text for a call the hook already handled, or null after waitMs.
  outcome(tool: OwnTool, args: unknown, waitMs: number): Promise<string | null>;
  settled(): Promise<void>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function createOwnTools(deps: OwnToolDeps): OwnTools {
  const { registry, backend, log } = deps;
  const now = deps.now ?? Date.now;
  const registering = new Set<ConversationKey>();
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

  async function register(conv: Conversation, raw: unknown, reason: string): Promise<string> {
    if (conv.parent !== null) {
      return "This is a subagent conversation. It inherits the plan registered by its parent and cannot register its own. Continue within the parent plan.";
    }
    if (registering.has(conv.key)) return "A plan registration is already in progress for this conversation. Wait for it to finish.";
    const previous = conv.plan;
    // A plan recorded while logged out was never minted, so replacing it is a first registration.
    const revising = previous !== null && previous.id !== "" ? previous : null;
    if (revising && !reason.trim()) return 'Plan revision rejected: a plan is already registered. Pass a "reason" explaining why the plan changed.';
    if (revising && conv.revisionsThisTurn >= MAX_REVISIONS_PER_TURN) {
      return `Plan revision rejected: at most ${MAX_REVISIONS_PER_TURN} revisions are allowed per user message. Continue with the current plan or ask the user how to proceed.`;
    }

    const parsed = parsePlan(raw, previous ? previous.revision + 1 : 1, `turn-${conv.turn}`);
    if (!parsed.ok) return `Plan rejected: ${parsed.error}`;
    const forbidden = forbiddenStep(parsed.plan);
    if (forbidden) return forbidden;

    const login = deps.login();
    if (!login) {
      registry.setPlan(conv.key, { ...parsed.plan, id: "" }, null);
      return `Intent recorded locally: ${parsed.plan.steps.length} steps. ArmorIQ is not logged in, so calls are monitored, not enforced.`;
    }
    registering.add(conv.key);
    try {
      return await mint(login, conv, parsed.plan, previous, revising, reason);
    } finally {
      registering.delete(conv.key);
    }
  }

  function forbiddenStep(draft: Draft): string | null {
    const policy = deps.policy();
    for (const [i, step] of draft.steps.entries()) {
      const verdict = policy.evaluate(step.tool, step.params ?? {});
      if (verdict.effect === "forbid") {
        return `Plan rejected: step ${i + 1} uses ${step.tool}, which the current policy forbids${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ""}: ${verdict.reason}`;
      }
    }
    return null;
  }

  async function mint(login: Login, conv: Conversation, draft: Draft, previous: Plan | null, revising: Plan | null, reason: string): Promise<string> {
    const minted = await backend.mint(login, draft, conv.ref.conversationId);
    if (!minted.ok) {
      if (minted.relogin) deps.onRelogin?.(minted.reason);
      const kept = previous ? " The previous plan is still in effect." : " No plan is active, so side-effecting calls stay blocked.";
      return `Plan not registered: ArmorIQ could not issue an intent token (${minted.reason}).${kept} Try again shortly.`;
    }
    const { token, planId } = minted.value;
    if (token.status === "refused") {
      registry.setToken(conv.key, token);
      return token.code === "account_revoked"
        ? "Plan not registered: the ArmorIQ API key was revoked (account_revoked). Tool calls are blocked until the user logs in again."
        : "Plan not registered: the ArmorIQ organization has no active subscription or is over quota (billing_blocked). Tool calls are blocked.";
    }
    const plan: Plan = { ...draft, id: planId };
    registry.setPlan(conv.key, plan, token);
    if (revising) {
      registry.noteRevision(conv.key);
      track(recordRevision(login, conv, revising, plan, reason));
    }
    return describeRegistered(plan, token, revising !== null);
  }

  async function recordRevision(login: Login, conv: Conversation, previous: Plan, plan: Plan, reason: string): Promise<void> {
    let trustId: string | null = null;
    const { id: _id, ...unminted } = plan;
    const r = await backend.reanchor(login, previous.id, unminted, reason);
    if (r.ok) trustId = r.value.trustId;
    else log.warn("reanchor failed", { conversationId: conv.ref.conversationId, reason: r.reason });
    try {
      deps.audit({
        ...(plan.id ? { plan_id: plan.id } : {}),
        session_id: conv.ref.conversationId,
        // ArmorOpenCode omits these, so its revisions show as unknown-agent and unknown-client in the console.
        agent_id: AGENT_ID,
        client_id: CLIENT_ID,
        user_id: login.userId,
        step_index: -1,
        action: "plan_revision",
        tool: "register_intent_plan",
        input: {
          reason: reason.slice(0, 2000),
          old_plan_id: previous.id,
          old_plan_hash: previous.hash,
          new_plan_hash: plan.hash,
          revision: plan.revision,
          ...(trustId ? { trust_id: trustId } : {}),
        },
        status: "held",
        error_message: `plan_revision: ${reason.slice(0, 500)}`,
        executed_at: new Date(now()).toISOString(),
      });
    } catch (error) {
      log.error("audit enqueue failed", { error: String(error) });
    }
  }

  async function revoke(conv: Conversation, reason: string): Promise<string> {
    if (conv.parent !== null) return "This is a subagent conversation; its plan belongs to the parent conversation and cannot be revoked here.";
    if (registering.has(conv.key)) return "A plan registration is in progress for this conversation. Revoke after it finishes.";
    if (!conv.plan) return "No registered plan to revoke.";
    if (!reason.trim()) return 'Revoke rejected: pass a "reason".';
    const login = deps.login();
    if (login && conv.plan.id) {
      const r = await backend.revoke(login, conv.plan.id, reason);
      if (!r.ok) return `Revoke failed: ${r.reason}. The plan is still registered.`;
    }
    registry.clearPlan(conv.key);
    return "Intent token revoked. Side-effecting calls are blocked until a new plan is registered.";
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
    const r = await backend.delegate(login, conv.plan.id, request);
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
        if (conv.parent === null && !conv.plan) return "No registered plan to re-anchor. Call register_intent_plan first.";
        return register(conv, { plan: args.updatedPlan }, str(args.reason));
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
      const cutoff = now() - OUTCOME_TTL_MS;
      for (const [k, v] of handled) if (v.at < cutoff) handled.delete(k);
      // Antigravity runs every matching hook registration, so a global and a plugin hooks.json both deliver
      // the same PreToolUse (seen twice per call in the spike capture).
      const onceKey = stepIdx === undefined ? null : `${conversationKey(ref)}:${stepIdx}:${tool}`;
      const seen = onceKey ? handled.get(onceKey) : undefined;
      if (seen) return seen.result;
      const result = (async () => {
        const args = isPlainObject(rawArgs) ? rawArgs : {};
        const conv = registry.open(ref);
        let text: string;
        try {
          text = await run(conv, tool, args);
        } catch (error) {
          log.error("own tool failed", { tool, conversationId: ref.conversationId, error: String(error) });
          text = `ArmorIQ could not process ${tool}: internal error. No state was changed.`;
        }
        publish(callDigest(tool, rawArgs), conversationKey(ref), text);
        return text;
      })();
      if (onceKey) handled.set(onceKey, { result, at: now() });
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
      await Promise.allSettled([...background]);
    },
  };
}

function describeRegistered(plan: Plan, token: Token, isRevision: boolean): string {
  const active = token.status === "active" ? token : null;
  const expiry = active ? ` Token valid until ${new Date(active.expiresAt).toISOString()}.` : "";
  const denied = active?.deniedTools.size ? ` Denied by policy: ${[...active.deniedTools].join(", ")}.` : "";
  const held = active?.heldTools.size ? ` Requires approval: ${[...active.heldTools].join(", ")}.` : "";
  return `Intent ${isRevision ? `revised (revision ${plan.revision})` : "registered"}: ${plan.steps.length} steps.${expiry}${denied}${held}`;
}
