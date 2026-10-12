import type { ProductConfig, ToolVocabulary } from "../product.ts";

// armorOpenCode's product config, kept so the vendored tests prove parity
// with upstream and as the reference for other adapters.

export const OPENCODE_TOOLS: ReadonlySet<string> = new Set([
  "bash", "read", "write", "edit", "apply_patch", "grep", "glob", "list", "webfetch", "websearch", "task",
  "todowrite", "todoread", "skill", "question", "lsp", "codesearch", "plan",
]);

export const OPENCODE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "list", "webfetch", "websearch", "todoread", "todowrite",
]);

// ArmorClaude names that differ from OpenCode's by more than case.
export const CLAUDE_TO_OPENCODE: ReadonlyMap<string, string> = new Map([
  ["multiedit", "edit"],
  ["agent", "task"],
  ["notebookread", "read"],
  ["notebookedit", "edit"],
  ["ls", "list"],
]);

// For policies written against ArmorClaude's tool.name values.
export const OPENCODE_TO_CLAUDE: ReadonlyMap<string, string> = new Map([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["list", "LS"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["task", "Task"],
  ["todowrite", "TodoWrite"],
  ["skill", "Skill"],
]);

// OpenCode mcp/catalog.ts names MCP tools sanitize(server) + "_" + sanitize(tool).
export function sanitizeMcpPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ArmorClaude's mcp__server__tool as OpenCode's server_tool; null when the name is not in that form.
export function mcpToolName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const sep = name.indexOf("__", 6);
  if (sep === -1 || sep + 2 >= name.length) return null;
  return `${sanitizeMcpPart(name.slice(5, sep))}_${sanitizeMcpPart(name.slice(sep + 2))}`.toLowerCase();
}

const PATCH_PATH = /^\*\*\* (?:Add File|Delete File|Update File|Move to):(.*)$/gm;

// Every path an apply_patch call touches, parsed as OpenCode patch/index.ts
// does: the text after the colon, trimmed, with or without a space.
export function patchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const m of patchText.matchAll(PATCH_PATH)) {
    const p = m[1]!.trim();
    if (p) out.push(p);
  }
  return out;
}

// Plans written with ArmorClaude names (Bash, MultiEdit, mcp__server__tool)
// resolve to the OpenCode tool they mean.
function canonical(action: string): string {
  const trimmed = action.trim();
  const mcp = mcpToolName(trimmed);
  if (mcp) return mcp;
  const lower = trimmed.toLowerCase();
  return CLAUDE_TO_OPENCODE.get(lower) ?? lower;
}

function policyNames(value: string): string[] {
  const lower = value.trim().toLowerCase();
  const names = [lower];
  const mapped = CLAUDE_TO_OPENCODE.get(lower);
  if (mapped) names.push(mapped);
  const mcp = mcpToolName(value.trim());
  if (mcp) names.push(mcp);
  // apply_patch is the edit tool OpenCode offers some models instead of
  // write and edit; rules on those must reach it.
  if (names.includes("write") || names.includes("edit")) names.push("apply_patch");
  return names;
}

// OpenCode names an MCP tool sanitize(server) + "_" + sanitize(tool), so a
// server containing "_" is ambiguous: every "_" is a possible split point.
function mcpServerCandidates(tool: string): string[] {
  if (tool.startsWith("mcp__")) return [tool.split("__")[1] ?? ""];
  if (OPENCODE_TOOLS.has(tool)) return [""];
  const out: string[] = [];
  for (let i = tool.indexOf("_"); i > 0; i = tool.indexOf("_", i + 1)) out.push(tool.slice(0, i));
  return out.length ? out : [""];
}

export const OPENCODE_VOCABULARY: ToolVocabulary = {
  readOnly: OPENCODE_READ_ONLY_TOOLS,
  native: OPENCODE_TOOLS,
  canonical,
  policyNames,
  nameReadings(tool) {
    const claude = OPENCODE_TO_CLAUDE.get(tool);
    return claude ? [tool, claude] : [tool];
  },
  mcpServerCandidates,
  mcpServerNames: (server) => [server, sanitizeMcpPart(server)],
  pathFields: new Map([
    ["read", ["filePath"]],
    ["write", ["filePath"]],
    ["edit", ["filePath"]],
    ["list", ["path"]],
    ["grep", ["path", "include"]],
    ["glob", ["pattern", "path"]],
    ["bash", ["command", "workdir"]],
  ]),
  // ripgrep runs with --hidden.
  searchRoot: (call) => (call.tool === "grep" && typeof call.args.path === "string" ? call.args.path : null),
  multiFileEdit: (call) =>
    call.tool === "apply_patch" && typeof call.args.patchText === "string" ? patchPaths(call.args.patchText) : null,
  args: { command: ["command"], path: ["filePath", "file_path", "path"], url: ["url"] },
};

export const OPENCODE: ProductConfig = {
  slug: "armoropencode",
  agentId: "opencode",
  childSessionKey: "_opencode_session",
  titleSource: "opencode-session-title",
  tools: OPENCODE_VOCABULARY,
};
