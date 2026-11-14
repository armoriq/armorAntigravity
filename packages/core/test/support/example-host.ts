import type { ToolVocabulary } from "../../src/product.ts";

// A host whose names share nothing with OpenCode's, to prove the core reads
// every name through the vocabulary. Not Antigravity's real mapping.
const CLAUDE_NAMES: ReadonlyMap<string, string> = new Map([
  ["bash", "shell_exec"],
  ["read", "open_file"],
  ["edit", "patch_file"],
  ["write", "patch_file"],
]);

export const EXAMPLE_HOST: ToolVocabulary = {
  readOnly: new Set(["open_file"]),
  native: new Set(["shell_exec", "open_file", "patch_file", "multi_patch"]),
  canonical: (name) => {
    const lower = name.trim().toLowerCase();
    return CLAUDE_NAMES.get(lower) ?? lower;
  },
  policyNames: (value) => {
    const lower = value.trim().toLowerCase();
    const mapped = CLAUDE_NAMES.get(lower);
    const names = mapped ? [lower, mapped] : [lower];
    return names.includes("patch_file") ? [...names, "multi_patch"] : names;
  },
  nameReadings: (tool) => [tool],
  mcpServerCandidates: () => [""],
  mcpServerNames: (server) => [server],
  pathFields: new Map([
    ["open_file", ["Target"]],
    ["patch_file", ["Target"]],
    ["shell_exec", ["Cmd", "Cwd"]],
  ]),
  searchRoot: () => null,
  multiFileEdit: (call) =>
    call.tool === "multi_patch" && Array.isArray(call.args.Targets)
      ? call.args.Targets.filter((t): t is string => typeof t === "string")
      : null,
  args: { command: ["Cmd"], path: ["Target"], url: ["Url"] },
};
