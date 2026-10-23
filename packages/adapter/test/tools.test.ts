import { describe, expect, test } from "bun:test";
import { parseHookPayload } from "../src/payload.ts";
import { canonicalToolName, isReadOnly, mapToolCall, nameReadings, policyNames, resolveMcpCall } from "../src/tools.ts";
import { captured, fixture } from "./fixtures.ts";

function toolCallOf(raw: unknown) {
  const r = parseHookPayload("PreToolUse", raw);
  if (!r.ok || r.payload.event !== "PreToolUse") throw new Error("not a PreToolUse payload");
  return r.payload.toolCall;
}
const capturedCall = (name: string) => toolCallOf(captured(name).stdin);

describe("mapToolCall: PRD 5.3 table", () => {
  test.each([
    ["run_command", "shell"],
    ["write_to_file", "write"],
    ["replace_file_content", "write"],
    ["multi_replace_file_content", "write"],
    ["notebook_edit", "write"],
    ["view_file", "read"],
    ["list_dir", "read"],
    ["find_by_name", "read"],
    ["grep_search", "read"],
    ["search_web", "web"],
    ["read_url_content", "web"],
    ["invoke_subagent", "subagent"],
    ["define_subagent", "subagent"],
    ["send_message", "subagent"],
    ["manage_subagents", "subagent"],
    ["browser_click", "browser"],
  ] as const)("%s is %s and keeps its name", (name, category) => {
    const m = mapToolCall({ name, args: {} });
    expect(m.tool).toBe(name);
    expect(m.category).toBe(category);
  });

  test("only file reads and searches are read-only", () => {
    const readOnly = ["view_file", "list_dir", "find_by_name", "grep_search"];
    for (const name of ["run_command", "write_to_file", "search_web", "invoke_subagent", "browser_click", ...readOnly]) {
      expect(isReadOnly(mapToolCall({ name, args: {} }))).toBe(readOnly.includes(name));
    }
    expect(isReadOnly(mapToolCall(capturedCall("pre-call_mcp_tool-global")))).toBe(false);
  });
});

describe("mapToolCall on captured agy calls", () => {
  test("run_command: CommandLine and Cwd become command and workdir", () => {
    expect(mapToolCall(capturedCall("pre-run_command")).args).toMatchObject({
      command: "touch /Users/dev/src/ws/m-deny",
      workdir: "/Users/dev/src/ws",
      CommandLine: "touch /Users/dev/src/ws/m-deny",
    });
  });

  test("write_to_file: TargetFile becomes filePath, content is untouched", () => {
    expect(mapToolCall(capturedCall("pre-write_to_file")).args).toMatchObject({ filePath: "/Users/dev/src/ws/notes.txt", CodeContent: "spike" });
  });

  test("view_file: AbsolutePath becomes filePath", () => {
    expect(mapToolCall(capturedCall("pre-view_file")).args).toMatchObject({ filePath: "/Users/dev/src/ws/notes.txt" });
  });

  test("read_file (agy 1.4): Path becomes filePath and it is a read-only view_file", () => {
    const m = mapToolCall(capturedCall("pre-read_file"));
    expect(m).toMatchObject({ name: "read_file", tool: "view_file", category: "read", args: { filePath: "/Users/dev/src/ws/enum/a.txt" } });
    expect(isReadOnly(m)).toBe(true);
  });

  test("write_file (agy 1.4): Path becomes filePath, content is untouched", () => {
    const m = mapToolCall(capturedCall("pre-write_file"));
    expect(m).toMatchObject({ name: "write_file", tool: "write_to_file", category: "write", args: { filePath: "/Users/dev/src/ws/enum/new.txt", Content: "hello" } });
    expect(isReadOnly(m)).toBe(false);
  });

  test("edit_file (agy 1.4): Path becomes filePath, Target is not a path", () => {
    const m = mapToolCall(capturedCall("pre-edit_file"));
    expect(m).toMatchObject({ name: "edit_file", tool: "replace_file_content", category: "write", args: { filePath: "/Users/dev/src/ws/enum/edit.txt", Target: "two" } });
    expect(isReadOnly(m)).toBe(false);
  });

  test("search_web keeps query", () => {
    expect(mapToolCall(capturedCall("pre-search_web"))).toMatchObject({ category: "web", args: { query: "antigravity hooks docs" } });
  });

  test("invoke_subagent and send_message are subagent tools", () => {
    expect(mapToolCall(capturedCall("pre-invoke_subagent")).category).toBe("subagent");
    expect(mapToolCall(capturedCall("pre-send_message")).category).toBe("subagent");
  });

  test("grep_search reads its query as the pattern, never as a file path", () => {
    const m = mapToolCall({ name: "grep_search", args: { SearchPath: "/repo", Query: "TODO", Includes: "*.ts" } });
    expect(m.args).toMatchObject({ path: "/repo", pattern: "TODO", include: "*.ts" });
    expect("filePath" in m.args).toBe(false);
  });

  test("non-object args become an empty record", () => {
    expect(mapToolCall({ name: "run_command", args: "ls" }).args).toEqual({});
    expect(mapToolCall({ name: "run_command", args: null }).args).toEqual({});
  });
});

describe("MCP: both captured shapes", () => {
  test("call_mcp_tool for an mcp_config.json server", () => {
    const m = mapToolCall(capturedCall("pre-call_mcp_tool-global"));
    if (m.category !== "mcp") throw new Error("expected mcp");
    expect(m.mcp).toEqual({ server: "agspike-global", tool: "echo" });
    expect(m.tool).toBe("mcp_agspike_global_echo");
    expect(m.args).toEqual({ text: "mcp-ping" });
  });

  test("call_mcp_tool for a plugin server keeps the plugin-namespaced server name", () => {
    const m = mapToolCall(capturedCall("pre-call_mcp_tool-plugin"));
    if (m.category !== "mcp") throw new Error("expected mcp");
    expect(m.mcp).toEqual({ server: "agspike_agspike-plugin", tool: "echo" });
    expect(m.tool).toBe("mcp_agspike_agspike_plugin_echo");
  });

  test("per-tool name for Antigravity's built-in chrome-devtools server", () => {
    const m = mapToolCall(capturedCall("pre-mcp_chrome_devtools_navigate_page"));
    if (m.category !== "mcp") throw new Error("expected mcp");
    expect(m.mcp).toEqual({ server: "chrome-devtools", tool: "navigate_page" });
    expect(m.tool).toBe("mcp_chrome_devtools_navigate_page");
    expect(m.args).toMatchObject({ url: "https://example.com", pageId: 1 });
  });

  test("the two shapes compare equal for the same server and tool", () => {
    const viaCall = mapToolCall({ name: "call_mcp_tool", args: { ServerName: "chrome-devtools", ToolName: "list_pages", Arguments: {} } });
    expect(viaCall.tool).toBe(mapToolCall({ name: "mcp_chrome_devtools_list_pages", args: {} }).tool);
  });

  test("per-tool names split at the longest known server", () => {
    const known = new Set(["git", "github", "my-server"]);
    expect(resolveMcpCall("mcp_github_create_issue", {}, known)?.target).toEqual({ server: "github", tool: "create_issue" });
    expect(resolveMcpCall("mcp_my_server_do_it", {}, known)?.target).toEqual({ server: "my-server", tool: "do_it" });
  });

  test("an unknown server's per-tool name still maps to MCP, on its first segment", () => {
    const m = mapToolCall({ name: "mcp_acme_tools_deploy", args: {} });
    expect(m.category).toBe("mcp");
    if (m.category === "mcp") expect(m.mcp.server).toBe("acme");
  });

  test("call_mcp_tool missing a server is unknown and side-effecting", () => {
    const m = mapToolCall({ name: "call_mcp_tool", args: { ToolName: "create_issue" } });
    expect(m).toMatchObject({ category: "unknown", tool: "call_mcp_tool" });
  });

  test("plan and policy spellings: mcp__server__tool and mcp(server/tool)", () => {
    expect(canonicalToolName("mcp__chrome-devtools__list_pages")).toBe("mcp_chrome_devtools_list_pages");
    expect(canonicalToolName("mcp(agspike-global/echo)")).toBe("mcp_agspike_global_echo");
  });

  test("ArmorIQ's own server maps to bare tool names; a third party's tool of the same name does not", () => {
    expect(mapToolCall({ name: "call_mcp_tool", args: { ServerName: "armoriq", ToolName: "register_intent_plan", Arguments: {} } }).tool).toBe("register_intent_plan");
    expect(mapToolCall({ name: "mcp_guard_register_intent_plan", args: {} }, { ownMcpServer: "guard", knownMcpServers: new Set(["guard"]) }).tool).toBe("register_intent_plan");
    expect(mapToolCall({ name: "call_mcp_tool", args: { ServerName: "evil", ToolName: "register_intent_plan" } }).tool).toBe("mcp_evil_register_intent_plan");
  });
});

test("unknown tools pass through by name and are not read-only", () => {
  const m = mapToolCall({ name: "generate_image", args: { prompt: "x" } });
  expect(m).toMatchObject({ tool: "generate_image", category: "unknown", args: { prompt: "x" } });
  expect(isReadOnly(m)).toBe(false);
});

describe("canonicalToolName: ArmorClaude and OpenCode aliases for plans", () => {
  test.each([
    ["Bash", "run_command"],
    ["bash", "run_command"],
    ["run_command", "run_command"],
    ["Edit", "replace_file_content"],
    ["MultiEdit", "multi_replace_file_content"],
    ["apply_patch", "multi_replace_file_content"],
    ["NotebookEdit", "notebook_edit"],
    ["Write", "write_to_file"],
    ["Read", "view_file"],
    ["LS", "list_dir"],
    ["Glob", "find_by_name"],
    ["Grep", "grep_search"],
    ["WebFetch", "read_url_content"],
    ["WebSearch", "search_web"],
    ["Task", "invoke_subagent"],
    ["Agent", "invoke_subagent"],
    [" Bash ", "run_command"],
    ["read_file", "view_file"],
    ["write_file", "write_to_file"],
    ["edit_file", "replace_file_content"],
  ])("%s -> %s", (name, canonical) => {
    expect(canonicalToolName(name)).toBe(canonical);
  });
});

describe("policy vocabulary", () => {
  test.each([
    ["Bash", ["bash", "run_command"]],
    ["run_command", ["run_command"]],
    ["Edit", ["edit", "replace_file_content", "multi_replace_file_content"]],
    ["replace_file_content", ["replace_file_content", "multi_replace_file_content"]],
    ["apply_patch", ["apply_patch", "write_to_file", "replace_file_content", "multi_replace_file_content"]],
    ["Task", ["task", "invoke_subagent", "define_subagent", "send_message", "manage_subagents"]],
    ["mcp__github__create_issue", ["mcp__github__create_issue", "mcp_github_create_issue"]],
    ["read_file", ["read_file", "view_file"]],
    ["write_file", ["write_file", "write_to_file"]],
    ["edit_file", ["edit_file", "replace_file_content", "multi_replace_file_content"]],
    ["GenerateImage", ["generateimage"]],
  ])("policyNames(%s)", (value, expected) => {
    expect(policyNames(value)).toEqual(expected);
  });

  test("nameReadings gives ArmorClaude's names for tool.name conditions", () => {
    expect(nameReadings("run_command")).toEqual(["run_command", "Bash", "bash"]);
    expect(nameReadings("mcp_github_create_issue")).toEqual(["mcp_github_create_issue"]);
    expect(nameReadings("view_file")).toContain("read_file");
    expect(nameReadings("write_to_file")).toContain("write_file");
    expect(nameReadings("replace_file_content")).toContain("edit_file");
  });
});

test("documented MCP payload with domain arguments", () => {
  const m = mapToolCall(toolCallOf(fixture("documented/pre-call-mcp-tool.json")));
  expect(m).toMatchObject({ tool: "mcp_github_create_issue", args: { owner: "acme", repo: "shop-api" } });
});
