import type { ToolCall } from "./types.ts";

// Everything in the decision core that names the host agent. The decision
// order and reason codes are fixed; only these names vary by product.
export type ProductConfig = {
  // Audit client_id and the X-ArmorIQ-Client product, e.g. "armorantigravity".
  slug: string;
  // Audit agent_id, e.g. "antigravity".
  agentId: string;
  // Input key that carries a subagent's own session id on its root's audit rows.
  childSessionKey: string;
  titleSource: string;
  tools: ToolVocabulary;
};

export type ToolVocabulary = {
  // Tools that need no plan; the backend's denied and held lists still apply.
  readOnly: ReadonlySet<string>;
  // A legacy policy rule naming one of these stays a tool rule even when it is
  // also a shell program name (OpenCode's `grep`).
  native: ReadonlySet<string>;
  // The name plan steps and calls are compared by. Both sides pass through it,
  // so ArmorClaude-style names in a plan reach the native tool they mean.
  canonical(name: string): string;
  // Every native tool a policy action selector value reaches, the value itself included.
  policyNames(value: string): readonly string[];
  // The names a native tool answers to in `tool.name` conditions.
  nameReadings(tool: string): readonly string[];
  // Possible MCP server names for a native tool name, [""] when it has none.
  mcpServerCandidates(tool: string): readonly string[];
  // Spellings of a policy's `mcp.server` value as it appears in native names.
  mcpServerNames(server: string): readonly string[];
  // Argument fields that name a filesystem location, per tool, for the
  // ~/.armoriq protection. Content fields must not be listed.
  pathFields: ReadonlyMap<string, readonly string[]>;
  // The root of a recursive search that reads hidden files, or null.
  searchRoot(call: ToolCall): string | null;
  // Paths of a multi-file edit, each judged as its own write; null for other calls.
  multiFileEdit(call: ToolCall): readonly string[] | null;
  // Argument fields read for the policy's bash.*, file.path and network.host conditions.
  args: { command: readonly string[]; path: readonly string[]; url: readonly string[] };
};
