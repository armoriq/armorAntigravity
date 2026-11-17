import { backendRequest, type AdapterDecision, type BackendAccess, type Fetch, type HeldCall, type HoldResolver } from "@armorantigravity/adapter";
import { createHash, randomUUID } from "node:crypto";
import type { Log } from "./log.ts";

// Antigravity's UI fields, which the model rewrites on every retry; the backend hashes arguments to
// match an approval to its call.
const UI_ARGS: ReadonlySet<string> = new Set(["toolAction", "toolSummary"]);
const MAX_FILED = 1024;

export interface SignedPlan {
  readonly planId: string;
  readonly jwt: string;
}

export interface HoldResolverOptions {
  access(): BackendAccess | null;
  // The signed plan of the conversation's root, or null while none is registered.
  plan(conversationId: string): SignedPlan | null;
  // The agent the intent token was minted for; the backend refuses a token used by another agent.
  readonly agentId: string;
  // The `mcp` plan steps name for built-in tools, so the approval scope matches the enforce call.
  readonly builtinServer: string;
  readonly log: Log;
  readonly fetch?: Fetch;
}

type Scope = { tool: string; mcp: string; args: Record<string, unknown> };

function scopeOf(held: HeldCall, builtinServer: string): Scope {
  if (held.call.category === "mcp") return { tool: held.call.mcp.tool, mcp: held.call.mcp.server, args: { ...held.call.args } };
  return { tool: held.call.name, mcp: builtinServer, args: Object.fromEntries(Object.entries(held.rawArgs).filter(([k]) => !UI_ARGS.has(k))) };
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

// The reference flow is ArmorClaude's resolveV2Hold: /iap/sdk/enforce spends an approved request for this
// exact call, and a call still held files one request (reused until the backend spends it).
export function createHoldResolver(opts: HoldResolverOptions): HoldResolver {
  const { log } = opts;
  const filed = new Map<string, string>();

  const hold = (held: HeldCall, reason: string, next: string): AdapterDecision => ({
    kind: "hold",
    ruleId: held.ruleId,
    reason: `ArmorIQ policy "${held.policyName}" holds ${held.call.name} for approval (${reason}). ${next}.`,
  });

  const request = (access: BackendAccess, method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) =>
    backendRequest(access, { method, path, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  async function file(access: BackendAccess, plan: SignedPlan, scope: Scope, shape: string, reason: string): Promise<{ id: string } | { error: string }> {
    const known = filed.get(shape);
    if (known) return { id: known };
    const email = access.login.email;
    if (!email) return { error: "the signed-in profile has no email" };
    const headers = { "X-User-Email": email };
    const role = await request(access, "GET", "/delegation/my-role", undefined, headers);
    const roleData = role.ok ? record(role.data) : {};
    const created = await request(
      access,
      "POST",
      "/delegation/request",
      {
        tool: scope.tool,
        action: "execute",
        arguments: scope.args,
        requesterEmail: email,
        requesterRole: text(roleData.role) ?? "agent_user",
        requesterLimit: typeof roleData.limit === "number" ? roleData.limit : 0,
        domain: scope.mcp,
        planId: plan.planId,
        reason,
      },
      { ...headers, "Idempotency-Key": `agd-${randomUUID()}` },
    );
    const id = created.ok ? text(record(created.data).delegationId) : undefined;
    if (!id) return { error: created.ok ? "the backend returned no request id" : created.reason };
    filed.set(shape, id);
    if (filed.size > MAX_FILED) filed.delete(filed.keys().next().value ?? shape);
    return { id };
  }

  return async (held) => {
    const access = opts.access();
    if (!access) return hold(held, "signed out", "Sign in to ArmorIQ to request an approval");
    const plan = opts.plan(held.conversationId);
    if (!plan) return hold(held, "no signed intent plan", "Call register_intent_plan so the approval request can name the plan, then retry");
    const scope = scopeOf(held, opts.builtinServer);
    const enforced = await request(access, "POST", "/iap/sdk/enforce", {
      tool: scope.tool,
      mcp: scope.mcp,
      arguments: scope.args,
      intent_token: { jwt_token: plan.jwt, plan_id: plan.planId },
      agent_id: opts.agentId,
      ...(access.login.email ? { user_email: access.login.email } : {}),
    });
    if (!enforced.ok) return hold(held, "approval check failed", `The ArmorIQ backend did not answer the approval check (${enforced.reason}); retry later`);
    const verdict = record(enforced.data);
    const shape = createHash("sha256").update(JSON.stringify([plan.planId, scope.mcp, scope.tool, scope.args])).digest("hex");
    if (verdict.allowed === true) {
      // The backend spent the approval; the same call held again needs a new request.
      filed.delete(shape);
      log.info("held call allowed by the backend", { tool: held.call.name, reason: text(verdict.reason) ?? "allowed" });
      return { kind: "allow", stepIndex: null, paramMismatch: false };
    }
    const reason = text(verdict.reason) ?? "held";
    if (verdict.enforcementAction !== "hold") {
      return { kind: "deny", code: "policy_forbid", ruleId: held.ruleId, reason: `ArmorIQ policy "${held.policyName}" blocks ${held.call.name}: ${text(verdict.message) ?? reason}` };
    }
    const outcome = await file(access, plan, scope, shape, reason);
    if ("error" in outcome) return hold(held, reason, `The approval request could not be filed (${outcome.error}); retry later`);
    log.info("approval requested for a held call", { tool: held.call.name, delegationId: outcome.id });
    return hold(held, reason, `Approval request ${outcome.id} is waiting for another member; retry after it is approved`);
  };
}
