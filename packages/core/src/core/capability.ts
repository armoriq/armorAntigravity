import { OPENCODE_TOOLS } from "./tools.ts";

export type Capability = "read" | "write" | "shell" | "mcp" | "web" | "other";

// The tools-core capability table, in OpenCode's tool names.
const BY_TOOL: ReadonlyMap<string, Capability> = new Map([
  ["read", "read"],
  ["glob", "read"],
  ["grep", "read"],
  ["list", "read"],
  // The plugin's own policy_read only reads the local policy, so it stays usable during an outage.
  ["policy_read", "read"],
  ["write", "write"],
  ["edit", "write"],
  ["apply_patch", "write"],
  ["bash", "shell"],
  ["webfetch", "web"],
  ["websearch", "web"],
]);

// OpenCode passes MCP tools to plugins as <server>_<tool> with nothing else marking them, so any
// non-built-in name of that shape counts as MCP. The plugin's own tools are passed in as `other`.
export function capabilityOf(tool: string, ownTools: ReadonlySet<string> = new Set()): Capability {
  const known = BY_TOOL.get(tool);
  if (known) return known;
  if (OPENCODE_TOOLS.has(tool) || ownTools.has(tool)) return "other";
  return tool.includes("_") ? "mcp" : "other";
}
