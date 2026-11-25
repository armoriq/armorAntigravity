import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { isHookEvent, PROTOCOL_VERSION, type HookEvent } from "@armorantigravity/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { armoriqPlugins } from "../src/armoriq.ts";
import { clientRowId } from "@armorantigravity/core";
import { createRegistry } from "@armorantigravity/intent";
import { startDaemon, type RunningDaemon } from "../src/daemon.ts";
import { compileHook, hostTarget } from "../../../scripts/build-hook.ts";
import { sandboxHome } from "./sandbox.ts";
import { compile, parseYaml } from "@armoriq/policy-ir";

const hookBuildDir = mkdtempSync(path.join(tmpdir(), "agd-hook-agy-"));
const HOOK = path.join(hookBuildDir, "agd-hook");
const CAPTURE = path.join(import.meta.dir, "../../../spike/payloads/cli/r3-shell-write-read-web-mcp.jsonl");
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(() => {
  compileHook(hostTarget(), HOOK);
});
afterAll(() => {
  rmSync(hookBuildDir, { recursive: true, force: true });
});

type Capture = { event: HookEvent; stdin: Record<string, unknown> };

// The r3 agy CLI run: shell, write, read, web search and MCP calls, each with its pre and post hooks.
function captured(file = CAPTURE): Map<number, Capture> {
  const out = new Map<number, Capture>();
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const rec: unknown = JSON.parse(line);
    if (typeof rec !== "object" || rec === null || !("source" in rec) || rec.source !== "global") continue;
    if (!("seq" in rec) || typeof rec.seq !== "number" || !("event" in rec) || !isHookEvent(rec.event) || !("stdin" in rec)) continue;
    if (typeof rec.stdin !== "object" || rec.stdin === null) continue;
    out.set(rec.seq, { event: rec.event, stdin: { ...rec.stdin } });
  }
  return out;
}

type Seen = { method: string; path: string; body: unknown; accepted: boolean; headers: Record<string, string> };

type BackendHealth = "up" | "down" | "unauthorized";

function stubBackend() {
  const seen: Seen[] = [];
  const health: { now: BackendHealth } = { now: "up" };
  const bundle: { now: unknown } = { now: { orgId: "org-1", agents: [] } };
  // The workspace's Tools mode conmap sends with the policy; these tests run in Block unless they set it.
  const mode: { now: "shadow" | "enforce"; notices: boolean } = { now: "enforce", notices: false };
  const token: { refuse: boolean } = { refuse: false };
  const policy = {
    schemaVersion: "armor.policy.v1",
    intentRequired: true,
    defaults: { decision: "allow" },
    statements: [{ id: "org-no-web-search", effect: "forbid", action: { type: "tool", eq: "search_web" } }],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const json = (req.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null;
      seen.push({ method: req.method, path: url.pathname, body: json, accepted: health.now === "up", headers: Object.fromEntries(req.headers) });
      const route = `${req.method} ${url.pathname}`;
      if (route === "POST /iap/validate-key") {
        if (health.now === "down") await Bun.sleep(5_000);
        if (health.now === "unauthorized") return Response.json({ message: "Invalid or expired API key", statusCode: 401 }, { status: 401 });
        return Response.json({ orgId: "org-1", userId: "user-1" });
      }
      if (health.now === "down") return new Response("", { status: 503 });
      if (route === "GET /policy/bundles/current") return Response.json(bundle.now, { headers: { ETag: `"${Bun.hash(JSON.stringify(bundle.now))}"` } });
      if (route === "GET /policies/profiles/active") return Response.json({ version: 1, policy, updatedBy: "dashboard", publishedAt: "2026-10-12T10:00:00.000Z", enforcementMode: mode.now, monitorNotices: mode.notices });
      if (route === "GET /mcp/servers") return Response.json({ servers: [{ mcpName: "denied-server", status: "denied" }] });
      // The fields the SDK's getIntentToken reads from conmap's /iap/sdk/token.
      if (route === "POST /iap/sdk/token") {
        if (token.refuse) return Response.json({ statusCode: 422, error: "parent_plan_not_found", message: "parent_plan_not_found" }, { status: 422 });
        return Response.json({ success: true, plan_id: "plan-wiring-1", plan_hash: "h", token: { expires_at: Date.now() / 1000 + 3600, signature: "sig" }, jwt_token: "jwt", policy_validation: { validated: false } });
      }
      if (route === "POST /iap/audit/batch") {
        const rows = isRows(json) ? json.rows : [];
        return Response.json({ written: rows.length, failures: [] });
      }
      if (route === "GET /observability/policy/lease") return Response.json({ captureMode: "metadata", revision: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      if (route === "POST /v1/traces") return Response.json({});
      return Response.json({ message: `Cannot ${route}`, statusCode: 404 }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, health, bundle, policy, mode, token, stop: () => server.stop(true) };
}

function isRows(body: unknown): body is { rows: Record<string, unknown>[] } {
  return typeof body === "object" && body !== null && "rows" in body && Array.isArray(body.rows);
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

async function hook(c: Capture): Promise<unknown> {
  const proc = Bun.spawn([HOOK, c.event], { stdin: new TextEncoder().encode(JSON.stringify(c.stdin)), stdout: "pipe", env: process.env });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out === "" ? null : JSON.parse(out);
}

// The request the intent MCP server (packages/mcp daemon-client.ts) sends after the hook allowed its call.
function mcpOutcome(socket: string, tool: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id: "mcp-1", kind: "mcp_outcome", tool, args, waitMs: 1000 })}\n`));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      conn.destroy();
      resolve(JSON.parse(buffer.slice(0, nl)));
    });
    conn.on("error", reject);
  });
}

let sandbox: ReturnType<typeof sandboxHome>;
let backend: ReturnType<typeof stubBackend>;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  sandbox = sandboxHome();
  backend = stubBackend();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  backend.stop();
  sandbox.cleanup();
});

test("captured agy hooks get policy, plan and drift decisions, and every decision reaches the audit upload", async () => {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ backendUrl: backend.url }));
  saveLoginProfile({ backend: backend.url, product: "armorantigravity", apiKey: "ak_test_wiring", email: "dev@example.com", userId: "user-1", orgId: "org-1" });

  daemon = await startDaemon({ env: {}, plugins: armoriqPlugins(), log: quiet });
  await until(() => backend.seen.some((r) => r.path === "/policies/profiles/active"));
  await Bun.sleep(100);
  expect(daemon.auth.mode()).toBe("enforce");

  const r3 = captured();
  const at = (seq: number): Capture => {
    const c = r3.get(seq);
    if (!c) throw new Error(`no capture ${seq}`);
    return c;
  };
  const runCommand = at(3);
  const writeFile = at(11);
  const mcpCall = at(35);

  expect(await hook(at(1))).toEqual({ injectSteps: [{ type: "ephemeralMessage", text: expect.stringContaining("register_intent_plan") }] });
  expect(await hook(at(19))).toEqual({ decision: "allow" });
  expect(await hook(at(27))).toEqual({ decision: "deny", reason: expect.stringContaining("[policy_forbid]") });
  const childWrite = captured(path.join(path.dirname(CAPTURE), "r4-subagent-browser.jsonl")).get(25)!;
  expect(childWrite.stdin.stepIdx).toBe(writeFile.stdin.stepIdx);
  expect(await hook(childWrite)).toEqual({ decision: "deny", reason: expect.stringContaining("[intent_plan_missing]") });

  // agy proxies the armoriq MCP server's tools through call_mcp_tool, as in the captured echo call.
  const plan = { goal: "Print a greeting", steps: [{ action: "run_command", description: "echo a greeting" }] };
  const mcpArgs = mcpCall.stdin.toolCall;
  if (typeof mcpArgs !== "object" || mcpArgs === null || !("args" in mcpArgs) || typeof mcpArgs.args !== "object" || mcpArgs.args === null) throw new Error("capture has no MCP args");
  const register = { ...mcpCall, stdin: { ...mcpCall.stdin, toolCall: { name: "call_mcp_tool", args: { ...mcpArgs.args, ServerName: "armoriq", ToolName: "register_intent_plan", Arguments: plan } } } };
  expect(await hook(register)).toEqual({ decision: "allow" });
  expect(await mcpOutcome(daemon.paths.socket, "register_intent_plan", plan)).toEqual({ v: 1, id: "mcp-1", text: expect.stringMatching(/^Intent registered/) });

  expect(await hook(at(9))).toBeNull();
  expect(await hook(runCommand)).toEqual({ decision: "allow" });
  expect(await hook(at(5))).toBeNull();
  expect(await hook(writeFile)).toEqual({ decision: "deny", reason: expect.stringContaining("[intent_drift]") });
  expect(await hook(at(7))).toBeNull();
  expect(await hook(at(53))).toBeNull();

  expect(backend.seen.filter((r) => r.path === "/iap/sdk/token")).toHaveLength(1);
  await daemon.stop();
  daemon = null;

  const rows = backend.seen.filter((r) => r.path === "/iap/audit/batch").flatMap((r) => (isRows(r.body) ? r.body.rows : []));
  const summary = rows.map((r) => [r.tool, r.status, typeof r.error_message === "string" ? r.error_message.split(":")[0] : null, r.plan_id ?? null]);
  expect(summary).toEqual(
    expect.arrayContaining([
      ["search_web", "blocked", "policy_forbid", null],
      ["write_to_file", "blocked", "intent_plan_missing", null],
      ["run_command", "success", null, "plan-wiring-1"],
      ["write_to_file", "blocked", "intent_drift", null],
    ]),
  );
  for (const row of rows) expect(row).toMatchObject({ session_id: row.decision_code === "missing_plan" ? childWrite.stdin.conversationId : runCommand.stdin.conversationId, agent_id: "antigravity", client_id: "armorantigravity", user_id: "user-1" });
  for (const row of rows.filter(r => r.status === "blocked")) {
    expect(row.decision_code).toBe({ policy_forbid: "policy_deny", intent_plan_missing: "missing_plan", intent_drift: "out_of_scope" }[String(row.error_message).split(":")[0]!]);
    expect(row.client_row_id).toMatch(/^[0-9a-f-]{36}$/);
  }
  const drift = rows.find(r => r.decision_code === "out_of_scope");
  expect(drift).toMatchObject({ context_plan_id: "plan-wiring-1", prompt_id: expect.any(String), client_row_id: clientRowId(String(runCommand.stdin.conversationId), `${writeFile.stdin.conversationId}:${writeFile.stdin.stepIdx}`, "decision") });
  const missing = rows.find(r => r.decision_code === "missing_plan");
  expect(missing?.client_row_id).not.toBe(drift?.client_row_id);
  expect(backend.seen.some((r) => r.path === "/v1/traces")).toBe(true);
}, 60_000);

// One agent-targeted v2 policy as conmap's bundle serves it, compiled by policy-ir like conmap compiles it.
function v2Bundle(name: string, rules: string) {
  const yaml = `apiVersion: armor.io/v2\nkind: Policy\nmetadata:\n  name: ${name}\n  orgId: 11111111-1111-4111-8111-111111111111\ntarget:\n  agent: armorantigravity\nspec:\n  tools:\n    default: allow\n    rules:\n${rules}`;
  const parsed = parseYaml(yaml);
  const document = parsed.source ? compile(parsed.source, [], { policyId: `id-${name}` }).document : null;
  if (!document) throw new Error(`policy ${name} did not compile`);
  const policy = { policyId: `id-${name}`, name, policyHash: `sha256:${name}`, document };
  return { orgId: "org-1", agents: [{ agentId: "armorantigravity", name: "armorantigravity", registeredName: null, registered: false, inactive: false, policy, policies: [{ ...policy, targetType: "agent", status: "active" }], tools: [], members: [] }] };
}

test("a v2 policy blocks through agd-hook with its name, v1 still applies where v2 is silent, and rows record the deciding source", async () => {
  backend.bundle.now = v2Bundle("No shell", "      run_command: block\n");
  daemon = await signedInDaemon();
  await until(() => backend.seen.some((r) => r.path === "/policy/bundles/current"));
  await Bun.sleep(100);
  const r3 = captured();
  const at = (seq: number): Capture => {
    const c = r3.get(seq);
    if (!c) throw new Error(`no capture ${seq}`);
    return c;
  };

  expect(await hook(at(3))).toEqual({ decision: "deny", reason: 'ArmorIQ blocked this call [policy_forbid]: ArmorIQ policy "No shell" blocks this call (rule run_command#0)' });
  expect(await hook(at(27))).toEqual({ decision: "deny", reason: expect.stringContaining("org-no-web-search") });
  await daemon.stop();
  daemon = null;

  const rows = backend.seen.filter((r) => r.path === "/iap/audit/batch").flatMap((r) => (isRows(r.body) ? r.body.rows : []));
  expect(rows.find((r) => r.tool === "run_command")).toMatchObject({
    status: "blocked",
    input: { armoriq_policy: { source: "v2", policy_id: "id-No shell", policy_name: "No shell", policy_hash: "sha256:No shell", rule_id: "run_command#0" } },
    output: { matchedPolicy: { policyId: "id-No shell", name: "No shell", policyVersion: "sha256:No shell" } },
  });
  expect(rows.find((r) => r.tool === "search_web")).toMatchObject({ status: "blocked", input: { armoriq_policy: { source: "v1_org", rule_id: "org-no-web-search" } } });
}, 60_000);

// regression: #0010
test("a daemon unavailable C hook writes one sanitized fallback that the daemon adopts", async () => {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ backendUrl: backend.url }));
  writeFileSync(path.join(dataDir, "mode"), "enforce");
  saveLoginProfile({ backend: backend.url, product: "armorantigravity", apiKey: "ak_test_wiring", email: "dev@example.com", userId: "user-1", orgId: "org-1" });
  const prior = await startDaemon({ env: { ARMORIQ_ORG_MODE: "enforce" }, plugins: [], log: quiet });
  await prior.stop();
  const call = captured().get(3)!;
  const proc = Bun.spawn([HOOK, "PreToolUse"], { stdin: new TextEncoder().encode(JSON.stringify(call.stdin)), stdout: "pipe", env: { ...process.env, ARMORANTIGRAVITY_DAEMON: "/usr/bin/false" } });
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ decision: "deny" });
  expect(await proc.exited).toBe(0);
  daemon = await startDaemon({ env: { ARMORIQ_ORG_MODE: "enforce" }, plugins: armoriqPlugins(), log: quiet });
  await until(() => backend.seen.some(r => r.path === "/iap/audit/batch"));
  const rows = backend.seen.filter(r => r.path === "/iap/audit/batch").flatMap(r => isRows(r.body) ? r.body.rows : []);
  expect(rows).toEqual([{ client_row_id: clientRowId(String(call.stdin.conversationId), `${call.stdin.conversationId}:${call.stdin.stepIdx}`, "decision"), session_id: call.stdin.conversationId, tool: "unknown", action: "unknown", input: {}, executed_at: expect.any(String), decision_code: "internal_error", status: "blocked" }]);
}, 15_000);

const AGY_14 = path.join(import.meta.dir, "../../adapter/test/fixtures/captured");

// agy CLI 1.4 calls its file tools read_file, write_file and edit_file with a `Path` argument.
function agy14(tool: "read_file" | "write_file" | "edit_file", args?: Record<string, unknown>): Capture {
  const raw: unknown = JSON.parse(readFileSync(path.join(AGY_14, `pre-${tool}.json`), "utf8"));
  if (typeof raw !== "object" || raw === null || !("stdin" in raw) || typeof raw.stdin !== "object" || raw.stdin === null) throw new Error(`bad capture ${tool}`);
  const stdin: Record<string, unknown> = { ...raw.stdin };
  if (args) stdin.toolCall = { name: tool, args };
  return { event: "PreToolUse", stdin };
}

test("agy 1.4 file tools: ~/.armoriq stays protected inside a registered plan, and plan steps under the 1.4 names cover the calls", async () => {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ backendUrl: backend.url }));
  saveLoginProfile({ backend: backend.url, product: "armorantigravity", apiKey: "ak_test_wiring", email: "dev@example.com", userId: "user-1", orgId: "org-1" });
  daemon = await startDaemon({ env: {}, plugins: armoriqPlugins(), log: quiet });
  await until(() => backend.seen.some((r) => r.path === "/policies/profiles/active"));
  await Bun.sleep(100);

  expect(await hook(agy14("read_file"))).toEqual({ decision: "allow" });
  expect(await hook(agy14("write_file"))).toEqual({ decision: "deny", reason: expect.stringContaining("[intent_plan_missing]") });

  const plan = { goal: "Edit notes", steps: [{ action: "read_file" }, { action: "write_file" }, { action: "edit_file" }] };
  const conversation = agy14("read_file").stdin;
  await hook({ event: "PreInvocation", stdin: { ...conversation, invocationNum: 0, initialNumSteps: 0 } });
  const register: Capture = { event: "PreToolUse", stdin: { ...conversation, toolCall: { name: "call_mcp_tool", args: { ServerName: "armoriq", ToolName: "register_intent_plan", Arguments: plan } } } };
  expect(await hook(register)).toEqual({ decision: "allow" });
  expect(await mcpOutcome(daemon.paths.socket, "register_intent_plan", plan)).toEqual({ v: 1, id: "mcp-1", text: expect.stringMatching(/^Intent registered/) });

  expect(await hook(agy14("write_file"))).toEqual({ decision: "allow" });
  expect(await hook(agy14("edit_file"))).toEqual({ decision: "allow" });
  const protectedDeny = { decision: "deny", reason: expect.stringContaining("[builtin_protected]") };
  expect(await hook(agy14("read_file", { Path: path.join(dataDir, "config.json") }))).toEqual(protectedDeny);
  expect(await hook(agy14("write_file", { Content: "monitor", Overwrite: true, Path: path.join(dataDir, "mode") }))).toEqual(protectedDeny);
  expect(await hook(agy14("edit_file", { Path: path.join(dataDir, "config.json"), Replacement: "{}", Target: "{" }))).toEqual(protectedDeny);
}, 60_000);

async function signedInDaemon(): Promise<RunningDaemon> {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ backendUrl: backend.url }));
  saveLoginProfile({ backend: backend.url, product: "armorantigravity", apiKey: "ak_test_wiring", email: "dev@example.com", userId: "user-1", orgId: "org-1" });
  const started = await startDaemon({ env: {}, plugins: armoriqPlugins(), log: quiet });
  await until(() => backend.seen.some((r) => r.path === "/policies/profiles/active"));
  await Bun.sleep(100);
  return started;
}

test("linked parent and child calls at the same steps retain distinct decision and result rows", async () => {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  const r4 = captured(path.join(path.dirname(CAPTURE), "r4-subagent-browser.jsonl"));
  const parent = r4.get(47)!.stdin;
  const child = r4.get(77)!.stdin;
  const registry = createRegistry(Date.now, path.join(dataDir, "intent-state.json"));
  registry.syncAuth(null, "monitor");
  const root = { surface: "cli" as const, conversationId: String(parent.conversationId) };
  const subagent = { surface: "cli" as const, conversationId: String(child.conversationId) };
  registry.open(root);
  registry.open(subagent);
  expect(registry.link(subagent, root)).toBe(true);
  daemon = await signedInDaemon();
  for (const stdin of [parent, child]) {
    const read = { ...stdin, toolCall: captured().get(19)!.stdin.toolCall };
    expect(await hook({ event: "PreToolUse", stdin: read })).toEqual({ decision: "allow" });
    expect(await hook({ event: "PostToolUse", stdin: { ...read, error: "" } })).toBeNull();
    expect(await hook({ event: "PreToolUse", stdin: { ...stdin, toolCall: captured().get(27)!.stdin.toolCall } })).toMatchObject({ decision: "deny" });
  }
  await daemon.stop();
  daemon = null;
  const rows = uploaded();
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map(row => row.client_row_id)).size).toBe(4);
  for (const stdin of [parent, child]) {
    const callId = `${stdin.conversationId}:${stdin.stepIdx}`;
    expect(rows).toContainEqual(expect.objectContaining({ session_id: root.conversationId, client_row_id: clientRowId(root.conversationId, callId, "decision"), status: "blocked", decision_code: "policy_deny" }));
    expect(rows).toContainEqual(expect.objectContaining({ session_id: root.conversationId, client_row_id: clientRowId(root.conversationId, callId, "result"), status: "success" }));
  }
}, 60_000);

test("policy holds and denied or unapproved MCP servers produce the expected audit rows", async () => {
  backend.policy.intentRequired = false;
  backend.policy.statements.push({ id: "hold-read", effect: "require_approval", action: { type: "tool", eq: "view_file" } });
  daemon = await signedInDaemon();
  await until(() => backend.seen.some(request => request.path === "/mcp/servers"));
  expect(await hook(captured().get(19)!)).toMatchObject({ decision: "deny", reason: expect.stringContaining("approval") });
  const base = captured().get(35)!;
  for (const [server, stepIdx] of [["denied-server", 10], ["pending-server", 12]] as const) {
    expect(await hook({ ...base, stdin: { ...base.stdin, stepIdx, toolCall: { name: "call_mcp_tool", args: { ServerName: server, ToolName: "echo", Arguments: {} } } } })).toMatchObject({ decision: server === "denied-server" ? "deny" : "ask" });
  }
  await daemon.stop();
  daemon = null;
  const rows = uploaded();
  expect(rows).toHaveLength(3);
  expect(rows.map(row => [row.status, row.decision_code])).toEqual([["held", "approval_required"], ["blocked", "policy_deny"], ["held", "approval_required"]]);
  expect(new Set(rows.map(row => row.client_row_id)).size).toBe(3);
}, 60_000);

test("daemon audit uploads keep the released tool content limit below the shared row cap", async () => {
  daemon = await signedInDaemon();
  const base = captured().get(27)!;
  for (const [index, length] of [2_000, 2_001, 8_000].entries()) {
    expect(await hook({ ...base, stdin: { ...base.stdin, stepIdx: 20 + index, toolCall: { name: "search_web", args: { query: "x".repeat(length) } } } })).toMatchObject({ decision: "deny" });
  }
  await daemon.stop();
  daemon = null;
  const rows = uploaded();
  expect(rows).toHaveLength(3);
  expect(rows.map(row => (row.input as { query: string }).query.length)).toEqual([2_000, 2_003, 2_003]);
}, 60_000);

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work;
  return { value, ms: performance.now() - start };
}

test("backend down while signed in: reads run, writes, shell and MCP are blocked backend_unreachable, and the rows upload once it is back", async () => {
  daemon = await signedInDaemon();
  const r3 = captured();
  const at = (seq: number): Capture => {
    const c = r3.get(seq);
    if (!c) throw new Error(`no capture ${seq}`);
    return c;
  };
  backend.health.now = "down";

  const read = await timed(hook(at(19)));
  expect(read.value).toEqual({ decision: "allow" });
  expect(read.ms).toBeLessThan(1_500);

  const unreachable = { decision: "deny", reason: expect.stringMatching(/\[backend_unreachable\].*armorantigravity status/) };
  const shell = await timed(hook(at(3)));
  expect(shell.value).toEqual(unreachable);
  expect(shell.ms).toBeGreaterThanOrEqual(2_000);
  expect(shell.ms).toBeLessThan(4_000);
  // The verdict is cached, so the next calls are blocked without another 2 s wait.
  const write = await timed(hook(at(11)));
  expect(write.value).toEqual(unreachable);
  expect(write.ms).toBeLessThan(1_500);
  expect(await hook(at(35))).toEqual(unreachable);
  expect(backend.seen.filter((r) => r.path === "/iap/validate-key")).toHaveLength(1);

  // The pump tries, gets a 503, and keeps the rows in the outbox across a restart.
  await until(() => backend.seen.some((r) => r.path === "/iap/audit/batch"), 15_000);
  expect(uploaded()).toEqual([]);
  await daemon.stop();
  backend.health.now = "up";
  daemon = await startDaemon({ env: {}, plugins: armoriqPlugins(), log: quiet });
  await until(() => uploaded().length >= 3, 15_000);

  const summary = uploaded().map((r) => [r.tool, r.status, r.capability, typeof r.error_message === "string" ? r.error_message.split(":")[0] : null]);
  expect(summary).toEqual([
    ["run_command", "blocked", "shell", "backend_unreachable"],
    ["write_to_file", "blocked", "write", "backend_unreachable"],
    ["mcp_agspike_global_echo", "blocked", "mcp", "backend_unreachable"],
  ]);
}, 90_000);

function uploaded(): Record<string, unknown>[] {
  // Rows a 503 turned away stay in the outbox; only accepted batches count.
  return backend.seen.filter((r) => r.path === "/iap/audit/batch" && r.accepted).flatMap((r) => (isRows(r.body) ? r.body.rows : []));
}

test("a 401 from the backend means signed out: local-only mode, nothing blocked as unreachable", async () => {
  daemon = await signedInDaemon();
  backend.health.now = "unauthorized";
  const write = captured().get(11);
  if (!write) throw new Error("no capture 11");
  expect(await hook(write)).toEqual({ decision: "allow" });
  expect(daemon.auth.state().kind).toBe("local_only");
  expect(daemon.auth.mode()).toBe("monitor");
  expect(readFileSync(daemon.paths.modeFile, "utf8").trim()).toBe("monitor");
}, 60_000);

// Owner decision A (2026-11-24) reverses spec 0007 D9: signed in, Monitor asks for and sends plans as Block does.
const DIRECTIVE = { injectSteps: [{ type: "ephemeralMessage", text: expect.stringContaining("register_intent_plan") }] };

// agy proxies the armoriq MCP server's tools through call_mcp_tool, as in the captured echo call.
function registerCall(mcpCall: Capture, plan: unknown): Capture {
  const args = mcpCall.stdin.toolCall;
  if (typeof args !== "object" || args === null || !("args" in args) || typeof args.args !== "object" || args.args === null) throw new Error("capture has no MCP args");
  return { ...mcpCall, stdin: { ...mcpCall.stdin, toolCall: { name: "call_mcp_tool", args: { ...args.args, ServerName: "armoriq", ToolName: "register_intent_plan", Arguments: plan } } } };
}

test("a Quiet workspace: the plan is asked for and sent, every captured call runs, and rows carry the plan and what Block would have done", async () => {
  backend.mode.now = "shadow";
  backend.bundle.now = v2Bundle("No reads", "      view_file: block\n");
  daemon = await signedInDaemon();
  await until(() => backend.seen.some((r) => r.path === "/policy/bundles/current"));
  await Bun.sleep(100);
  expect(daemon.auth.mode()).toBe("monitor");
  const r3 = captured();
  const at = (seq: number): Capture => {
    const c = r3.get(seq);
    if (!c) throw new Error(`no capture ${seq}`);
    return c;
  };

  expect(await hook(at(1))).toEqual(DIRECTIVE);
  const plan = { goal: "Write a note", steps: [{ action: "write_to_file", description: "write the note" }] };
  expect(await hook(registerCall(at(35), plan))).toEqual({ decision: "allow" });
  expect(await mcpOutcome(daemon.paths.socket, "register_intent_plan", plan)).toEqual({ v: 1, id: "mcp-1", text: expect.stringMatching(/^Intent registered: plan plan-wiring-1 \(new\), 1 steps\./) });
  const requests = backend.seen.filter((r) => r.path === "/iap/sdk/token");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers).toMatchObject({ "x-armoriq-plan-kind": "new", "x-armoriq-prompt-id": expect.any(String), "idempotency-key": expect.stringMatching(/^pcc1:[0-9a-f]{64}$/) });

  // The forbidden search, the write and the v2-blocked read all run.
  for (const [pre, post] of [[11, 13], [19, 21], [27, 29]] as const) {
    expect(await hook(at(pre))).toEqual({ decision: "allow" });
    expect(await hook(at(post))).toBeNull();
  }
  await daemon.stop();
  daemon = null;

  const rows = backend.seen.filter((r) => r.path === "/iap/audit/batch").flatMap((r) => (isRows(r.body) ? r.body.rows : []));
  expect(rows.map((r) => [r.tool, r.status, r.would_be ?? null, r.would_be_code ?? null, r.plan_id ?? null])).toEqual(
    expect.arrayContaining([
      ["write_to_file", "success", null, null, "plan-wiring-1"],
      ["view_file", "success", "block", "policy_forbid", "plan-wiring-1"],
      ["search_web", "success", "block", "policy_forbid", "plan-wiring-1"],
    ]),
  );
  expect(rows.find((r) => r.tool === "search_web")?.would_be_reason).toContain("org-no-web-search");
  expect(backend.seen.some((r) => r.path === "/iap/sdk/enforce")).toBe(false);
}, 60_000);

test("a Quiet workspace still runs the call after a failed plan request, and records the failure", async () => {
  backend.mode.now = "shadow";
  backend.token.refuse = true;
  daemon = await signedInDaemon();
  expect(daemon.auth.mode()).toBe("monitor");
  const r3 = captured();
  const at = (seq: number): Capture => {
    const c = r3.get(seq);
    if (!c) throw new Error(`no capture ${seq}`);
    return c;
  };

  expect(await hook(at(1))).toEqual(DIRECTIVE);
  const plan = { goal: "Print a greeting", steps: [{ action: "run_command", description: "echo a greeting" }] };
  expect(await hook(registerCall(at(35), plan))).toEqual({ decision: "allow" });
  expect(await mcpOutcome(daemon.paths.socket, "register_intent_plan", plan)).toEqual({ v: 1, id: "mcp-1", text: expect.stringMatching(/^Plan not registered: /) });
  expect(await hook(at(3))).toEqual({ decision: "allow" });
  expect(await hook(at(5))).toBeNull();
  await until(() => backend.seen.some((r) => r.path === "/iap/client-events" && JSON.stringify(r.body).includes('"plan_request_failed"')), 15_000);
  await daemon.stop();
  daemon = null;

  const rows = backend.seen.filter((r) => r.path === "/iap/audit/batch").flatMap((r) => (isRows(r.body) ? r.body.rows : []));
  expect(rows.find((r) => r.tool === "run_command")).toMatchObject({ status: "success" });
  expect(rows.some((r) => r.status === "blocked" || r.status === "held")).toBe(false);
}, 60_000);

test("switching the workspace to Block applies at the next pull, and ARMORIQ_ORG_MODE=enforce forces it", async () => {
  backend.mode.now = "shadow";
  daemon = await signedInDaemon();
  expect(daemon.auth.mode()).toBe("monitor");
  const search = captured().get(27)!;
  expect(await hook(search)).toEqual({ decision: "allow" });
  await daemon.stop();

  backend.mode.now = "enforce";
  daemon = await signedInDaemon();
  expect(daemon.auth.mode()).toBe("enforce");
  // Kept on disk, so a restart before the next pull stays in Block.
  expect(readFileSync(path.join(sandbox.home, ".armoriq", "armorantigravity", "org-mode.json"), "utf8")).toContain('"mode":"enforce"');
  expect(await hook(search)).toEqual({ decision: "deny", reason: expect.stringContaining("[policy_forbid]") });
  await daemon.stop();

  backend.mode.now = "shadow";
  daemon = await startDaemon({ env: { ARMORIQ_ORG_MODE: "enforce" }, plugins: armoriqPlugins(), log: quiet });
  await until(() => backend.seen.filter((r) => r.path === "/policies/profiles/active").length >= 3);
  await Bun.sleep(100);
  expect(daemon.auth.mode()).toBe("enforce");
}, 60_000);
