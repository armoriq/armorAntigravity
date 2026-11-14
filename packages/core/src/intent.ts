import { createHash } from "node:crypto";
import type { ToolVocabulary } from "./product.ts";
import type { Plan, PlanStep, ToolCall } from "./types.ts";

export type ParsePlanResult = { ok: true; plan: Omit<Plan, "id"> } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function stepHashShape(step: PlanStep): unknown {
  return step.params === undefined ? { action: step.action, tool: step.tool } : step;
}

// ArmorClaude dev intent-schema.mjs INTENT_PLAN_ZOD, with the same leniency.
export function parsePlan(raw: unknown, revision: number, messageId: string, tools: ToolVocabulary): ParsePlanResult {
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
    const tool = tools.canonical(typeof entry.tool === "string" && entry.tool.trim() ? entry.tool : action);
    steps.push(inputs === undefined ? { action, tool } : { action, tool, params: inputs });
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ goal: args.goal, steps: steps.map(stepHashShape) }))
    .digest("hex");
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
export function checkCall(plan: Plan, call: ToolCall, cursor: number, tools: ToolVocabulary): PlanCheck {
  const tool = tools.canonical(call.tool);
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
