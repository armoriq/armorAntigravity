import { describe, expect, test } from "bun:test";
import type { BuiltinContext } from "../src/builtin-rules.ts";
import { decide } from "../src/decide.ts";
import { parsePlan as parsePlanFor } from "../src/intent.ts";
import { compilePolicy as compileFor, DEFAULT_POLICY_SOURCE } from "../src/policy.ts";
import { OPENCODE } from "../src/products/opencode.ts";
import type { CompiledPolicy, Plan, Session, SessionID, Token } from "../src/types.ts";

const compilePolicy = (raw: unknown) => compileFor(raw, OPENCODE.tools);
const parsePlan = (raw: unknown, revision: number, messageId: string) => parsePlanFor(raw, revision, messageId, OPENCODE.tools);

const NOW = 1_800_000_000_000;

const builtin: BuiltinContext = {
  armoriqDir: "/home/dev/.armoriq",
  ownTools: new Set(["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"]),
  shadowedTools: new Set(),
};

function compile(raw: unknown): CompiledPolicy {
  const r = compilePolicy(raw);
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

const allowAll = compile(DEFAULT_POLICY_SOURCE);
const strict = compile({
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "deny" },
  statements: [
    { id: "no-rm", effect: "forbid", action: { type: "tool", eq: "bash" }, conditions: [{ field: "bash.raw", op: "matches", value: "rm\\s+-rf" }] },
    { id: "push-needs-ok", effect: "require_approval", action: { type: "tool", eq: "bash" }, conditions: [{ field: "bash.raw", op: "matches", value: "^git push" }] },
    { id: "tools", effect: "permit", action: { type: "tool", in: ["bash", "read", "edit", "write"] } },
  ],
});

function makePlan(steps: unknown[]): Plan {
  const r = parsePlan({ goal: "g", steps }, 1, "m1");
  if (!r.ok) throw new Error(r.error);
  return { ...r.plan, id: "plan-1" };
}

const PLAN = makePlan([{ action: "read" }, { action: "edit" }, { action: "bash", metadata: { inputs: { command: "bun test" } } }]);

const active = (over: Partial<Extract<Token, { status: "active" }>> = {}): Token => ({
  status: "active",
  jwt: "jwt",
  expiresAt: NOW + 60_000,
  deniedTools: new Set(),
  heldTools: new Set(),
  ...over,
});

function session(over: Partial<Session> = {}): Session {
  return {
    id: "root" as SessionID,
    parentId: null,
    mode: "enforce",
    plan: PLAN,
    token: active(),
    stepCursor: 0,
    revisionsThisMessage: 0,
    currentMessageId: "m1",
    ...over,
  };
}

function run(tool: string, args: Record<string, unknown>, opts: { policy?: CompiledPolicy; session?: Session; root?: Session } = {}) {
  const root = opts.root ?? opts.session ?? session();
  return decide({
    policy: opts.policy ?? allowAll,
    session: opts.session ?? root,
    root,
    call: { sessionId: (opts.session ?? root).id, callId: "c1", tool, args },
    now: NOW,
    builtin,
    tools: OPENCODE.tools,
  });
}

describe("decide", () => {
  test("an in-plan call with a live token is allowed with its step index", () => {
    expect(run("bash", { command: "bun test" })).toEqual({ kind: "allow", stepIndex: 2, paramMismatch: false });
    expect(run("bash", { command: "bun x" })).toEqual({ kind: "allow", stepIndex: 2, paramMismatch: true });
  });

  test("builtin rules run first, even when policy and plan would allow", () => {
    expect(run("read", { filePath: "/home/dev/.armoriq/credentials.json" })).toMatchObject({
      kind: "deny",
      code: "builtin_protected",
    });
  });

  test("policy runs before the plan: forbid denies an in-plan call", () => {
    const s = session({ plan: makePlan([{ action: "bash" }]) });
    expect(run("bash", { command: "rm -rf /" }, { policy: strict, session: s })).toEqual({
      kind: "deny",
      code: "policy_forbid",
      reason: "ArmorIQ policy forbid: no-rm",
      ruleId: "no-rm",
    });
  });

  test("a plan never grants what policy denies by default", () => {
    const s = session({ plan: makePlan([{ action: "webfetch" }]) });
    expect(run("webfetch", { url: "https://x" }, { policy: strict, session: s })).toMatchObject({ kind: "deny", code: "policy_forbid", ruleId: null });
  });

  test("require_approval becomes a hold, but drift still wins over it", () => {
    const s = session({ plan: makePlan([{ action: "bash" }]) });
    expect(run("bash", { command: "git push origin" }, { policy: strict, session: s })).toEqual({
      kind: "hold",
      ruleId: "push-needs-ok",
      reason: "ArmorIQ policy requires approval: push-needs-ok",
    });
    expect(run("bash", { command: "git push origin" }, { policy: strict, session: session({ plan: makePlan([{ action: "read" }]) }) })).toMatchObject({
      kind: "deny",
      code: "intent_drift",
    });
  });

  test("a side-effecting call with no plan is intent_plan_missing", () => {
    expect(run("write", { filePath: "a", content: "b" }, { session: session({ plan: null, token: null }) })).toMatchObject({
      kind: "deny",
      code: "intent_plan_missing",
      ruleId: null,
    });
  });

  test("a tool outside the plan is intent_drift, with recovery instructions", () => {
    const d = run("write", { filePath: "a", content: "b" });
    expect(d).toEqual({
      kind: "deny",
      code: "intent_drift",
      reason: "write not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.",
      ruleId: null,
    });
  });

  test("read-only tools skip the plan check but not policy", () => {
    const planless = session({ plan: null, token: null });
    expect(run("grep", { pattern: "x" }, { session: planless })).toEqual({ kind: "allow", stepIndex: null, paramMismatch: false });
    expect(run("webfetch", { url: "https://x" }, { session: planless })).toMatchObject({ kind: "allow" });
    expect(run("glob", { pattern: "*" }, { policy: strict, session: planless })).toMatchObject({ kind: "deny", code: "policy_forbid" });
  });

  test("read-only tools still honour the backend's denied and held lists on a live token", () => {
    expect(run("webfetch", { url: "https://x" }, { session: session({ token: active({ deniedTools: new Set(["webfetch"]) }) }) })).toMatchObject({
      kind: "deny",
      code: "backend_denied_tool",
    });
    expect(run("read", { filePath: "a" }, { session: session({ token: active({ heldTools: new Set(["read"]) }) }) })).toMatchObject({ kind: "hold" });
    expect(run("read", { filePath: "a" }, { session: session({ token: active({ expiresAt: NOW - 1 }) }) })).toMatchObject({ kind: "allow" });
    expect(run("read", { filePath: "a" }, { session: session({ token: { status: "refused", code: "account_revoked" } }) })).toMatchObject({ kind: "allow" });
  });

  test("token checks: expired, denied by the backend, held by the backend", () => {
    expect(run("edit", {}, { session: session({ token: active({ expiresAt: NOW }) }) })).toMatchObject({ code: "intent_token_expired" });
    expect(run("edit", {}, { session: session({ token: active({ deniedTools: new Set(["edit"]) }) }) })).toMatchObject({
      kind: "deny",
      code: "backend_denied_tool",
    });
    expect(run("edit", {}, { session: session({ token: active({ heldTools: new Set(["edit"]) }) }) })).toMatchObject({ kind: "hold" });
  });

  test("backend tool lists also match the plan step's own action name", () => {
    const s = session({ plan: makePlan([{ action: "Edit" }]), token: active({ deniedTools: new Set(["Edit"]) }) });
    expect(run("edit", {}, { session: s })).toMatchObject({ code: "backend_denied_tool" });
  });

  test("a refused token blocks side effects with the account reason", () => {
    expect(run("edit", {}, { session: session({ token: { status: "refused", code: "account_revoked" } }) })).toMatchObject({
      code: "account_revoked",
    });
    expect(run("edit", {}, { session: session({ plan: null, token: { status: "refused", code: "billing_blocked" } }) })).toMatchObject({
      code: "billing_blocked",
    });
  });

  test("a plan without a token is not active", () => {
    expect(run("edit", {}, { session: session({ token: null }) })).toMatchObject({ code: "intent_plan_missing" });
  });

  test("a subagent is checked against its root session's plan and token", () => {
    const root = session({ plan: makePlan([{ action: "read" }]) });
    const child = session({ id: "child" as SessionID, parentId: root.id, plan: makePlan([{ action: "write" }]), token: active() });
    expect(run("write", { filePath: "a", content: "b" }, { session: child, root })).toMatchObject({ code: "intent_drift" });
    expect(run("read", { filePath: "a" }, { session: child, root })).toMatchObject({ kind: "allow" });
    const expiredRoot = session({ token: active({ expiresAt: NOW - 1 }) });
    expect(run("edit", {}, { session: child, root: expiredRoot })).toMatchObject({ code: "intent_token_expired" });
  });

  test("the step cursor comes from the root session", () => {
    const p = makePlan([{ action: "edit" }, { action: "read" }, { action: "edit" }]);
    const root = session({ plan: p, stepCursor: 1 });
    const child = session({ id: "child" as SessionID, parentId: root.id, plan: null, stepCursor: 0 });
    expect(run("edit", {}, { session: child, root })).toMatchObject({ kind: "allow", stepIndex: 2 });
  });

  test("monitor mode and intentRequired: false skip plan checks but keep policy", () => {
    const monitor = session({ mode: "monitor", plan: null, token: null });
    expect(run("write", { filePath: "a" }, { session: monitor })).toEqual({ kind: "allow", stepIndex: null, paramMismatch: false });
    expect(run("bash", { command: "rm -rf /" }, { policy: strict, session: monitor })).toMatchObject({ code: "policy_forbid" });
    const optional = compile({ ...(DEFAULT_POLICY_SOURCE as object), intentRequired: false });
    expect(run("write", { filePath: "a" }, { policy: optional, session: session({ plan: null, token: null }) })).toMatchObject({ kind: "allow" });
  });

  test("the plugin's own tools are allowed without a plan, even under default deny", () => {
    const planless = session({ plan: null, token: null });
    expect(run("register_intent_plan", { goal: "g", steps: [] }, { policy: strict, session: planless })).toEqual({
      kind: "allow",
      stepIndex: null,
      paramMismatch: false,
    });
  });

  test("a shadowed own-tool name is denied even though it is an own tool", () => {
    const shadowCtx = { ...builtin, shadowedTools: new Set(["policy_read"]) };
    const root = session();
    const d = decide({
      policy: allowAll,
      session: root,
      root,
      call: { sessionId: root.id, callId: "c", tool: "policy_read", args: {} },
      now: NOW,
      builtin: shadowCtx,
      tools: OPENCODE.tools,
    });
    expect(d).toMatchObject({ kind: "deny", code: "own_tool_shadowed" });
  });
});
