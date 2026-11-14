import {
  compilePolicy,
  decide,
  type BuiltinContext,
  type CompileResult,
  type ProductConfig,
  type Session,
  type SessionID,
  type ToolCall,
  type ToolVocabulary,
} from "@armorantigravity/core";
import type { DecideFn } from "./decision.ts";
import { canonicalToolName, mcpPart, nameReadings, policyNames } from "./tools.ts";

const NATIVE: ReadonlySet<string> = new Set([
  "run_command",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "notebook_edit",
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "search_web",
  "read_url_content",
  "invoke_subagent",
  "define_subagent",
  "send_message",
  "manage_subagents",
]);

// PRD 5.3 lists web tools apart from read-only ones, unlike armorOpenCode,
// so search_web and read_url_content need a plan step in enforce mode.
const READ_ONLY: ReadonlySet<string> = new Set(["view_file", "list_dir", "find_by_name", "grep_search"]);

const PATCH_PATH = /^\*\*\* (?:Add File|Delete File|Update File|Move to):(.*)$/gm;

// The hook folds a server's `-` to `_`, so every `_` after `mcp_` is a possible end of the server name.
function mcpServerCandidates(tool: string): string[] {
  if (!tool.startsWith("mcp_")) return [""];
  const rest = tool.slice(4);
  const out: string[] = [];
  for (let i = rest.indexOf("_"); i > 0; i = rest.indexOf("_", i + 1)) out.push(rest.slice(0, i));
  return out.length ? out : [""];
}

// Calls reach the core through mapToolCall, so `args` already carries the
// field names listed here (command, workdir, filePath, path, pattern, include, url).
export const ANTIGRAVITY_TOOLS: ToolVocabulary = {
  readOnly: READ_ONLY,
  native: NATIVE,
  canonical: (name) => canonicalToolName(name),
  policyNames: (value) => policyNames(value),
  nameReadings,
  mcpServerCandidates,
  mcpServerNames: (server) => [server, mcpPart(server)],
  pathFields: new Map([
    ["run_command", ["command", "workdir"]],
    ["write_to_file", ["filePath"]],
    ["replace_file_content", ["filePath"]],
    ["multi_replace_file_content", ["filePath"]],
    ["notebook_edit", ["filePath"]],
    ["view_file", ["filePath"]],
    ["list_dir", ["path"]],
    ["find_by_name", ["pattern", "path"]],
    ["grep_search", ["path", "include"]],
  ]),
  // Whether these search hidden directories is not documented; assume they do.
  searchRoot: (call) =>
    (call.tool === "grep_search" || call.tool === "find_by_name") && typeof call.args.path === "string" ? call.args.path : null,
  multiFileEdit: (call) => {
    const patch = call.args.patchText;
    if (typeof patch !== "string") return null;
    return [...patch.matchAll(PATCH_PATH)].map((m) => (m[1] ?? "").trim()).filter((p) => p.length > 0);
  },
  args: { command: ["command"], path: ["filePath", "path"], url: ["url"] },
};

export const ANTIGRAVITY: ProductConfig = {
  slug: "armorantigravity",
  agentId: "antigravity",
  childSessionKey: "_antigravity_session",
  titleSource: "antigravity-session-title",
  tools: ANTIGRAVITY_TOOLS,
};

export function compileAntigravityPolicy(raw: unknown): CompileResult {
  return compilePolicy(raw, ANTIGRAVITY_TOOLS);
}

export type SessionPair = { readonly session: Session; readonly root: Session };

// The core's decide() for the handler. The daemon resolves a conversation's
// session and root (plan, token, step cursor); the hook's mode wins over the stored one.
export function createCoreDecide(deps: {
  readonly sessions: (id: SessionID) => SessionPair;
  readonly builtin: BuiltinContext;
}): DecideFn {
  return ({ call, policy, mode, now }) => {
    const { session, root } = deps.sessions(call.sessionId);
    const coreCall: ToolCall = call;
    return decide({ policy, session: { ...session, mode }, root: { ...root, mode }, call: coreCall, now, builtin: deps.builtin, tools: ANTIGRAVITY_TOOLS });
  };
}
