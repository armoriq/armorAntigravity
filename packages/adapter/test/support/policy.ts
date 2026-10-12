import { createHash } from "node:crypto";
import type { CompileResult, CoreToolCall, Log } from "../../src/core-contract.ts";

// Stand-in for core's compilePolicy until https://github.com/armoriq/armorAntigravity/pull/58
// lands policy.ts: same input contract (armor.policy.v1 or legacy rules, optionally wrapped in
// {policy}), exact-name tool rules plus the `bash.program in` condition, read
// from args.command as ArmorClaude's parseBashCommand does. Swap for the real one when it exists.
export function compileForTest(raw: unknown): CompileResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "policy must be a JSON object" };
  const body: Record<string, unknown> = "policy" in raw && typeof raw.policy === "object" && raw.policy !== null ? { ...raw.policy } : { ...raw };
  if (typeof body.schemaVersion === "string" && body.schemaVersion !== "armor.policy.v1") {
    return { ok: false, error: `unsupported schemaVersion ${body.schemaVersion}; expected armor.policy.v1` };
  }
  const statements = Array.isArray(body.statements) ? body.statements : [];
  const defaults = typeof body.defaults === "object" && body.defaults !== null && "decision" in body.defaults ? body.defaults.decision : "deny";
  type Rule = { id: string; effect: "permit" | "forbid" | "require_approval"; tools: string[]; programs: string[] | null };
  const rules: Rule[] = [];
  for (const s of statements) {
    if (typeof s !== "object" || s === null) continue;
    const id = "id" in s && typeof s.id === "string" ? s.id : "statement";
    const effect = "effect" in s && (s.effect === "permit" || s.effect === "forbid" || s.effect === "require_approval") ? s.effect : "forbid";
    const action = "action" in s && typeof s.action === "object" && s.action !== null ? s.action : {};
    const list: unknown[] = "in" in action && Array.isArray(action.in) ? action.in : ["*"];
    const tools = "eq" in action && typeof action.eq === "string" ? [action.eq] : list.filter((x): x is string => typeof x === "string");
    const conditions: unknown[] = "conditions" in s && Array.isArray(s.conditions) ? s.conditions : [];
    let programs: string[] | null = null;
    for (const c of conditions) {
      if (typeof c === "object" && c !== null && "field" in c && c.field === "bash.program" && "value" in c && Array.isArray(c.value)) {
        const values: unknown[] = c.value;
        programs = values.filter((v): v is string => typeof v === "string");
      }
    }
    rules.push({ id, effect, tools: tools.map((t) => t.toLowerCase()), programs });
  }
  return {
    ok: true,
    policy: {
      hash: createHash("sha256").update(JSON.stringify({ statements, defaults })).digest("hex"),
      intentRequired: typeof body.intentRequired === "boolean" ? body.intentRequired : true,
      evaluate(call: CoreToolCall) {
        const command = typeof call.args.command === "string" ? call.args.command : "";
        const program = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "").split(/\s+/)[0] ?? "";
        const hits = rules.filter(
          (r) => (r.tools.includes("*") || r.tools.includes(call.tool.toLowerCase())) && (r.programs === null || r.programs.includes(program)),
        );
        const forbid = hits.find((r) => r.effect === "forbid");
        if (forbid) return { effect: "forbid", ruleId: forbid.id, reason: `ArmorIQ policy forbid: ${forbid.id}` };
        const hold = hits.find((r) => r.effect === "require_approval");
        if (hold) return { effect: "require_approval", ruleId: hold.id, reason: `ArmorIQ policy requires approval: ${hold.id}` };
        const permit = hits.find((r) => r.effect === "permit");
        if (permit) return { effect: "permit", ruleId: permit.id, reason: "" };
        if (defaults === "allow") return { effect: "permit", ruleId: null, reason: "" };
        if (defaults === "hold") return { effect: "require_approval", ruleId: "default-hold", reason: `ArmorIQ policy default hold: no statement matched tool ${call.tool}` };
        return { effect: "forbid", ruleId: null, reason: `ArmorIQ policy default deny: no statement matched tool ${call.tool}` };
      },
    },
  };
}

export const DEFAULT_POLICY = {
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id: "allow-all", effect: "permit", action: { type: "tool", eq: "*" } }],
};

export type Logged = { level: "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> };

export function memoryLog(): Log & { entries: Logged[] } {
  const entries: Logged[] = [];
  const push = (level: Logged["level"]) => (message: string, extra?: Record<string, unknown>) => {
    entries.push(extra === undefined ? { level, message } : { level, message, extra });
  };
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}
