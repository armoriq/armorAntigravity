import { createHash } from "node:crypto";
import type { CompiledPolicy, PolicyEffect, ToolCall } from "../types.ts";
import { compileLinearRegex, type LinearRegex } from "./linear-regex.ts";
import { CLAUDE_TO_OPENCODE, mcpToolName, OPENCODE_TO_CLAUDE, OPENCODE_TOOLS, patchPaths, sanitizeMcpPart } from "./tools.ts";

export type CompileResult = { ok: true; policy: CompiledPolicy } | { ok: false; error: string };

export const POLICY_IR_VERSION = "armor.policy.v1";

// Normalization and hashing below are ported from ArmorClaude dev
// scripts/lib/policy-ir.mjs and policy.mjs, key order included, so the same
// policy file yields the same canonicalPolicyHash in both products.

type Json = unknown;
type Obj = Record<string, Json>;

type Selector = { type: string; eq?: string; in?: string[] };
type Condition = { field: string; op: string; value: Json };
export type Statement = {
  id: string;
  effect: PolicyEffect;
  principal: { type: string; id: string };
  action: Selector;
  resource: { type: string; scope: string };
  conditions: Condition[];
};
export type PolicyIr = {
  schemaVersion: typeof POLICY_IR_VERSION;
  kind: "PolicyProfile";
  metadata: { name: string; description: string };
  defaults: { decision: "allow" | "deny" | "hold"; conflictResolution: "deny_overrides" };
  statements: Statement[];
};

const EFFECTS = new Set(["permit", "forbid", "require_approval"]);
const DEFAULT_DECISIONS = new Set(["allow", "deny", "hold"]);
const PRINCIPAL_TYPES = new Set(["agent", "user", "org", "role"]);
const ACTION_TYPES = new Set(["tool", "mcp_server", "mcp_tool", "bash_program"]);
const RESOURCE_TYPES = new Set(["workspace", "file", "directory", "network", "mcp_server", "secret"]);
const CONDITION_FIELDS = new Set([
  "tool.name",
  "bash.program",
  "bash.raw",
  "bash.hasWriteRedirection",
  "file.path",
  "network.host",
  "mcp.server",
]);
const CONDITION_OPS = new Set(["eq", "in", "not_in", "matches", "not_matches", "starts_with", "within_workspace"]);
const KNOWN_TOOLS = new Set([
  "*", "Agent", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList", "Edit", "EnterPlanMode",
  "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Explore", "Glob", "Grep", "ListMcpResourcesTool", "LSP",
  "Monitor", "MultiEdit", "NotebookEdit", "NotebookRead", "PowerShell", "PushNotification", "Read",
  "ReadMcpResourceTool", "RemoteTrigger", "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "Skill",
  "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TeamCreate",
  "TeamDelete", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch", "WebSearch", "Workflow", "Write",
]);
const LEGACY_BASH_PROGRAMS = new Set([
  "awk", "cat", "curl", "find", "grep", "head", "jq", "less", "lf", "ls", "lsof", "nc", "netstat", "nmap", "sed",
  "ss", "tail", "tree", "psql", "gcloud", "kubectl", "aws", "az",
]);

function isPlainObject(value: unknown): value is Obj {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function stable(value: Json): Json {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "rules")
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function actionValue(action: Json): string[] {
  if (!isPlainObject(action)) return [];
  if (typeof action.eq === "string") return [action.eq];
  if (Array.isArray(action.in)) return action.in.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function selectorForValues(values: string[]): Selector {
  const clean = values.filter((value) => typeof value === "string" && value.trim());
  if (clean.length === 1) return { type: "tool", eq: clean[0]! };
  return { type: "tool", in: clean };
}

function safeToolSuffix(tool: string): string {
  return String(tool).replace(/[^A-Za-z0-9_-]/g, "_");
}

// ArmorClaude would read a legacy `grep` rule as the shell program; here
// `grep` is a built-in tool, so it stays a tool rule.
function isLegacyBashProgramTool(value: string, tolerateOpenCode: boolean): boolean {
  if (KNOWN_TOOLS.has(value)) return false;
  if (tolerateOpenCode && OPENCODE_TOOLS.has(value)) return false;
  return LEGACY_BASH_PROGRAMS.has(normalizeToolName(value));
}

function normalizeLegacyAction(action: unknown): PolicyEffect {
  if (action === "deny") return "forbid";
  if (action === "require_approval") return "require_approval";
  return "permit";
}

type LegacyRule = { id: string; action: string; tool: string };

function normalizeLegacyRule(rule: Json): LegacyRule | null {
  if (!isPlainObject(rule)) return null;
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  const action = typeof rule.action === "string" ? rule.action.trim() : "";
  const tool = typeof rule.tool === "string" ? rule.tool.trim() : "";
  if (!id || !tool || !["allow", "deny", "require_approval"].includes(action)) return null;
  return { id, action, tool };
}

function legacyRulesToPolicyIr(rules: LegacyRule[], tolerateOpenCode: boolean): PolicyIr {
  const statements = rules.map((rule, idx) => {
    const tool = rule.tool || "*";
    const effect = normalizeLegacyAction(rule.action);
    const program = tool.trim().toLowerCase();
    const isBashProgram = isLegacyBashProgramTool(tool, tolerateOpenCode);
    return {
      id: rule.id || `policy${idx + 1}`,
      effect,
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: isBashProgram ? "Bash" : tool },
      resource: { type: "workspace", scope: "current" },
      conditions: isBashProgram
        ? [
            { field: "bash.program", op: "in", value: [program] },
            ...(effect === "permit" ? [{ field: "bash.hasWriteRedirection", op: "eq", value: false }] : []),
          ]
        : [],
    };
  });
  return normalizePolicyIr(
    {
      schemaVersion: POLICY_IR_VERSION,
      kind: "PolicyProfile",
      metadata: { name: "current", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements,
    },
    tolerateOpenCode,
  );
}

function normalizeSelector(selector: Json, fallbackType: string): Selector {
  const input = isPlainObject(selector) ? selector : {};
  const out: Selector = { type: ACTION_TYPES.has(input.type as string) ? (input.type as string) : fallbackType };
  if (typeof input.eq === "string" && input.eq.trim()) out.eq = input.eq.trim();
  if (Array.isArray(input.in)) {
    out.in = input.in
      .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      .map((entry) => entry.trim());
  }
  if (!out.eq && !out.in) out.eq = "*";
  return out;
}

function normalizeCondition(condition: Json): Condition | null {
  if (!isPlainObject(condition)) return null;
  const field = typeof condition.field === "string" ? condition.field.trim() : "";
  const op = typeof condition.op === "string" ? condition.op.trim() : "";
  if (!CONDITION_FIELDS.has(field) || !CONDITION_OPS.has(op)) return null;
  return { field, op, value: condition.value };
}

function normalizeStatement(statement: Json, idx: number): Statement {
  const input = isPlainObject(statement) ? statement : {};
  const principal = isPlainObject(input.principal) ? input.principal : {};
  const resource = isPlainObject(input.resource) ? input.resource : {};
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `statement${idx + 1}`,
    effect: EFFECTS.has(input.effect as string) ? (input.effect as PolicyEffect) : "forbid",
    principal: {
      type: PRINCIPAL_TYPES.has(principal.type as string) ? (principal.type as string) : "agent",
      id: typeof principal.id === "string" && principal.id.trim() ? principal.id.trim() : "claude-code",
    },
    action: normalizeSelector(input.action, "tool"),
    resource: {
      type: RESOURCE_TYPES.has(resource.type as string) ? (resource.type as string) : "workspace",
      scope: typeof resource.scope === "string" && resource.scope ? resource.scope : "current",
    },
    conditions: Array.isArray(input.conditions)
      ? input.conditions.map(normalizeCondition).filter((c): c is Condition => c !== null)
      : [],
  };
}

function hasCondition(conditions: Condition[], field: string, op: string): boolean {
  return conditions.some((condition) => condition.field === field && condition.op === op);
}

function normalizeStatementGroup(statement: Json, idx: number, tolerateOpenCode: boolean): Statement[] {
  const normalized = normalizeStatement(statement, idx);
  if (normalized.action.type !== "tool") return [normalized];
  const values = actionValue(normalized.action);
  const bashPrograms = values.filter((v) => isLegacyBashProgramTool(v, tolerateOpenCode)).map(normalizeToolName);
  if (!bashPrograms.length) return [normalized];
  const toolValues = values.filter((v) => !isLegacyBashProgramTool(v, tolerateOpenCode));
  const repairedBash: Statement = {
    ...normalized,
    id: toolValues.length ? `${normalized.id}-bash-programs` : normalized.id,
    action: { type: "tool", eq: "Bash" },
    conditions: [
      ...normalized.conditions,
      { field: "bash.program", op: "in", value: [...new Set(bashPrograms)] },
      ...(normalized.effect === "permit" && !hasCondition(normalized.conditions, "bash.hasWriteRedirection", "eq")
        ? [{ field: "bash.hasWriteRedirection", op: "eq", value: false }]
        : []),
    ],
  };
  if (!toolValues.length) return [repairedBash];
  return [{ ...normalized, action: selectorForValues(toolValues) }, repairedBash];
}

function splitToolStatementBase(statement: Statement): string | null {
  if (statement.action.type !== "tool" || typeof statement.action.eq !== "string") return null;
  const tool = statement.action.eq;
  if (!KNOWN_TOOLS.has(tool) || tool === "*" || tool === "Bash") return null;
  const suffix = `-${safeToolSuffix(tool)}`;
  if (!statement.id.endsWith(suffix)) return null;
  return statement.id.slice(0, -suffix.length);
}

function compactPolicyStatements(statements: Statement[]): Statement[] {
  const out: (Statement | null)[] = [];
  const groups = new Map<string, { index: number; baseId: string; statement: Statement; tools: string[] }>();
  for (const statement of statements) {
    const baseId = splitToolStatementBase(statement);
    if (!baseId) {
      out.push(statement);
      continue;
    }
    const key = JSON.stringify({
      id: baseId,
      effect: statement.effect,
      principal: statement.principal,
      resource: statement.resource,
      conditions: statement.conditions,
    });
    let group = groups.get(key);
    if (!group) {
      group = { index: out.length, baseId, statement, tools: [] };
      groups.set(key, group);
      out.push(null);
    }
    group.tools.push(statement.action.eq!);
  }
  for (const group of groups.values()) {
    out[group.index] = { ...group.statement, id: group.baseId, action: selectorForValues([...new Set(group.tools)]) };
  }
  return out.filter((s): s is Statement => s !== null);
}

export function normalizePolicyIr(policyLike: Json, tolerateOpenCode = true): PolicyIr {
  if (isPlainObject(policyLike) && policyLike.schemaVersion === POLICY_IR_VERSION) {
    const metadata = isPlainObject(policyLike.metadata) ? policyLike.metadata : {};
    const defaults = isPlainObject(policyLike.defaults) ? policyLike.defaults : {};
    const statements = Array.isArray(policyLike.statements) ? policyLike.statements : [];
    return {
      schemaVersion: POLICY_IR_VERSION,
      kind: "PolicyProfile",
      metadata: {
        name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : "current",
        description: typeof metadata.description === "string" ? metadata.description : "",
      },
      defaults: {
        decision: DEFAULT_DECISIONS.has(defaults.decision as string)
          ? (defaults.decision as PolicyIr["defaults"]["decision"])
          : "deny",
        conflictResolution: "deny_overrides",
      },
      statements: compactPolicyStatements(
        statements.flatMap((statement, idx) => normalizeStatementGroup(statement, idx, tolerateOpenCode)),
      ),
    };
  }
  const rules = isPlainObject(policyLike) && Array.isArray(policyLike.rules) ? policyLike.rules : [];
  return legacyRulesToPolicyIr(
    rules.map(normalizeLegacyRule).filter((r): r is LegacyRule => r !== null),
    tolerateOpenCode,
  );
}

export function canonicalPolicyHash(ir: PolicyIr): string {
  return createHash("sha256").update(JSON.stringify(stable(ir))).digest("hex");
}

// --- Matching -------------------------------------------------------------

type Fields = {
  call: ToolCall;
  bash: { raw: string; program: string; hasWriteRedirection: boolean } | null;
  filePath: string | null;
  host: string | null;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ArmorClaude parseBashCommand, without split(/\s+/) over the whole command.
function bashFields(f: Fields): NonNullable<Fields["bash"]> {
  if (f.bash) return f.bash;
  const raw = str(f.call.args.command).trim();
  const withoutEnv = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  const program = (/^\S*/.exec(withoutEnv)?.[0] ?? "").replace(/^["'`]+|["'`]+$/g, "");
  f.bash = {
    raw,
    program,
    hasWriteRedirection: /(^|[^<])>{1,2}|\btee\b|\bsed\s+-i\b|\btruncate\b|\bdd\b/.test(raw),
  };
  return f.bash;
}

function filePath(f: Fields): string {
  if (f.filePath === null) {
    const a = f.call.args;
    f.filePath = str(a.filePath) || str(a.file_path) || str(a.path);
  }
  return f.filePath;
}

function networkHost(f: Fields): string {
  if (f.host === null) {
    const a = f.call.args;
    const url = str(a.url) || (/https?:\/\/[^\s'"]+/.exec(str(a.command))?.[0] ?? "");
    try {
      f.host = url ? new URL(url).host : "";
    } catch {
      f.host = "";
    }
  }
  return f.host;
}

// OpenCode names an MCP tool sanitize(server) + "_" + sanitize(tool), so a
// server containing "_" is ambiguous: every "_" is a possible split point.
function mcpServerCandidates(tool: string): string[] {
  if (tool.startsWith("mcp__")) return [tool.split("__")[1] ?? ""];
  if (OPENCODE_TOOLS.has(tool)) return [""];
  const out: string[] = [];
  for (let i = tool.indexOf("_"); i > 0; i = tool.indexOf("_", i + 1)) out.push(tool.slice(0, i));
  return out.length ? out : [""];
}

function toolNameCandidates(tool: string): string[] {
  const claude = OPENCODE_TO_CLAUDE.get(tool);
  return claude ? [tool, claude] : [tool];
}

function fieldValue(field: string, f: Fields): unknown {
  switch (field) {
    case "bash.program":
      return bashFields(f).program;
    case "bash.raw":
      return bashFields(f).raw;
    case "bash.hasWriteRedirection":
      return bashFields(f).hasWriteRedirection;
    case "file.path":
      return filePath(f);
    case "network.host":
      return networkHost(f);
    default:
      return undefined;
  }
}

type Predicate = (f: Fields) => boolean;

function testPredicate(op: string, value: Json, where: string): ((actual: unknown) => boolean) | string {
  switch (op) {
    case "eq":
      return (actual) => actual === value;
    case "in":
    case "not_in":
      return Array.isArray(value) ? (actual) => value.includes(actual) : () => false;
    case "matches":
    case "not_matches": {
      if (typeof value !== "string") return () => false;
      const compiled = compileLinearRegex(value);
      if (!compiled.ok) return `${where}: ${compiled.error}`;
      const re: LinearRegex = compiled.regex;
      return (actual) => re.test(String(actual));
    }
    case "starts_with":
      return typeof value === "string" ? (actual) => String(actual).startsWith(value) : () => false;
    case "within_workspace":
      return (actual) => typeof actual === "string" && !actual.startsWith("/") && !actual.includes("..");
    default:
      return () => false;
  }
}

// tool.name and mcp.server can have several readings of one OpenCode name
// (`bash` is also ArmorClaude's `Bash`). A positive op matches if any reading
// does; a negated op holds only if none does.
function multiValued(field: string): ((f: Fields) => string[]) | null {
  if (field === "tool.name") return (f) => toolNameCandidates(f.call.tool);
  if (field === "mcp.server") return (f) => mcpServerCandidates(f.call.tool);
  return null;
}

function expectedNames(field: string, value: Json): Json {
  const widen = (v: Json): Json[] => {
    if (typeof v !== "string") return [v];
    if (field === "mcp.server") return [v, sanitizeMcpPart(v)];
    return [v, ...selectorNames({ type: "tool", eq: v }).names];
  };
  if (Array.isArray(value)) return value.flatMap(widen);
  return widen(value);
}

function compileCondition(condition: Condition, where: string): Predicate | string {
  const { field, op } = condition;
  const negated = op === "not_in" || op === "not_matches";
  const many = multiValued(field);
  let value = condition.value;
  if (many && (op === "eq" || op === "in" || op === "not_in")) {
    value = expectedNames(field, value);
    if (op === "eq") return compileCondition({ field, op: "in", value }, where);
  }
  const test = testPredicate(op, value, where);
  if (typeof test === "string") return test;
  if (many) {
    if (op === "within_workspace") return (f) => test(many(f)[0]);
    return negated ? (f) => !many(f).some(test) : (f) => many(f).some(test);
  }
  return negated ? (f) => !test(fieldValue(field, f)) : (f) => test(fieldValue(field, f));
}

function selectorNames(selector: Selector): { any: boolean; names: Set<string> } {
  const values = actionValue(selector);
  const names = new Set<string>();
  for (const value of values) {
    const lower = normalizeToolName(value);
    names.add(lower);
    const mapped = CLAUDE_TO_OPENCODE.get(lower);
    if (mapped) names.add(mapped);
    const mcp = mcpToolName(value.trim());
    if (mcp) names.add(mcp);
  }
  // apply_patch is the edit tool OpenCode offers some models instead of
  // write and edit; rules on those must reach it.
  if (names.has("write") || names.has("edit")) names.add("apply_patch");
  return { any: values.includes("*"), names };
}

type Rule = { statement: Statement; any: boolean; names: Set<string>; conditions: Predicate[] };
type Verdict = ReturnType<CompiledPolicy["evaluate"]>;

const MAX_CANDIDATE_CACHE = 1024;
const SEVERITY: Record<PolicyEffect, number> = { permit: 0, require_approval: 1, forbid: 2 };

function buildEvaluator(ir: PolicyIr, rules: Rule[]): CompiledPolicy["evaluate"] {
  const candidates = new Map<string, Rule[]>();
  const forTool = (name: string): Rule[] => {
    let list = candidates.get(name);
    if (!list) {
      list = rules.filter((r) => r.any || r.names.has(name));
      if (candidates.size >= MAX_CANDIDATE_CACHE) candidates.clear();
      candidates.set(name, list);
    }
    return list;
  };

  const evaluateOne = (call: ToolCall, path: string | null): Verdict => {
    const fields: Fields = { call, bash: null, filePath: path, host: null };
    let approval: Rule | null = null;
    let permit: Rule | null = null;
    for (const rule of forTool(normalizeToolName(call.tool))) {
      if (rule.statement.effect !== "forbid" && (rule.statement.effect === "permit" ? permit : approval)) continue;
      if (!rule.conditions.every((c) => c(fields))) continue;
      if (rule.statement.effect === "forbid") {
        return { effect: "forbid", ruleId: rule.statement.id, reason: `ArmorIQ policy forbid: ${rule.statement.id}` };
      }
      if (rule.statement.effect === "require_approval") approval = rule;
      else permit = rule;
    }
    if (approval) {
      const id = approval.statement.id;
      return { effect: "require_approval", ruleId: id, reason: `ArmorIQ policy requires approval: ${id}` };
    }
    if (permit) return { effect: "permit", ruleId: permit.statement.id, reason: "" };
    const decision = ir.defaults.decision;
    if (decision === "allow") return { effect: "permit", ruleId: null, reason: "" };
    if (decision === "hold") {
      return {
        effect: "require_approval",
        ruleId: "default-hold",
        reason: `ArmorIQ policy default hold: no statement matched tool ${call.tool}`,
      };
    }
    return { effect: "forbid", ruleId: null, reason: `ArmorIQ policy default deny: no statement matched tool ${call.tool}` };
  };

  return (call) => {
    if (call.tool !== "apply_patch" || typeof call.args.patchText !== "string") return evaluateOne(call, null);
    // One patch can touch many files: evaluate each path as its own write and
    // keep the most severe result.
    const paths = patchPaths(call.args.patchText);
    if (paths.length === 0) return evaluateOne(call, null);
    let worst: Verdict | null = null;
    for (const p of paths) {
      const v = evaluateOne(call, p);
      if (!worst || SEVERITY[v.effect] > SEVERITY[worst.effect]) worst = v;
      if (v.effect === "forbid") break;
    }
    return worst!;
  };
}

function checkConditionNames(body: Obj): string | null {
  if (body.schemaVersion !== POLICY_IR_VERSION || !Array.isArray(body.statements)) return null;
  for (const [idx, statement] of body.statements.entries()) {
    if (!isPlainObject(statement) || !Array.isArray(statement.conditions)) continue;
    const id = typeof statement.id === "string" ? statement.id : `#${idx}`;
    for (const condition of statement.conditions) {
      const field = isPlainObject(condition) ? condition.field : undefined;
      const op = isPlainObject(condition) ? condition.op : undefined;
      // ArmorClaude drops these silently, which turns a conditional permit into an unconditional one.
      if (typeof field !== "string" || !CONDITION_FIELDS.has(field.trim())) {
        return `statement ${id}: unknown condition field ${JSON.stringify(field)}`;
      }
      if (typeof op !== "string" || !CONDITION_OPS.has(op.trim())) return `statement ${id}: unknown condition op ${JSON.stringify(op)}`;
    }
  }
  return null;
}

// Accepts the armor.policy.v1 IR, the legacy {rules: [...]} format, and either
// wrapped in ArmorClaude's policy state file ({version, policy}).
// `intentRequired` (top level of the file or of the policy) defaults to true.
export function compilePolicy(raw: unknown): CompileResult {
  if (!isPlainObject(raw)) return { ok: false, error: "policy must be a JSON object" };
  const body = isPlainObject(raw.policy) ? raw.policy : raw;
  if (typeof body.schemaVersion === "string" && body.schemaVersion !== POLICY_IR_VERSION) {
    return { ok: false, error: `unsupported schemaVersion ${body.schemaVersion}; expected ${POLICY_IR_VERSION}` };
  }
  if (body.schemaVersion === undefined && body.rules !== undefined && !Array.isArray(body.rules)) {
    return { ok: false, error: "rules must be an array" };
  }
  const intentFlag = body.intentRequired ?? raw.intentRequired;
  if (intentFlag !== undefined && typeof intentFlag !== "boolean") {
    return { ok: false, error: "intentRequired must be a boolean" };
  }

  const badCondition = checkConditionNames(body);
  if (badCondition) return { ok: false, error: badCondition };

  const ir = normalizePolicyIr(body);
  const rules: Rule[] = [];
  for (const statement of ir.statements) {
    const conditions: Predicate[] = [];
    for (const [idx, condition] of statement.conditions.entries()) {
      const compiled = compileCondition(condition, `statement ${statement.id} condition ${idx}`);
      if (typeof compiled === "string") return { ok: false, error: compiled };
      conditions.push(compiled);
    }
    rules.push({ statement, ...selectorNames(statement.action), conditions });
  }

  return {
    ok: true,
    policy: {
      hash: canonicalPolicyHash(ir),
      intentRequired: intentFlag ?? true,
      evaluate: buildEvaluator(ir, rules),
    },
  };
}

// ArmorClaude's fresh-install policy: allow every tool.
export const DEFAULT_POLICY_SOURCE: unknown = {
  schemaVersion: POLICY_IR_VERSION,
  defaults: { decision: "allow" },
  statements: [{ id: "allow-all", effect: "permit", action: { type: "tool", eq: "*" } }],
};
