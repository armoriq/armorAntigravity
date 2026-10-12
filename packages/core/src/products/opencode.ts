import type { ProductConfig, ToolVocabulary } from "../product.ts";
import type { SessionID, StepUsage, TokenUsageEntry } from "../types.ts";
import { sessionTitle, type SessionTitle } from "../usage.ts";

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

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// A step-finish part carries that step's tokens; message.tokens holds only the last step.
// OpenCode reports reasoning separately from output; ArmorCodex counts reasoning inside outputTokens, so it is added back.
export function stepUsageFromPart(
  part: unknown,
  modelOf: (messageId: string) => string | null,
  repo: string,
  at: number = Date.now(),
): StepUsage | null {
  if (!isStepFinish(part)) return null;
  const t = part.tokens ?? {};
  const entry: TokenUsageEntry = {
    model: modelOf(part.messageID) ?? "unknown",
    inputTokens: count(t.input),
    outputTokens: count(t.output) + count(t.reasoning),
    cacheReadTokens: count(t.cache?.read),
    cacheWriteTokens: count(t.cache?.write),
  };
  if (entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens === 0) return null;
  const reasoningTokens = count(t.reasoning);
  return { sessionId: part.sessionID as SessionID, messageId: part.messageID, partId: part.id, at, repo, entry, reasoningTokens };
}

type StepFinish = { id: string; sessionID: string; messageID: string; tokens?: Record<string, any> };

function isStepFinish(part: unknown): part is StepFinish {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return p.type === "step-finish" && typeof p.id === "string" && typeof p.sessionID === "string" && typeof p.messageID === "string";
}

const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// OpenCode does not move time.updated on a rename, so the title is stamped when the plugin sees it.
export function titleFromSession(info: unknown, at: number = Date.now()): SessionTitle | null {
  if (!info || typeof info !== "object") return null;
  const { id, title } = info as { id?: unknown; title?: unknown };
  if (typeof id !== "string" || typeof title !== "string") return null;
  if (PLACEHOLDER_TITLE.test(title.trim())) return null;
  return sessionTitle(id, title, OPENCODE.titleSource, at);
}
