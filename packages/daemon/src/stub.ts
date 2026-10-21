import type { DecisionHandler } from "./plugin.ts";

// Placeholder until packages/core registers the real decide(). It holds no policy, so it allows.
export const stubDecide: DecisionHandler = (hook) => (hook.event === "PreToolUse" ? { decision: "allow" } : null);
