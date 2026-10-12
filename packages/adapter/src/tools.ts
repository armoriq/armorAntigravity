import type { ToolCall } from "@armorantigravity/protocol";

export type Args = Readonly<Record<string, unknown>>;

export type ToolCategory = "shell" | "write" | "read" | "web" | "subagent" | "browser" | "mcp" | "unknown";

export type McpTarget = { readonly server: string; readonly tool: string };

type MappedBase = {
  // The name Antigravity sent, kept for audit rows and messages.
  readonly name: string;
  // The name plans and policy compare by: Antigravity's own tool name, with
  // ArmorClaude and OpenCode spellings resolved to it and MCP calls in the
  // hook's `mcp_<server>_<tool>` form, so both MCP shapes compare equal.
  readonly tool: string;
  // Original args plus the fields the core reads under fixed names
  // (command, workdir, filePath, path, pattern, include, url, query).
  readonly args: Args;
};

export type MappedCall =
  | (MappedBase & { readonly category: "mcp"; readonly mcp: McpTarget })
  | (MappedBase & { readonly category: Exclude<ToolCategory, "mcp"> });

type BuiltinCategory = Exclude<ToolCategory, "mcp" | "unknown">;

// PRD 5.3.
const ANTIGRAVITY_TOOLS: ReadonlyMap<string, BuiltinCategory> = new Map([
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
]);

// ArmorClaude and ArmorOpenCode names, lower-cased, to the Antigravity tool
// they mean. Same table as packages/intent plan.ts PLAN_ALIASES.
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["bash", "run_command"],
  ["shell", "run_command"],
  ["write", "write_to_file"],
  ["edit", "replace_file_content"],
  ["multiedit", "multi_replace_file_content"],
  ["apply_patch", "multi_replace_file_content"],
  ["notebookedit", "notebook_edit"],
  ["read", "view_file"],
  ["notebookread", "view_file"],
  ["ls", "list_dir"],
  ["list", "list_dir"],
  ["glob", "find_by_name"],
  ["grep", "grep_search"],
  ["webfetch", "read_url_content"],
  ["websearch", "search_web"],
  ["task", "invoke_subagent"],
  ["agent", "invoke_subagent"],
]);

// Fields the core reads, and where Antigravity puts them. Names marked
// "captured" were seen in agy CLI payloads (P0 spike); the rest are the
// documented or Cascade-family spellings, unconfirmed.
const ARG_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ["command", ["CommandLine" /* captured */, "command", "commandLine"]],
  ["workdir", ["Cwd" /* captured */, "cwd", "workdir"]],
  ["filePath", ["TargetFile" /* captured */, "AbsolutePath" /* captured */, "targetFile", "absolutePath", "filePath", "file_path"]],
  ["path", ["DirectoryPath", "SearchDirectory", "SearchPath", "directoryPath", "searchPath", "path"]],
  ["pattern", ["Pattern", "Query", "pattern"]],
  ["include", ["Includes", "includes", "include"]],
  ["url", ["Url", "url" /* captured: chrome devtools navigate_page */, "URL"]],
  ["query", ["query" /* captured */, "Query"]],
]);

const FIELDS_FOR_TOOL: ReadonlyMap<string, readonly string[]> = new Map([
  ["run_command", ["command", "workdir"]],
  ["write_to_file", ["filePath"]],
  ["replace_file_content", ["filePath"]],
  ["multi_replace_file_content", ["filePath"]],
  ["notebook_edit", ["filePath"]],
  ["view_file", ["filePath"]],
  ["list_dir", ["path"]],
  ["find_by_name", ["pattern", "path"]],
  ["grep_search", ["pattern", "path", "include"]],
  ["read_url_content", ["url"]],
  ["search_web", ["query"]],
]);

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(args: Args, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function canonicalArgs(tool: string, args: Args): Args {
  const fields = FIELDS_FOR_TOOL.get(tool);
  if (!fields) return args;
  const out: Record<string, unknown> = { ...args };
  for (const field of fields) {
    const value = firstString(args, ARG_SOURCES.get(field) ?? [field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// The hook names a per-tool MCP call mcp_<server>_<tool> with every character
// other than a letter, digit or underscore folded to `_` (captured:
// `mcp_chrome_devtools_list_pages`).
export function mcpPart(part: string): string {
  return part.trim().replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
}

export function mcpToolName(target: McpTarget): string {
  return `mcp_${mcpPart(target.server)}_${mcpPart(target.tool)}`;
}

const MCP_CALL_TOOL = "call_mcp_tool";
const SERVER_KEYS = ["ServerName" /* captured */, "serverName", "server"];
const TOOL_KEYS = ["ToolName" /* captured */, "toolName", "tool"];
const ARGUMENT_KEYS = ["Arguments" /* captured */, "arguments", "args"];

// Servers Antigravity provides itself, so they appear in no mcp_config.json.
export const BUILTIN_MCP_SERVERS: readonly string[] = ["chrome-devtools"];

export type McpResolution = { target: McpTarget; args: Args } | null;

// Both shapes the spike captured from agy: `call_mcp_tool` with ServerName,
// ToolName and Arguments for servers from mcp_config.json and plugins, and one
// name per tool (`mcp_chrome_devtools_list_pages`) for Antigravity's built-in
// browser server. ArmorClaude's `mcp__server__tool` and the permission form
// `mcp(server/tool)` are accepted too, for plans and policies.
export function resolveMcpCall(name: string, rawArgs: unknown, knownServers: ReadonlySet<string> = new Set()): McpResolution {
  const args = isRecord(rawArgs) ? rawArgs : {};
  if (name === MCP_CALL_TOOL) {
    const server = firstString(args, SERVER_KEYS);
    const tool = firstString(args, TOOL_KEYS);
    if (!server || !tool) return null;
    const inner = ARGUMENT_KEYS.map((k) => args[k]).find(isRecord);
    return { target: { server, tool }, args: inner ?? {} };
  }
  const paren = /^mcp\(([^/()]+)\/([^/()]+)\)$/i.exec(name);
  if (paren?.[1] && paren[2]) return { target: { server: paren[1], tool: paren[2] }, args };
  if (name.startsWith("mcp__")) {
    const sep = name.indexOf("__", 5);
    if (sep > 5 && sep + 2 < name.length) return { target: { server: name.slice(5, sep), tool: name.slice(sep + 2) }, args };
    return null;
  }
  if (!name.startsWith("mcp_")) return null;
  // The folded name loses where the server ends; match the longest known server.
  const bare = name.slice(4);
  let best: string | null = null;
  for (const server of [...knownServers, ...BUILTIN_MCP_SERVERS]) {
    const folded = mcpPart(server);
    if (bare.length > folded.length + 1 && bare.startsWith(`${folded}_`) && (best === null || folded.length > mcpPart(best).length)) {
      best = server;
    }
  }
  if (best !== null) return { target: { server: best, tool: bare.slice(mcpPart(best).length + 1) }, args };
  // Unknown server: the first segment stands in for it, so the gate asks
  // about a name that matches nothing registered rather than letting it pass.
  const sep = bare.indexOf("_");
  if (sep > 0 && sep < bare.length - 1) return { target: { server: bare.slice(0, sep), tool: bare.slice(sep + 1) }, args };
  return null;
}

export type MapOptions = {
  // Servers from mcp_config.json, plugins and the backend registry; used to
  // split per-tool MCP names.
  readonly knownMcpServers?: ReadonlySet<string>;
  // ArmorIQ's own MCP server. Its tools map to their bare names so the core's
  // own-tool check sees `register_intent_plan`.
  readonly ownMcpServer?: string;
};

export const DEFAULT_OWN_MCP_SERVER = "armoriq";

export function mapToolCall(call: ToolCall, options: MapOptions = {}): MappedCall {
  const { name } = call;
  const args = isRecord(call.args) ? call.args : {};
  const builtin = ANTIGRAVITY_TOOLS.get(name);
  if (builtin) return { name, tool: name, category: builtin, args: canonicalArgs(name, args) };

  if (name.startsWith("browser_")) return { name, tool: name, category: "browser", args };

  const mcp = resolveMcpCall(name, call.args, options.knownMcpServers);
  if (mcp) {
    const own = mcpPart(options.ownMcpServer ?? DEFAULT_OWN_MCP_SERVER);
    const tool = mcpPart(mcp.target.server) === own ? mcp.target.tool : mcpToolName(mcp.target);
    return { name, tool, category: "mcp", mcp: mcp.target, args: mcp.args };
  }

  const alias = ALIASES.get(name.toLowerCase());
  const aliasCategory = alias === undefined ? undefined : ANTIGRAVITY_TOOLS.get(alias);
  if (alias && aliasCategory) return { name, tool: alias, category: aliasCategory, args: canonicalArgs(alias, args) };
  // Anything unrecognised is side-effecting: no read-only pass, and in
  // enforce mode it needs a plan step.
  return { name, tool: name, category: "unknown", args };
}

// For plan steps and backend lists: Antigravity, ArmorClaude and OpenCode
// spellings, including `mcp__server__tool`, to the name calls compare by.
export function canonicalToolName(name: string, options: MapOptions = {}): string {
  return mapToolCall({ name: name.trim(), args: {} }, options).tool;
}

// Antigravity picks one of these per edit count; a rule or plan step naming either covers both.
const EDIT_FAMILY = ["replace_file_content", "multi_replace_file_content"];
const SUBAGENT_TOOLS = ["invoke_subagent", "define_subagent", "send_message", "manage_subagents"];

// Every Antigravity tool a policy selector value reaches, the value's own
// canonical name included. For the core's ToolVocabulary.policyNames.
export function policyNames(value: string, options: MapOptions = {}): string[] {
  const lower = value.trim().toLowerCase();
  if (lower === "task" || lower === "agent") return SUBAGENT_TOOLS;
  if (lower === "apply_patch") return ["write_to_file", ...EDIT_FAMILY];
  const tool = canonicalToolName(value, options);
  return EDIT_FAMILY.includes(tool) ? EDIT_FAMILY : [tool];
}

// ArmorClaude's name for each tool, so a `tool.name` condition written for
// ArmorClaude matches. For the core's ToolVocabulary.nameReadings.
const CLAUDE_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ["run_command", ["Bash", "bash"]],
  ["write_to_file", ["Write", "write"]],
  ["replace_file_content", ["Edit", "edit"]],
  ["multi_replace_file_content", ["MultiEdit", "Edit", "edit"]],
  ["notebook_edit", ["NotebookEdit"]],
  ["view_file", ["Read", "read"]],
  ["list_dir", ["LS", "list"]],
  ["find_by_name", ["Glob", "glob"]],
  ["grep_search", ["Grep", "grep"]],
  ["read_url_content", ["WebFetch", "webfetch"]],
  ["search_web", ["WebSearch", "websearch"]],
  ["invoke_subagent", ["Task", "Agent", "task"]],
]);

export function nameReadings(tool: string): string[] {
  return [tool, ...(CLAUDE_NAMES.get(tool) ?? [])];
}

export function isReadOnly(mapped: MappedCall): boolean {
  return mapped.category === "read";
}
