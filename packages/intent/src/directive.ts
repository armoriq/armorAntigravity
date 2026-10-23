import { MAX_REVISIONS_PER_TURN } from "./own-tools.ts";

// The same text ships as ~/.gemini/config/rules/armoriq.md (packages/mcp) and is injected on PreInvocation.
export const INTENT_DIRECTIVE = [
  "ArmorIQ intent enforcement is active for this conversation.",
  "Before any tool other than read_file, view_file, list_dir, find_by_name and grep_search (that includes run_command, file edits, search_web, read_url_content, invoke_subagent, browser actions and MCP tools), call register_intent_plan once with the plan in this JSON shape:",
  "",
  "{",
  '  "goal": "<one-line summary of the task>",',
  '  "steps": [',
  '    { "action": "<tool name, e.g. run_command, write_to_file, replace_file_content>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }',
  "  ]",
  "}",
  "",
  "Use the exact Antigravity tool names. For an MCP tool you reach through call_mcp_tool, the action is mcp_<server>_<tool>: ServerName github with ToolName create_issue is mcp_github_create_issue.",
  "Tool calls without a registered plan are blocked, and so is any tool that is not in the plan.",
  `If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most ${MAX_REVISIONS_PER_TURN} revisions are accepted per user message.`,
  "Subagents inherit the plan of the conversation that started them and cannot register their own.",
].join("\n");

export function planningDraftNote(path: string): string {
  return `Planning mode wrote ${path}. Before carrying it out, call register_intent_plan with the tools that plan uses as steps.`;
}
