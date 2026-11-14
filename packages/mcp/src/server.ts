import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const SERVER_NAME = "armoriq";
export const OUTCOME_WAIT_MS = 3000;

export type AskDaemon = (tool: string, args: Record<string, unknown>) => Promise<string | null>;

// The hook handles every call before it reaches this server; reaching the fallback means it did not.
export const NO_OUTCOME =
  "ArmorIQ has no record of this call. The ArmorIQ hooks may not be installed for this Antigravity surface, or the ArmorIQ daemon is not running. Nothing was registered or changed, and side-effecting calls stay blocked until a plan is registered.";

const planArg = z.union([z.record(z.string(), z.unknown()), z.string()]);
const stepsArg = z.union([z.array(z.unknown()), z.string()]);

// Argument schemas from ArmorOpenCode src/tools/intent.ts, plus trust_delegate from ArmorClaude policy-mcp.mjs.
// State changes happen in the daemon on PreToolUse; each tool only returns the outcome the daemon recorded.
export function createServer(askDaemon: AskDaemon, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });
  const answer = (tool: string) => async (args: Record<string, unknown>) => {
    const text = (await askDaemon(tool, args).catch(() => null)) ?? NO_OUTCOME;
    return { content: [{ type: "text" as const, text }] };
  };

  server.registerTool(
    "register_intent_plan",
    {
      description:
        "Declare the tools you intend to use for this task. Required by ArmorIQ before any side-effecting tool call; " +
        "without a registered plan those calls are blocked. To revise a registered plan, call it again with the full new plan and a reason.",
      inputSchema: {
        goal: z.string().optional().describe("One-line summary of what the plan accomplishes"),
        steps: stepsArg.optional().describe("Ordered list of {action, description, metadata.inputs} steps (array, or JSON-stringified array)"),
        plan: planArg.optional().describe("Alternative: pass the whole plan as an object or JSON string"),
        reason: z.string().optional().describe("Required when revising an already registered plan: why the plan changed"),
      },
    },
    answer("register_intent_plan"),
  );

  server.registerTool(
    "trust_reanchor",
    {
      description: "Replace the registered intent plan with a revised one. Counts as a plan revision and requires a reason.",
      inputSchema: {
        updatedPlan: planArg.describe("The full revised plan, {goal, steps}"),
        reason: z.string().describe("Why the plan changed"),
      },
    },
    answer("trust_reanchor"),
  );

  server.registerTool(
    "trust_revoke",
    {
      description: "Revoke the intent token of this conversation's registered plan. Side-effecting calls are blocked until a new plan is registered.",
      inputSchema: { reason: z.string().describe("Why the plan is being revoked") },
    },
    answer("trust_revoke"),
  );

  server.registerTool(
    "trust_delegate",
    {
      description:
        "Issue a subtree-bounded child token plus a Merkle inclusion proof. The sub-agent receives authority confined to the named subtree path.",
      inputSchema: {
        delegatePublicKey: z.string().min(1).describe("Public key of the sub-agent that will hold the child token"),
        subtreePath: z.string().min(1).describe("Plan subtree this delegation covers, e.g. /steps/[1]"),
        validitySeconds: z.number().int().positive().optional().describe("Override the default validity"),
        targetAgent: z.string().optional().describe("Human-readable label for the sub-agent"),
      },
    },
    answer("trust_delegate"),
  );

  server.registerTool(
    "policy_read",
    {
      description: "Read the active ArmorIQ policy summary and, optionally, how it treats a given tool.",
      inputSchema: { tool: z.string().optional().describe("Tool name to evaluate against the policy, e.g. run_command") },
    },
    answer("policy_read"),
  );

  return server;
}
