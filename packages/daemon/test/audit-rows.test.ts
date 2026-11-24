import { clientRowId } from "@armorantigravity/core";
import { createRegistry } from "@armorantigravity/intent";
import { parseHookPayload, type HookEvent } from "@armorantigravity/protocol";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { armoriqPlugins } from "../src/armoriq.ts";
import { createAuth, type Auth } from "../src/auth.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import type { PluginRegistration } from "../src/plugin.ts";
import { createSessionStore } from "../src/sessions.ts";
import { sandboxHome } from "./sandbox.ts";

const quiet = { info() {}, warn() {}, error() {} };
const captured = (file: string, seq: number) => JSON.parse(readFileSync(path.join(import.meta.dir, "../../../spike/payloads/cli", file), "utf8").split("\n").find(line => line && JSON.parse(line).source === "global" && JSON.parse(line).seq === seq)!).stdin;
const r3 = (seq: number) => captured("r3-shell-write-read-web-mcp.jsonl", seq);
const r4 = (seq: number) => captured("r4-subagent-browser.jsonl", seq);
let sandbox: ReturnType<typeof sandboxHome>;
let auth: Auth;
let registrations: PluginRegistration[];
const originalFetch = globalThis.fetch;

beforeEach(() => { sandbox = sandboxHome(); registrations = []; });
afterEach(async () => {
  for (const registration of registrations) for (const pump of registration.pumps ?? []) await pump.stop();
  auth?.stop();
  globalThis.fetch = originalFetch;
  sandbox.cleanup();
});

// The daemon's real plugins and durable queue run here. Only the HTTP boundary is
// replaced, so these row regressions also run where listening sockets are denied.
async function setup(hold = false) {
  const rows: Record<string, any>[] = [];
  const paths = resolvePaths({});
  const parent = r4(47);
  const child = r4(77);
  const registry = createRegistry(Date.now, path.join(paths.dataDir, "intent-state.json"));
  registry.syncAuth(null, "monitor");
  const root = { surface: "cli" as const, conversationId: parent.conversationId };
  const subagent = { surface: "cli" as const, conversationId: child.conversationId };
  registry.open(root);
  registry.open(subagent);
  expect(registry.link(subagent, root)).toBe(true);
  let policyRead = false;
  globalThis.fetch = (async (input: any, options?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input);
    if (url.pathname === "/policies/profiles/active") {
      policyRead = true;
      return Response.json({ version: 1, policy: { schemaVersion: "armor.policy.v1", intentRequired: !hold, defaults: { decision: "allow" }, statements: [
        { id: "no-web", effect: "forbid", action: { type: "tool", eq: "search_web" } },
        ...(hold ? [{ id: "hold-read", effect: "require_approval", action: { type: "tool", eq: "view_file" } }] : []),
      ] } });
    }
    if (url.pathname === "/mcp/servers") return Response.json({ servers: [{ mcpName: "denied-server", status: "denied" }] });
    if (url.pathname === "/iap/audit/batch") {
      const batch = JSON.parse(String(options?.body)).rows;
      rows.push(...batch);
      return Response.json({ written: batch.length, failures: [] });
    }
    return Response.json({ orgId: "org", userId: "user" });
  }) as typeof fetch;
  auth = createAuth(quiet, { env: { ARMORIQ_ORG_MODE: "enforce", ARMORIQ_API_KEY: "ak_test_rows", ARMORIQ_BACKEND_URL: "https://rows.invalid" }, config: DEFAULT_CONFIG, dataDir: paths.dataDir });
  const sessions = createSessionStore(paths.sessionsDir);
  for (const plugin of armoriqPlugins()) registrations.push(await plugin.setup({ paths, auth, sessions, log: quiet }));
  const deadline = Date.now() + 1_000;
  while (!policyRead) {
    if (Date.now() > deadline) throw new Error("policy did not load");
    await Bun.sleep(1);
  }
  await Bun.sleep(10);
  const decide = registrations.find(registration => registration.decide)!.decide!;
  return {
    rows, parent, child,
    async hook(event: HookEvent, raw: any) {
      const payload = parseHookPayload(event, raw);
      if (!payload) throw new Error("invalid captured hook payload");
      const { session } = sessions.open("cli", payload.conversationId, Date.now());
      return decide({ id: crypto.randomUUID(), receivedAt: Date.now(), event, payload, session, mode: auth.mode(), auth: auth.state() });
    },
    async flush() {
      for (const registration of registrations) for (const pump of registration.pumps ?? []) if (pump.name === "audit") { pump.kick(); await pump.stop(); }
    },
  };
}

test("linked subagents keep separate decision and result ids for overlapping captured steps", async () => {
  const h = await setup();
  for (const raw of [h.parent, h.child]) {
    expect(raw.stepIdx).toBe(6);
    const read = { ...raw, toolCall: r3(19).toolCall };
    expect(await h.hook("PreToolUse", read)).toEqual({ decision: "allow" });
    expect(await h.hook("PostToolUse", { ...read, error: "" })).toBeNull();
    expect(await h.hook("PreToolUse", { ...raw, toolCall: r3(27).toolCall })).toMatchObject({ decision: "deny" });
  }
  await h.flush();
  expect(h.rows).toHaveLength(4);
  expect(new Set(h.rows.map(row => row.client_row_id)).size).toBe(4);
  for (const raw of [h.parent, h.child]) for (const phase of ["decision", "result"] as const) {
    expect(h.rows).toContainEqual(expect.objectContaining({ session_id: h.parent.conversationId, client_row_id: clientRowId(h.parent.conversationId, `${raw.conversationId}:${raw.stepIdx}`, phase), status: phase === "decision" ? "blocked" : "success" }));
  }
});

test("daemon policy holds and MCP server stops carry held or blocked codes", async () => {
  const h = await setup(true);
  expect(await h.hook("PreToolUse", r3(19))).toMatchObject({ decision: "deny" });
  for (const [server, stepIdx] of [["denied-server", 10], ["pending-server", 12]] as const) {
    expect(await h.hook("PreToolUse", { ...r3(35), stepIdx, toolCall: { name: "call_mcp_tool", args: { ServerName: server, ToolName: "echo", Arguments: {} } } })).toMatchObject({ decision: server === "denied-server" ? "deny" : "ask" });
  }
  await h.flush();
  expect(h.rows.map(row => [row.status, row.decision_code])).toEqual([["held", "approval_required"], ["blocked", "policy_deny"], ["held", "approval_required"]]);
});

test("outbound daemon rows keep the released content limit below the backend row maximum", async () => {
  const h = await setup();
  for (const [index, length] of [2_000, 2_001, 8_000].entries()) {
    expect(await h.hook("PreToolUse", { ...r3(27), stepIdx: 20 + index, toolCall: { name: "search_web", args: { query: "x".repeat(length) } } })).toMatchObject({ decision: "deny" });
  }
  await h.flush();
  expect(h.rows.map(row => row.input.query.length)).toEqual([2_000, 2_003, 2_003]);
});
