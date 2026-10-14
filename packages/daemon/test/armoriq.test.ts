import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { isHookEvent, PROTOCOL_VERSION, type HookEvent } from "@armorantigravity/protocol";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { armoriqPlugins } from "../src/armoriq.ts";
import { startDaemon, type RunningDaemon } from "../src/daemon.ts";
import { sandboxHome } from "./sandbox.ts";

const HOOK = path.join(import.meta.dir, "../../hook/src/main.ts");
const CAPTURE = path.join(import.meta.dir, "../../../spike/payloads/cli/r3-shell-write-read-web-mcp.jsonl");
const quiet = { info() {}, warn() {}, error() {} };

type Capture = { event: HookEvent; stdin: Record<string, unknown> };

// The r3 agy CLI run: shell, write, read, web search and MCP calls, each with its pre and post hooks.
function captured(): Map<number, Capture> {
  const out = new Map<number, Capture>();
  for (const line of readFileSync(CAPTURE, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const rec: unknown = JSON.parse(line);
    if (typeof rec !== "object" || rec === null || !("source" in rec) || rec.source !== "global") continue;
    if (!("seq" in rec) || typeof rec.seq !== "number" || !("event" in rec) || !isHookEvent(rec.event) || !("stdin" in rec)) continue;
    if (typeof rec.stdin !== "object" || rec.stdin === null) continue;
    out.set(rec.seq, { event: rec.event, stdin: { ...rec.stdin } });
  }
  return out;
}

type Seen = { method: string; path: string; body: unknown };

function stubBackend() {
  const seen: Seen[] = [];
  const policy = {
    schemaVersion: "armor.policy.v1",
    defaults: { decision: "allow" },
    statements: [{ id: "org-no-web-search", effect: "forbid", action: { type: "tool", eq: "search_web" } }],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const json = (req.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null;
      seen.push({ method: req.method, path: url.pathname, body: json });
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /policies/profiles/active") return Response.json({ version: 1, policy, updatedBy: "dashboard", publishedAt: "2026-10-12T10:00:00.000Z" });
      // The fields the SDK's getIntentToken reads from conmap's /iap/sdk/token.
      if (route === "POST /iap/sdk/token") {
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
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
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
  const proc = Bun.spawn(["bun", HOOK, c.event], { stdin: new TextEncoder().encode(JSON.stringify(c.stdin)), stdout: "pipe", env: process.env });
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
  expect(daemon.auth.mode()).toBe("enforce");
  await until(() => backend.seen.some((r) => r.path === "/policies/profiles/active"));
  await Bun.sleep(100);

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
  expect(await hook(writeFile)).toEqual({ decision: "deny", reason: expect.stringContaining("[intent_plan_missing]") });

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
  for (const row of rows) expect(row).toMatchObject({ session_id: runCommand.stdin.conversationId, agent_id: "antigravity", client_id: "armorantigravity", user_id: "user-1" });
  expect(backend.seen.some((r) => r.path === "/v1/traces")).toBe(true);
}, 60_000);
