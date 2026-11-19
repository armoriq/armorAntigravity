import { planHash, toSdkPlan } from "./plan-request.ts";
import type { Plan, PlanStep, ToolCall } from "../types.ts";
import { CLAUDE_TO_OPENCODE, mcpToolName } from "./tools.ts";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "list", "webfetch", "websearch", "todoread", "todowrite",
]);

export type ParsePlanResult = { ok: true; plan: Omit<Plan, "id"> } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Plans written with ArmorClaude names (Bash, MultiEdit, mcp__server__tool)
// resolve to the OpenCode tool they mean.
export function planToolName(action: string): string {
  const trimmed = action.trim();
  const mcp = mcpToolName(trimmed);
  if (mcp) return mcp;
  const lower = trimmed.toLowerCase();
  return CLAUDE_TO_OPENCODE.get(lower) ?? lower;
}

function tryJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ArmorClaude dev policy-mcp.mjs coercePlanArgs: models sometimes send the
// plan wrapped in `plan`, or `steps` as a JSON string.
function coercePlanArgs(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  let args: Record<string, unknown> = raw;
  if (args.plan !== undefined) {
    const unwrapped = tryJson(args.plan);
    if (isPlainObject(unwrapped)) {
      args = { ...unwrapped, ...args };
      delete args.plan;
    }
  }
  if (typeof args.steps === "string") args = { ...args, steps: tryJson(args.steps) };
  return args;
}

// For hosts whose tool names differ from the core's: the plan arguments with each step's action and
// tool renamed, so a plan the model writes in the host's vocabulary checks against translated calls.
export function renamePlanTools(raw: unknown, rename: (name: string) => string): unknown {
  const args = coercePlanArgs(tryJson(raw));
  if (!isPlainObject(args) || !Array.isArray(args.steps)) return args;
  const renamed = (v: unknown) => {
    if (typeof v !== "string") return v;
    const name = v.trim().toLowerCase();
    const next = rename(name);
    return next === name ? v : next;
  };
  const steps = args.steps.map((step) =>
    isPlainObject(step) ? { ...step, action: renamed(step.action), ...(step.tool === undefined ? {} : { tool: renamed(step.tool) }) } : step,
  );
  return { ...args, steps };
}

// ArmorClaude dev intent-schema.mjs INTENT_PLAN_ZOD, with the same leniency.
export function parsePlan(raw: unknown, revision: number, messageId: string): ParsePlanResult {
  const args = coercePlanArgs(raw);
  if (!isPlainObject(args)) return { ok: false, error: "plan must be an object with goal and steps" };
  if (typeof args.goal !== "string" || !args.goal.trim()) return { ok: false, error: "goal: a one-line summary is required" };
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return { ok: false, error: "steps: a non-empty array of {action, description?, metadata?: {inputs?}} is required" };
  }
  const steps: PlanStep[] = [];
  for (const [idx, entry] of args.steps.entries()) {
    if (!isPlainObject(entry)) return { ok: false, error: `steps[${idx}] must be an object` };
    const action = typeof entry.action === "string" ? entry.action : typeof entry.tool === "string" ? entry.tool : "";
    if (!action.trim()) return { ok: false, error: `steps[${idx}].action is required (a tool name such as bash, edit, read)` };
    if (entry.metadata !== undefined && !isPlainObject(entry.metadata)) {
      return { ok: false, error: `steps[${idx}].metadata must be an object` };
    }
    const inputs = isPlainObject(entry.metadata) ? entry.metadata.inputs : undefined;
    if (inputs !== undefined && !isPlainObject(inputs)) {
      return { ok: false, error: `steps[${idx}].metadata.inputs must be an object` };
    }
    const tool = planToolName(typeof entry.tool === "string" && entry.tool.trim() ? entry.tool : action);
    steps.push(inputs === undefined ? { action, tool } : { action, tool, params: inputs });
  }
  let hash: string;
  try {
    hash = planHash(toSdkPlan({ goal: args.goal, steps }));
  } catch {
    return { ok: false, error: "plan must contain valid JSON values" };
  }
  return { ok: true, plan: { hash, goal: args.goal, steps, revision, registeredInMessage: messageId } };
}

// ArmorClaude common.mjs isSubsetValue.
function isSubsetValue(candidate: unknown, target: unknown): boolean {
  if (candidate === undefined) return true;
  if (candidate === null || target === null) return candidate === target;
  if (Array.isArray(candidate)) {
    return Array.isArray(target) && candidate.every((value) => target.some((item) => isSubsetValue(value, item)));
  }
  if (isPlainObject(candidate)) {
    if (!isPlainObject(target)) return false;
    for (const [key, value] of Object.entries(candidate)) if (!isSubsetValue(value, target[key])) return false;
    return true;
  }
  return candidate === target;
}

export type PlanCheck = { inPlan: boolean; stepIndex: number | null; paramMismatch: boolean };

// Tool membership decides; params are advisory as in ArmorClaude
// (strictParamCheck: false). The step chosen is the first match at or after
// the cursor, preferring one whose declared inputs the call satisfies.
export function checkCall(plan: Plan, call: ToolCall, cursor: number): PlanCheck {
  const tool = planToolName(call.tool);
  let firstMatch = -1;
  let firstAhead = -1;
  let firstAheadParams = -1;
  let unconstrained = false;
  let anyParamMatch = false;
  plan.steps.forEach((step, idx) => {
    if (step.tool !== tool) return;
    if (firstMatch < 0) firstMatch = idx;
    if (idx >= cursor && firstAhead < 0) firstAhead = idx;
    if (step.params === undefined) {
      unconstrained = true;
      return;
    }
    if (isSubsetValue(step.params, call.args)) {
      anyParamMatch = true;
      if (idx >= cursor && firstAheadParams < 0) firstAheadParams = idx;
    }
  });
  if (firstMatch < 0) return { inPlan: false, stepIndex: null, paramMismatch: false };
  const stepIndex = firstAheadParams >= 0 ? firstAheadParams : firstAhead >= 0 ? firstAhead : firstMatch;
  return { inPlan: true, stepIndex, paramMismatch: !unconstrained && !anyParamMatch };
}
