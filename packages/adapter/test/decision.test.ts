import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookEvent, HookPayload } from "@armorantigravity/protocol";
import { backendToolLists } from "../src/backend-lists.ts";
import type { Mode } from "../src/core-contract.ts";
import { createDecisionHandler, type DecideFn, type DecisionRecord } from "../src/decision.ts";
import { guardPaths } from "../src/guard.ts";
import { createMcpGate, type McpGate } from "../src/mcp-gate.ts";
import { parseHookPayload } from "../src/payload.ts";
import { createPolicySource } from "../src/policy-source.ts";
import { decideForTest } from "./support/decide.ts";
import { fixture } from "./fixtures.ts";
import { compileForTest, DEFAULT_POLICY, memoryLog } from "./support/policy.ts";

const home = "/Users/dev";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(opts: { policy?: unknown; decide?: DecideFn; gate?: McpGate; onDecision?: (r: DecisionRecord) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agd-decision-"));
  const path = join(dir, "policy.json");
  if (opts.policy !== undefined) writeFileSync(path, JSON.stringify(opts.policy));
  const log = memoryLog();
  const policy = createPolicySource({ path, compile: compileForTest, defaultSource: DEFAULT_POLICY, access: () => null, log });
  cleanups.push(() => {
    policy.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const records: DecisionRecord[] = [];
  const handle = createDecisionHandler({
    decide: opts.decide ?? decideForTest(),
    policy,
    mcpGate: opts.gate ?? createMcpGate({ access: () => null, log, ownServer: "armoriq" }),
    guard: { home, protectedPaths: guardPaths(home) },
    log,
    onDecision: opts.onDecision ?? ((r) => records.push(r)),
  });
  return { handle, records, log };
}

function hook(event: HookEvent, raw: unknown, mode: Mode = "enforce") {
  const r = parseHookPayload(event, raw);
  if (!r.ok) throw new Error(r.error);
  const payload: HookPayload = r.payload;
  return { payload, mode, receivedAt: 1_760_000_000_000 };
}

const withTool = (path: string, toolCall: { name: string; args: unknown }) => ({ ...(fixture(path) as object), toolCall });
const runCommand = (CommandLine: string) => withTool("documented/pre-run-command.json", { name: "run_command", args: { CommandLine, Cwd: "/Users/dev/src/shop-api" } });

const rule = (id: string, effect: string, tool: string) => ({
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id, effect, action: { type: "tool", eq: tool } }],
});

describe("allow", () => {
  test("an allowed call returns no opinion so Antigravity's own permissions still apply", () => {
    const { handle, records } = setup();
    expect(handle(hook("PreToolUse", fixture("documented/pre-write-to-file.json")))).toEqual({});
    expect(records[0]).toMatchObject({ status: "allowed", stepIdx: 7, call: { name: "write_to_file", tool: "write" } });
  });

  test("events other than PreToolUse are not judged here", () => {
    const { handle, records } = setup();
    expect(handle(hook("PreInvocation", fixture("documented/pre-invocation.json")))).toEqual({});
    expect(handle(hook("PostToolUse", fixture("documented/post-view-file-error.json")))).toEqual({});
    expect(records).toEqual([]);
  });
});

describe("built-in guard (#16)", () => {
  test("writing hooks.json is denied before policy, in enforce and in monitor", () => {
    const raw = withTool("documented/pre-write-to-file.json", { name: "write_to_file", args: { TargetFile: `${home}/.gemini/config/hooks.json`, CodeContent: "{}" } });
    for (const mode of ["enforce", "monitor"] as const) {
      const { handle, records } = setup();
      const res = handle(hook("PreToolUse", raw, mode));
      expect(res).toMatchObject({ decision: "deny" });
      expect("reason" in res && res.reason).toStartWith("ArmorIQ blocked this call [builtin_protected]: write_to_file may not modify");
      expect(records[0]).toMatchObject({ status: "blocked", decision: { code: "builtin_protected", ruleId: "builtin:guard_files" } });
    }
  });

  test("run_command removing the plugin dir in a later segment is denied", () => {
    const { handle } = setup();
    expect(handle(hook("PreToolUse", runCommand("npm test && rm -rf ~/.gemini/config/plugins/armoriq")))).toMatchObject({ decision: "deny" });
  });
});

describe("native approval (#18)", () => {
  test("policy require_approval returns force_ask and a held record", () => {
    const { handle, records } = setup({ policy: rule("approve-writes", "require_approval", "write") });
    const res = handle(hook("PreToolUse", fixture("documented/pre-write-to-file.json")));
    expect(res).toEqual({ decision: "force_ask", reason: "ArmorIQ needs your approval: ArmorIQ policy requires approval: approve-writes" });
    expect(records[0]).toMatchObject({ status: "held", decision: { kind: "hold", ruleId: "approve-writes" }, response: res });
  });

  test("backend held_tools return force_ask", () => {
    const lists = backendToolLists({ validated: true, denied_tools: [], held_tools: ["write_to_file"] });
    const { handle, records } = setup({ decide: decideForTest(lists) });
    expect(handle(hook("PreToolUse", fixture("documented/pre-write-to-file.json")))).toEqual({
      decision: "force_ask",
      reason: "ArmorIQ needs your approval: ArmorIQ holds write for approval",
    });
    expect(records[0]?.status).toBe("held");
  });

  test("policy forbid denies with the rule in the reason", () => {
    const { handle } = setup({ policy: rule("no-shell", "forbid", "bash") });
    expect(handle(hook("PreToolUse", runCommand("ls")))).toEqual({ decision: "deny", reason: "ArmorIQ blocked this call [policy_forbid]: ArmorIQ policy forbid: no-shell" });
  });
});

describe("backend lists (#28)", () => {
  test("an org with no agent (validated:false, every tool listed as denied) is not blocked", () => {
    const requested = ["run_command", "write_to_file"];
    const lists = backendToolLists({ validated: false, requested_tools: requested, allowed_tools: [], denied_tools: requested, held_tools: [], reason: "agent_unresolved" });
    const { handle } = setup({ decide: decideForTest(lists) });
    expect(handle(hook("PreToolUse", runCommand("npm test")))).toEqual({});
  });

  test("validated denied_tools deny with backend_denied_tool", () => {
    const lists = backendToolLists({ validated: true, denied_tools: ["run_command"], held_tools: [] });
    const { handle } = setup({ decide: decideForTest(lists) });
    expect(handle(hook("PreToolUse", runCommand("npm test")))).toEqual({
      decision: "deny",
      reason: "ArmorIQ blocked this call [backend_denied_tool]: ArmorIQ denied bash for this plan",
    });
  });
});

describe("MCP server gate (#19)", () => {
  const mcpRaw = () => fixture("documented/pre-call-mcp-tool.json");

  test("an unknown server asks first in enforce mode", () => {
    const { handle, records } = setup({ policy: rule("other", "permit", "view_file") });
    const res = handle(hook("PreToolUse", mcpRaw()));
    expect(res).toMatchObject({ decision: "ask" });
    expect("reason" in res && res.reason).toContain('MCP server "github" is not approved');
    expect(records[0]).toMatchObject({ status: "held", decision: { kind: "ask", code: "mcp_server_unapproved", server: "github" } });
  });

  test("the default allow-all policy does not approve servers", () => {
    const { handle } = setup();
    expect(handle(hook("PreToolUse", mcpRaw()))).toMatchObject({ decision: "ask" });
  });

  test("monitor mode does not gate", () => {
    const { handle } = setup();
    expect(handle(hook("PreToolUse", mcpRaw(), "monitor"))).toEqual({});
  });

  test("an approved server passes, a denied one is blocked", () => {
    const log = memoryLog();
    const gate = createMcpGate({ access: () => null, log, ownServer: "armoriq", initial: new Map([["github", "approved"], ["evil", "denied"]]) });
    const { handle } = setup({ gate });
    expect(handle(hook("PreToolUse", mcpRaw()))).toEqual({});
    const evil = withTool("documented/pre-call-mcp-tool.json", { name: "call_mcp_tool", args: { ServerName: "evil", ToolName: "exfil", Arguments: {} } });
    expect(handle(hook("PreToolUse", evil))).toEqual({ decision: "deny", reason: 'ArmorIQ blocked this call [mcp_server_denied]: MCP server "evil" is denied on this device' });
  });

  test("policy can allow a server's tool or forbid it", () => {
    expect(setup({ policy: rule("gh", "permit", "github_create_issue") }).handle(hook("PreToolUse", mcpRaw()))).toEqual({});
    expect(setup({ policy: rule("no-gh", "forbid", "github_create_issue") }).handle(hook("PreToolUse", mcpRaw()))).toMatchObject({ decision: "deny" });
  });

  test("ArmorIQ's own tools are never gated", () => {
    const own = withTool("documented/pre-call-mcp-tool.json", { name: "call_mcp_tool", args: { ServerName: "armoriq", ToolName: "register_intent_plan", Arguments: { goal: "fix cart" } } });
    expect(setup().handle(hook("PreToolUse", own))).toEqual({});
  });
});

describe("failures", () => {
  test("a throwing decide denies in enforce and allows in monitor", () => {
    const decide: DecideFn = () => {
      throw new Error("session store unavailable");
    };
    expect(setup({ decide }).handle(hook("PreToolUse", runCommand("ls")))).toEqual({
      decision: "deny",
      reason: "ArmorIQ blocked this call [internal_error]: ArmorIQ could not check this call: Error: session store unavailable",
    });
    expect(setup({ decide }).handle(hook("PreToolUse", runCommand("ls"), "monitor"))).toEqual({});
  });

  test("a throwing observer does not change the response", () => {
    const { handle, log } = setup({
      policy: rule("no-shell", "forbid", "bash"),
      onDecision: () => {
        throw new Error("queue full");
      },
    });
    expect(handle(hook("PreToolUse", runCommand("ls")))).toMatchObject({ decision: "deny" });
    expect(log.entries.some((e) => e.message === "decision observer failed")).toBe(true);
  });
});
