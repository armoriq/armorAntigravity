import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createSocketServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "@armorantigravity/protocol";
import { createIntentRuntime, INTENT_DIRECTIVE, OWN_TOOLS, RULE_DIRECTIVE, ownToolName, type IntentBackend } from "@armorantigravity/intent";
import { NO_OUTCOME } from "../src/server.ts";

const backend: IntentBackend = {
  mint: async () => ({
    ok: true,
    value: { planId: "plan-1", token: { status: "active", jwt: "j", expiresAt: Date.UTC(2030, 0, 1), deniedTools: new Set(), heldTools: new Set() } },
  }),
  reanchor: async () => ({ ok: true, value: { trustId: null } }),
  revoke: async () => ({ ok: true, value: undefined }),
  delegate: async () => ({ ok: false, retryable: false, reason: "unused" }),
};

const runtime = createIntentRuntime({
  client: { product: "armorantigravity", version: "0.0.0" },
  login: () => ({ backend: "http://unused", apiKey: "ak_test_x", userId: "u" }),
  mode: () => "enforce",
  policy: () => ({ hash: "h", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) }),
  mintPolicy: () => undefined,
  audit: () => {},
  log: { info() {}, warn() {}, error() {} },
  backend,
});

const dir = mkdtempSync(join(tmpdir(), "agd-mcp-"));
const socketPath = join(dir, "agd.sock");
let socketServer: Server;
let client: Client;

beforeAll(async () => {
  // Stands in for the daemon's socket loop: routes mcp_outcome lines to the intent runtime.
  socketServer = createSocketServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buffer.slice(0, nl));
      const tool = ownToolName(req.tool);
      const text = tool ? await runtime.mcpOutcome(tool, req.args, Math.min(req.waitMs, 200)) : null;
      socket.end(`${JSON.stringify({ v: 1, id: req.id, text })}\n`);
    });
  });
  await new Promise<void>((r) => socketServer.listen(socketPath, r));
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "..", "src", "main.ts")], env: { ...process.env, ARMORANTIGRAVITY_SOCKET: socketPath } }),
  );
});

afterAll(async () => {
  await client.close();
  socketServer.close();
  await runtime.pump.stop();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  Array.isArray(result.content) && result.content[0]?.type === "text" ? result.content[0].text : null;

describe("intent MCP server over stdio", () => {
  test("lists the five intent and trust tools with their argument names", async () => {
    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {}).sort()]))).toEqual({
      register_intent_plan: ["goal", "plan", "reason", "steps"],
      trust_reanchor: ["reason", "updatedPlan"],
      trust_revoke: ["reason"],
      trust_delegate: ["delegatePublicKey", "subtreePath", "targetAgent", "validitySeconds"],
      policy_read: ["tool"],
    });
    expect(tools.map((t) => t.name).sort()).toEqual([...OWN_TOOLS].sort());
  });

  test("returns the outcome the PreToolUse hook produced, though the hook's args carried Antigravity's extra keys", async () => {
    const plan = { goal: "run tests", steps: [{ action: "run_command" }] };
    const hook: HookPayload = {
      event: "PreToolUse",
      conversationId: "conv-mcp",
      workspacePaths: [],
      transcriptPath: "",
      artifactDirectoryPath: "/tmp/agy/artifacts/conv-mcp",
      modelName: "gemini-3.8-flash-high",
      toolCall: { name: "mcp_armoriq_register_intent_plan", args: { ...plan, toolAction: "Registering plan", toolSummary: "Plan" } },
      stepIdx: 2,
    };
    runtime.observe("cli", { ...hook, event: "PreInvocation", invocationNum: 0, initialNumSteps: 0 });
    runtime.observe("cli", hook);
    expect(await runtime.ownToolDecision("cli", hook)).toEqual({ decision: "allow" });
    const result = await client.callTool({ name: "register_intent_plan", arguments: plan });
    expect(textOf(result)).toBe("Intent registered: plan plan-1 (new), 1 steps. Token valid until 2030-01-01T00:00:00.000Z.");
    expect(runtime.root({ surface: "cli", conversationId: "conv-mcp" })?.plan?.id).toBe("plan-1");
  });

  test("a call the hook never saw changes nothing and says so", async () => {
    expect(textOf(await client.callTool({ name: "trust_revoke", arguments: { reason: "no hook" } }))).toBe(NO_OUTCOME);
  });
});

// The rule is read in every mode, so it differs from the Enforce directive only in the two lines that must hold in Monitor too.
test("the rules file is the rule directive with always_on frontmatter", () => {
  expect(readFileSync(join(import.meta.dir, "..", "rules", "armoriq.md"), "utf8")).toBe(`---\ntrigger: always_on\n---\n\n${RULE_DIRECTIVE}\n`);
  const rule = RULE_DIRECTIVE.split("\n");
  const enforce = INTENT_DIRECTIVE.split("\n");
  expect(rule).toHaveLength(enforce.length);
  expect(rule.filter((line, i) => line !== enforce[i])).toEqual([
    "ArmorIQ intent capture is active for this conversation.",
    "When your workspace enforces, tool calls without a registered plan are blocked, and so is any tool that is not in the plan. In Monitor nothing is blocked, but plans are still recorded.",
  ]);
});
