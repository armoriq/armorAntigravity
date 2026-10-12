---
trigger: always_on
---

ArmorIQ intent enforcement is active for this conversation.
Before any tool that changes state (run_command, write_to_file, replace_file_content, multi_replace_file_content, invoke_subagent, a browser action, or an MCP tool), call register_intent_plan once with the plan in this JSON shape:

{
  "goal": "<one-line summary of the task>",
  "steps": [
    { "action": "<tool name, e.g. run_command, write_to_file, replace_file_content>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }
  ]
}

Use the exact Antigravity tool names. MCP tools are named mcp_<server>_<tool>. view_file, list_dir, find_by_name, grep_search, search_web and read_url_content do not need to be in the plan.
Side-effecting tool calls without a registered plan are blocked, and so is any tool that is not in the plan.
If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most 2 revisions are accepted per user message.
Subagents inherit the plan of the conversation that started them and cannot register their own.
