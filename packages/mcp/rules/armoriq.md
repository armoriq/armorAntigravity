---
trigger: always_on
---

ArmorIQ intent capture is active for this conversation.
For each user prompt, before the first tool that needs a plan, call register_intent_plan once with the plan in this JSON shape. Tools other than read_file, view_file, list_dir, find_by_name and grep_search need a plan (including run_command, file edits, search_web, read_url_content, invoke_subagent, browser actions and MCP tools). A prompt that needs none of these tools needs no registration:

{
  "goal": "<one-line summary of the task>",
  "steps": [
    { "action": "<tool name, e.g. run_command, write_to_file, replace_file_content>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }
  ]
}

Use the exact Antigravity tool names. For an MCP tool you reach through call_mcp_tool, the action is mcp_<server>_<tool>: ServerName github with ToolName create_issue is mcp_github_create_issue.
When your workspace enforces, tool calls without a registered plan are blocked, and so is any tool that is not in the plan. In Monitor nothing is blocked, but plans are still recorded.
If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most 2 revisions are accepted per user message.
Subagents inherit the plan of the conversation that started them and cannot register their own.
