import type { Decision, ToolCall } from "../types.ts";
import { patchPaths } from "./tools.ts";

export type BuiltinContext = {
  armoriqDir: string;
  ownTools: ReadonlySet<string>;
  shadowedTools: ReadonlySet<string>;
};

// Argument fields that name a filesystem location, per OpenCode tool. Content
// fields (write.content, edit.newString, grep.pattern) are deliberately not
// read: writing text that mentions ~/.armoriq is not access to it.
const PATH_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["read", ["filePath"]],
  ["write", ["filePath"]],
  ["edit", ["filePath"]],
  ["list", ["path"]],
  ["grep", ["path", "include"]],
  ["glob", ["pattern", "path"]],
  ["bash", ["command", "workdir"]],
]);

// Characters that can end one path or shell word and start the next.
const BOUNDARY = new Set([..."/\\ \t\n\r\"'`=;:,|&()<>{}$"]);
const GLOB_CHARS = new Set([..."*?["]);
const SEGMENT = ".armoriq";

// True when `.armoriq` appears as a whole path segment or as a glob prefix of
// one (`.armoriq*`), in any case.
function namesArmoriqSegment(lower: string): boolean {
  for (let i = lower.indexOf(SEGMENT); i >= 0; i = lower.indexOf(SEGMENT, i + 1)) {
    const before = i === 0 ? "/" : lower[i - 1]!;
    const after = lower[i + SEGMENT.length];
    if (BOUNDARY.has(before) && (after === undefined || BOUNDARY.has(after) || GLOB_CHARS.has(after))) return true;
  }
  return false;
}

function touchesDir(value: string, dir: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes(dir) || namesArmoriqSegment(lower);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

// ripgrep runs with --hidden, so grep rooted at an ancestor of the directory
// reads its files. Only absolute and home-relative roots can be resolved here.
function isAncestorOf(root: string, dir: string, home: string | null): boolean {
  let p = trimTrailingSlashes(root.trim().toLowerCase());
  if (home !== null) p = p.replace(/^(?:~|\$home|\$\{home\})(?=\/|$)/, home);
  if (p === "") return root.trim().startsWith("/");
  return p.startsWith("/") && dir.startsWith(`${p}/`);
}

function protectedDeny(call: ToolCall, ctx: BuiltinContext): Decision {
  return {
    kind: "deny",
    code: "builtin_protected",
    reason: `${call.tool} may not access the ArmorIQ directory (${ctx.armoriqDir}); it holds credentials and guard state`,
    ruleId: "builtin:armoriq_dir",
  };
}

// Rules config cannot override: protect ~/.armoriq, refuse shadowed own-tool names.
export function checkBuiltin(call: ToolCall, ctx: BuiltinContext): Decision | null {
  if (ctx.shadowedTools.has(call.tool)) {
    return {
      kind: "deny",
      code: "own_tool_shadowed",
      reason: `an MCP tool named ${call.tool} shadows an ArmorIQ tool; every call to this name is blocked`,
      ruleId: "builtin:own_tool_shadowed",
    };
  }

  let values: string[];
  const fields = PATH_FIELDS.get(call.tool);
  if (fields) {
    values = [];
    for (const field of fields) {
      const v = call.args[field];
      if (typeof v === "string") values.push(v);
    }
  } else if (call.tool === "apply_patch" && typeof call.args.patchText === "string") {
    values = patchPaths(call.args.patchText);
  } else return null;

  const dir = trimTrailingSlashes(ctx.armoriqDir).toLowerCase();
  if (values.some((v) => touchesDir(v, dir))) return protectedDeny(call, ctx);

  if (call.tool === "grep" && typeof call.args.path === "string") {
    const home = dir.endsWith(`/${SEGMENT}`) ? dir.slice(0, -SEGMENT.length - 1) : null;
    if (isAncestorOf(call.args.path, dir, home)) {
      return {
        kind: "deny",
        code: "builtin_protected",
        reason: `grep under ${call.args.path} would search the ArmorIQ directory (${ctx.armoriqDir}); search a narrower path`,
        ruleId: "builtin:armoriq_dir",
      };
    }
  }
  return null;
}
