import { describe, expect, test } from "bun:test";
import { checkBuiltin, type BuiltinContext } from "../../src/core/builtin-rules.ts";
import type { SessionID } from "../../src/types.ts";

const ctx: BuiltinContext = {
  armoriqDir: "/Users/dev/.armoriq",
  ownTools: new Set(["register_intent_plan"]),
  shadowedTools: new Set(["policy_read"]),
};

function check(tool: string, args: Record<string, unknown>) {
  return checkBuiltin({ sessionId: "s" as SessionID, callId: "c", tool, args }, ctx);
}

const PROTECTED = {
  kind: "deny",
  code: "builtin_protected",
  ruleId: "builtin:armoriq_dir",
};

describe("checkBuiltin", () => {
  test("tool names that collide with Object.prototype members do not throw", () => {
    for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(check(tool, {})).toBeNull();
  });

  test("denies file tools that name the ArmorIQ directory in any spelling", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["read", { filePath: "/Users/dev/.armoriq/credentials.json" }],
      ["read", { filePath: "/USERS/DEV/.ARMORIQ/credentials.json" }],
      ["write", { filePath: "/Users/dev/.armoriq/armoropencode/policy.json", content: "{}" }],
      ["edit", { filePath: "/Users/dev/project/../.armoriq/x", oldString: "a", newString: "b" }],
      ["list", { path: "/Users/dev/.armoriq" }],
      ["list", { path: ".armoriq" }],
      ["glob", { pattern: "~/.armoriq/**" }],
      ["grep", { pattern: "key", path: "$HOME/.armoriq" }],
      ["grep", { pattern: "key", path: "/Users/dev", include: ".armoriq/*" }],
      ["bash", { command: "cat ~/.armoriq/credentials.json" }],
      ["bash", { command: "rm -rf ${HOME}/.armoriq" }],
      ["bash", { command: "ls", workdir: "/Users/dev/.armoriq" }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: /Users/dev/.armoriq/policy.json\n@@\n-a\n+b\n*** End Patch" }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Add File:/Users/dev/.armoriq/policy.json\n+{}\n*** End Patch" }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: notes.md\n*** Move to:\t../.armoriq/credentials.json\n*** End Patch" }],
      ["grep", { pattern: ".", path: "../.armoriq" }],
      ["grep", { pattern: ".", path: "/Users/dev/proj/../.armoriq" }],
      ["list", { path: "../.armoriq" }],
      ["list", { path: "/Users/dev//.armoriq" }],
      ["glob", { pattern: "*", path: "./.armoriq" }],
      ["glob", { pattern: "~/.armoriq*" }],
      ["bash", { command: "cat credentials.json", workdir: "../.armoriq" }],
      ["bash", { command: "tar cz .armoriq" }],
      ["bash", { command: "cp x \"$HOME\"/.armoriq;" }],
      ["grep", { pattern: "apiKey", path: "/Users/dev" }],
      ["grep", { pattern: "apiKey", path: "/Users/dev/" }],
      ["grep", { pattern: "apiKey", path: "~" }],
      ["grep", { pattern: "apiKey", path: "/" }],
    ];
    for (const [tool, args] of cases) expect({ tool, args, d: check(tool, args) }).toMatchObject({ d: PROTECTED });
  });

  test("allows content that merely mentions the directory, and unrelated paths", () => {
    expect(check("write", { filePath: "/Users/dev/notes.md", content: "config lives in ~/.armoriq/" })).toBeNull();
    expect(check("grep", { pattern: "~/.armoriq/", path: "/Users/dev/project" })).toBeNull();
    expect(check("read", { filePath: "/Users/dev/project/src/armoriq.ts" })).toBeNull();
    expect(check("bash", { command: "bun test" })).toBeNull();
    expect(check("apply_patch", { patchText: "*** Begin Patch\n*** Add File: docs/a.md\n+see ~/.armoriq/ for config\n*** End Patch" })).toBeNull();
    expect(check("webfetch", { url: "https://x/.armoriq/" })).toBeNull();
    expect(check("read", { filePath: "/Users/dev/project/.armoriqrc-docs.md" })).toBeNull();
    expect(check("grep", { pattern: "apiKey", path: "/Users/dev/project" })).toBeNull();
    expect(check("grep", { pattern: "apiKey", path: "src" })).toBeNull();
    expect(check("glob", { pattern: "**/*.ts", path: "/Users/dev" })).toBeNull();
  });

  test("denies every call to a tool name that shadows one of the plugin's tools", () => {
    expect(check("policy_read", {})).toEqual({
      kind: "deny",
      code: "own_tool_shadowed",
      reason: "an MCP tool named policy_read shadows an ArmorIQ tool; every call to this name is blocked",
      ruleId: "builtin:own_tool_shadowed",
    });
    expect(check("register_intent_plan", { goal: "x" })).toBeNull();
  });
});
