import { parsePlan, type Session, type SessionID, type Token } from "@armorantigravity/core";
import type { BackendToolLists } from "../../src/backend-lists.ts";
import { ANTIGRAVITY_TOOLS, createCoreDecide } from "../../src/product.ts";

export const OWN_TOOLS = new Set(["register_intent_plan", "trust_reanchor", "trust_revoke", "policy_read", "trust_delegate"]);

function isSessionId(id: string): id is SessionID {
  return id.length > 0;
}

// A root session as the intent registry leaves it after register_intent_plan
// and a successful mint: plan registered through core parsePlan, token live.
export function registeredSession(opts: {
  id: string;
  steps: readonly string[] | null;
  lists?: BackendToolLists;
  now: number;
}): Session {
  if (!isSessionId(opts.id)) throw new Error("empty session id");
  let plan: Session["plan"] = null;
  if (opts.steps) {
    const parsed = parsePlan({ goal: "fix the cart total", steps: opts.steps.map((action) => ({ action })) }, 0, "msg-1", ANTIGRAVITY_TOOLS);
    if (!parsed.ok) throw new Error(parsed.error);
    plan = { ...parsed.plan, id: "plan-1" };
  }
  const token: Token | null = opts.steps
    ? {
        status: "active",
        jwt: "jwt",
        expiresAt: opts.now + 3_600_000,
        deniedTools: opts.lists?.deniedTools ?? new Set(),
        heldTools: opts.lists?.heldTools ?? new Set(),
      }
    : null;
  return { id: opts.id, parentId: null, mode: "enforce", plan, token, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: "msg-1" };
}

export function coreDecide(opts: { home: string; steps: readonly string[] | null; lists?: BackendToolLists; now: number }) {
  return createCoreDecide({
    sessions: (id) => {
      const s = registeredSession({ id, steps: opts.steps, ...(opts.lists ? { lists: opts.lists } : {}), now: opts.now });
      return { session: s, root: s };
    },
    builtin: { armoriqDir: `${opts.home}/.armoriq`, ownTools: OWN_TOOLS, shadowedTools: new Set() },
  });
}
