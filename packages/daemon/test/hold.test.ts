import { expect, test } from "bun:test";
import { mapToolCall, type HeldCall } from "@armorantigravity/adapter";
import type { Login } from "../src/auth.ts";
import { createHoldResolver, type SignedPlan } from "../src/hold.ts";

const quiet = { info() {}, warn() {}, error() {} };
const login: Login = { backend: "https://backend.test", apiKey: "ak_1", userId: "u", orgId: "o", email: "dev@acme.test", deviceId: "d", deviceName: "n" };
const PLAN: SignedPlan = { planId: "8f0b2a8e-8f0b-4a8e-8f0b-2a8e8f0b2a8e", jwt: "h.p.s" };
const writeArgs = { TargetFile: "/ws/notes.txt", CodeContent: "spike", toolAction: "Writing", toolSummary: "notes" };

function held(rawArgs: Record<string, unknown> = writeArgs, name = "write_to_file"): HeldCall {
  return {
    conversationId: "c1",
    stepIdx: 3,
    call: mapToolCall({ name, args: rawArgs }),
    rawArgs,
    policyName: "no-file-writes",
    ruleId: "v2:p1:write_to_file#0",
    reason: 'ArmorIQ policy "no-file-writes" requires approval for this call (rule write_to_file#0)',
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function setup(answers: Record<string, (body: Record<string, unknown> | null) => [number, unknown]>, plan: SignedPlan | null = PLAN) {
  const calls: Call[] = [];
  const resolve = createHoldResolver({
    access: () => ({ login, client: "armorantigravity/test" }),
    plan: () => plan,
    agentId: "antigravity",
    builtinServer: "antigravity",
    log: quiet,
    fetch: async (url, init) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body });
      const path = new URL(url).pathname;
      const answer = answers[path];
      if (!answer) throw new Error(`unexpected request ${path}`);
      const [status, data] = answer(body);
      return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { resolve, calls, paths: () => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`) };
}

const stillHeld = (): [number, unknown] => [200, { allowed: false, enforcementAction: "hold", reason: "approval_required", message: "needs approval" }];
const role = (): [number, unknown] => [200, { role: "org_member", limit: 0 }];

test("a held call is checked with the token's agent and plan, then files one approval request named in the reason", async () => {
  let filed = 0;
  const { resolve, calls, paths } = setup({
    "/iap/sdk/enforce": stillHeld,
    "/delegation/my-role": role,
    "/delegation/request": () => [201, { delegationId: `req-${++filed}`, status: "pending" }],
  });
  const decision = await resolve(held());
  expect(decision).toEqual({
    kind: "hold",
    ruleId: "v2:p1:write_to_file#0",
    reason: 'ArmorIQ policy "no-file-writes" holds write_to_file for approval (approval_required). Approval request req-1 is waiting for another member; retry after it is approved.',
  });
  expect(paths()).toEqual(["POST /iap/sdk/enforce", "GET /delegation/my-role", "POST /delegation/request"]);
  const args = { TargetFile: "/ws/notes.txt", CodeContent: "spike" };
  expect(calls[0]?.body).toEqual({ tool: "write_to_file", mcp: "antigravity", arguments: args, intent_token: { jwt_token: "h.p.s", plan_id: PLAN.planId }, agent_id: "antigravity", user_email: "dev@acme.test" });
  expect(calls[2]?.body).toEqual({
    tool: "write_to_file",
    action: "execute",
    arguments: args,
    requesterEmail: "dev@acme.test",
    requesterRole: "org_member",
    requesterLimit: 0,
    domain: "antigravity",
    planId: PLAN.planId,
    reason: "approval_required",
  });
  expect(calls[2]?.headers["X-User-Email"]).toBe("dev@acme.test");

  // agy rewrites toolSummary on a retry; the call is the same and is not filed twice.
  const again = await resolve(held({ ...writeArgs, toolSummary: "retry notes" }));
  expect(again).toMatchObject({ kind: "hold", reason: expect.stringContaining("Approval request req-1 is waiting") });
  expect(filed).toBe(1);
});

test("the retry after approval is allowed, and the same call held later files a new request", async () => {
  let approved = false;
  let filed = 0;
  const { resolve } = setup({
    "/iap/sdk/enforce": () => (approved ? [200, { allowed: true, enforcementAction: "allow", reason: "approved_delegation" }] : stillHeld()),
    "/delegation/my-role": role,
    "/delegation/request": () => [201, { delegationId: `req-${++filed}` }],
  });
  expect(await resolve(held())).toMatchObject({ kind: "hold", reason: expect.stringContaining("req-1") });
  approved = true;
  expect(await resolve(held())).toEqual({ kind: "allow", stepIndex: null, paramMismatch: false });
  approved = false;
  expect(await resolve(held())).toMatchObject({ kind: "hold", reason: expect.stringContaining("req-2") });
});

test("a backend block, such as a rejected request, denies with the backend's message", async () => {
  const { resolve, paths } = setup({
    "/iap/sdk/enforce": () => [200, { allowed: false, enforcementAction: "block", reason: "delegation_rejected", message: "Approval was rejected (delegation req-1)" }],
  });
  expect(await resolve(held())).toEqual({
    kind: "deny",
    code: "policy_forbid",
    ruleId: "v2:p1:write_to_file#0",
    reason: 'ArmorIQ policy "no-file-writes" blocks write_to_file: Approval was rejected (delegation req-1)',
  });
  expect(paths()).toEqual(["POST /iap/sdk/enforce"]);
});

test("without a signed plan the call stays held and asks for register_intent_plan, with no backend call", async () => {
  const { resolve, calls } = setup({}, null);
  expect(await resolve(held())).toMatchObject({ kind: "hold", reason: expect.stringContaining("Call register_intent_plan") });
  expect(calls).toEqual([]);
});

test("a failed check or filing keeps the call held", async () => {
  const down = setup({ "/iap/sdk/enforce": () => [503, { message: "down" }] });
  expect(await down.resolve(held())).toMatchObject({ kind: "hold", reason: expect.stringContaining("did not answer the approval check (HTTP 503)") });

  const refused = setup({ "/iap/sdk/enforce": stillHeld, "/delegation/my-role": role, "/delegation/request": () => [400, { message: "bad" }] });
  expect(await refused.resolve(held())).toMatchObject({ kind: "hold", reason: expect.stringContaining("could not be filed (HTTP 400)") });
});

test("an MCP call is scoped to its server and inner arguments", async () => {
  const raw = { ServerName: "github", ToolName: "create_issue", Arguments: { title: "x" }, toolAction: "a", toolSummary: "b" };
  const { resolve, calls } = setup({ "/iap/sdk/enforce": stillHeld, "/delegation/my-role": role, "/delegation/request": () => [201, { delegationId: "req-9" }] });
  await resolve(held(raw, "call_mcp_tool"));
  expect(calls[0]?.body).toMatchObject({ tool: "create_issue", mcp: "github", arguments: { title: "x" } });
  expect(calls[2]?.body).toMatchObject({ tool: "create_issue", domain: "github", arguments: { title: "x" } });
});
