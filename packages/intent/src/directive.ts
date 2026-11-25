import { MAX_REVISIONS_PER_TURN } from "./own-tools.ts";

// Injected on PreInvocation; RULE_DIRECTIVE ships as ~/.gemini/config/rules/armoriq.md (packages/mcp).
const ENFORCING = "ArmorIQ intent enforcement is active for this conversation.";
// True in every mode, so Monitor and the installed rule say capture where the Enforce directive says enforcement.
const CAPTURING = "ArmorIQ intent capture is active for this conversation.";
const BLOCKED = "Tool calls without a registered plan are blocked, and so is any tool that is not in the plan.";
const LINES = [
  ENFORCING,
  "For each user prompt, before the first tool that needs a plan, call register_intent_plan once with the plan in this JSON shape. Tools other than read_file, view_file, list_dir, find_by_name and grep_search need a plan (including run_command, file edits, search_web, read_url_content, invoke_subagent, browser actions and MCP tools). A prompt that needs none of these tools needs no registration:",
  "",
  "{",
  '  "goal": "<one-line summary of the task>",',
  '  "steps": [',
  '    { "action": "<tool name, e.g. run_command, write_to_file, replace_file_content>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }',
  "  ]",
  "}",
  "",
  "Use the exact Antigravity tool names. For an MCP tool you reach through call_mcp_tool, the action is mcp_<server>_<tool>: ServerName github with ToolName create_issue is mcp_github_create_issue.",
  BLOCKED,
  `If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most ${MAX_REVISIONS_PER_TURN} revisions are accepted per user message.`,
  "Subagents inherit the plan of the conversation that started them and cannot register their own.",
];

export const INTENT_DIRECTIVE = LINES.join("\n");
// The installed rule is read in every mode, so its blocking line says when it applies.
const RULE_BLOCKED = "When your workspace enforces, tool calls without a registered plan are blocked, and so is any tool that is not in the plan. In Monitor nothing is blocked, but plans are still recorded.";
export const RULE_DIRECTIVE = LINES.map(line => (line === ENFORCING ? CAPTURING : line === BLOCKED ? RULE_BLOCKED : line)).join("\n");
// Signed in, Monitor asks for the same plan but never blocks or holds a call, so it leaves out the line saying it would.
export const MONITOR_INTENT_DIRECTIVE = LINES.filter(line => line !== BLOCKED).map(line => (line === ENFORCING ? CAPTURING : line)).join("\n");

export function planningDraftNote(path: string): string {
  return `Planning mode wrote ${path}. Before carrying it out, call register_intent_plan with the tools that plan uses as steps.`;
}
