import { createHash } from "node:crypto";
import type { Draft, PlanStep } from "./types.ts";

// Claude, OpenCode and agy 1.4 names a model may write in a plan, mapped to the Antigravity tool they mean (PRD 5.3).
const PLAN_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read_file", "view_file"],
  ["write_file", "write_to_file"],
  ["edit_file", "replace_file_content"],
  ["bash", "run_command"],
  ["shell", "run_command"],
  ["write", "write_to_file"],
  ["edit", "replace_file_content"],
  ["multiedit", "multi_replace_file_content"],
  ["apply_patch", "multi_replace_file_content"],
  ["notebookedit", "notebook_edit"],
  ["read", "view_file"],
  ["notebookread", "view_file"],
  ["ls", "list_dir"],
  ["list", "list_dir"],
  ["glob", "find_by_name"],
  ["grep", "grep_search"],
  ["webfetch", "read_url_content"],
  ["websearch", "search_web"],
  ["task", "invoke_subagent"],
  ["agent", "invoke_subagent"],
]);

// Antigravity picks between these per edit count, so a plan naming either covers both.
const EQUIVALENT: ReadonlyMap<string, string> = new Map([["multi_replace_file_content", "replace_file_content"]]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const mcpPart = (part: string) => part.trim().replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();

// Hooks name an MCP call mcp_<server>_<tool> with the server's dashes as underscores (spike capture of
// mcp_chrome_devtools_list_pages, agy CLI). Plans may also use ArmorClaude's mcp__server__tool or
// Antigravity's permission form mcp(server/tool).
export function mcpPlanName(server: string, tool: string): string {
  return `mcp_${mcpPart(server)}_${mcpPart(tool)}`;
}

function mcpForm(name: string): string | null {
  const paren = /^mcp\(([^/()]+)\/([^/()]+)\)$/i.exec(name);
  if (paren) return mcpPlanName(paren[1]!, paren[2]!);
  if (!name.toLowerCase().startsWith("mcp__")) return null;
  const sep = name.indexOf("__", 5);
  if (sep === -1 || sep + 2 >= name.length) return null;
  return mcpPlanName(name.slice(5, sep), name.slice(sep + 2));
}

export function planToolName(raw: string): string {
  const trimmed = raw.trim();
  const mcp = mcpForm(trimmed);
  if (mcp) return mcp;
  const lower = trimmed.toLowerCase();
  return PLAN_ALIASES.get(lower) ?? lower;
}

const family = (tool: string) => EQUIVALENT.get(tool) ?? tool;

function tryJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Models sometimes wrap the plan in `plan` or send `steps` as a JSON string (ArmorClaude coercePlanArgs).
function coercePlanArgs(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  let args = raw;
  if (args.plan !== undefined) {
    const unwrapped = tryJson(args.plan);
    if (isPlainObject(unwrapped)) {
      const { plan: _plan, ...rest } = args;
      args = { ...unwrapped, ...rest };
    }
  }
  if (typeof args.steps === "string") args = { ...args, steps: tryJson(args.steps) };
  return args;
}

const stepHashShape = (step: PlanStep): unknown => (step.params === undefined ? { action: step.action, tool: step.tool } : step);

export type ParsePlanResult = { readonly ok: true; readonly plan: Draft } | { readonly ok: false; readonly error: string };

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
    if (!action.trim()) return { ok: false, error: `steps[${idx}].action is required (a tool name such as run_command or write_to_file)` };
    if (entry.metadata !== undefined && !isPlainObject(entry.metadata)) return { ok: false, error: `steps[${idx}].metadata must be an object` };
    const inputs = isPlainObject(entry.metadata) ? entry.metadata.inputs : undefined;
    if (inputs !== undefined && !isPlainObject(inputs)) return { ok: false, error: `steps[${idx}].metadata.inputs must be an object` };
    const tool = planToolName(typeof entry.tool === "string" && entry.tool.trim() ? entry.tool : action);
    steps.push(inputs === undefined ? { action, tool } : { action, tool, params: inputs });
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ goal: args.goal, steps: steps.map(stepHashShape) }))
    .digest("hex");
  return { ok: true, plan: { hash, goal: args.goal, steps, revision, registeredInMessage: messageId } };
}

function isSubsetValue(candidate: unknown, target: unknown): boolean {
  if (candidate === undefined) return true;
  if (candidate === null || target === null) return candidate === target;
  if (Array.isArray(candidate)) return Array.isArray(target) && candidate.every((v) => target.some((t) => isSubsetValue(v, t)));
  if (isPlainObject(candidate)) {
    if (!isPlainObject(target)) return false;
    return Object.entries(candidate).every(([k, v]) => isSubsetValue(v, target[k]));
  }
  return candidate === target;
}

export type PlanCheck =
  | { readonly inPlan: false }
  | { readonly inPlan: true; readonly stepIndex: number; readonly paramMismatch: boolean };

// Tool membership decides; params are advisory. The step chosen is the first match at or after the
// cursor, preferring one whose declared inputs the call satisfies (ArmorOpenCode core/intent.ts checkCall).
export function checkCall(steps: readonly PlanStep[], callTool: string, args: unknown, cursor: number): PlanCheck {
  const tool = family(planToolName(callTool));
  let firstMatch = -1;
  let firstAhead = -1;
  let firstAheadParams = -1;
  let unconstrained = false;
  let anyParamMatch = false;
  steps.forEach((step, idx) => {
    if (family(step.tool) !== tool) return;
    if (firstMatch < 0) firstMatch = idx;
    if (idx >= cursor && firstAhead < 0) firstAhead = idx;
    if (step.params === undefined) {
      unconstrained = true;
      return;
    }
    if (isSubsetValue(step.params, args)) {
      anyParamMatch = true;
      if (idx >= cursor && firstAheadParams < 0) firstAheadParams = idx;
    }
  });
  if (firstMatch < 0) return { inPlan: false };
  const stepIndex = firstAheadParams >= 0 ? firstAheadParams : firstAhead >= 0 ? firstAhead : firstMatch;
  return { inPlan: true, stepIndex, paramMismatch: !unconstrained && !anyParamMatch };
}
