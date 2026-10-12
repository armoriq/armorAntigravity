import type { ToolVocabulary } from "./product.ts";
import type { Decision, ToolCall } from "./types.ts";

export type BuiltinContext = {
  armoriqDir: string;
  ownTools: ReadonlySet<string>;
  shadowedTools: ReadonlySet<string>;
};

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

// A search that reads hidden files, rooted at an ancestor of the directory,
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
export function checkBuiltin(call: ToolCall, ctx: BuiltinContext, tools: ToolVocabulary): Decision | null {
  if (ctx.shadowedTools.has(call.tool)) {
    return {
      kind: "deny",
      code: "own_tool_shadowed",
      reason: `an MCP tool named ${call.tool} shadows an ArmorIQ tool; every call to this name is blocked`,
      ruleId: "builtin:own_tool_shadowed",
    };
  }

  let values: readonly string[];
  const fields = tools.pathFields.get(call.tool);
  const editPaths = fields ? null : tools.multiFileEdit(call);
  if (fields) {
    const named: string[] = [];
    for (const field of fields) {
      const v = call.args[field];
      if (typeof v === "string") named.push(v);
    }
    values = named;
  } else if (editPaths) {
    values = editPaths;
  } else return null;

  const dir = trimTrailingSlashes(ctx.armoriqDir).toLowerCase();
  if (values.some((v) => touchesDir(v, dir))) return protectedDeny(call, ctx);

  const searchRoot = tools.searchRoot(call);
  if (searchRoot !== null) {
    const home = dir.endsWith(`/${SEGMENT}`) ? dir.slice(0, -SEGMENT.length - 1) : null;
    if (isAncestorOf(searchRoot, dir, home)) {
      return {
        kind: "deny",
        code: "builtin_protected",
        reason: `${call.tool} under ${searchRoot} would search the ArmorIQ directory (${ctx.armoriqDir}); search a narrower path`,
        ruleId: "builtin:armoriq_dir",
      };
    }
  }
  return null;
}
