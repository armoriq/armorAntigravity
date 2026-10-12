import path from "node:path";
import { expandHome, parseShell, type ShellSegment } from "./shell.ts";
import type { MappedCall } from "./tools.ts";

export type GuardContext = {
  readonly home: string;
  // Absolute paths of the guard's own files and directories (PRD 7.1 E4).
  readonly protectedPaths: readonly string[];
  // Base for relative paths when the call names no directory of its own.
  readonly workspace: string | null;
};

export type GuardViolation = { readonly path: string; readonly reason: string };

// Where the installer puts ArmorAntigravity's hooks, rule, MCP entry and plugin.
export function guardPaths(home: string): string[] {
  const config = path.join(home, ".gemini", "config");
  return [
    path.join(config, "hooks.json"),
    path.join(config, "rules", "armoriq.md"),
    path.join(config, "mcp_config.json"),
    path.join(config, "plugins", "armoriq"),
  ];
}

const EVERY_OPERAND = new Set(["rm", "rmdir", "unlink", "shred", "tee", "truncate", "touch", "chmod", "chown", "chattr"]);
// Commands whose operands are removed or re-permissioned as a whole, so naming
// a parent directory reaches the guard files too.
const DESTRUCTIVE = new Set(["rm", "rmdir", "unlink", "shred", "chmod", "chown", "chattr"]);
const INTO_DESTINATION = new Set(["cp", "install", "ln", "rsync"]);
const WRITE_COMMANDS = new Set([...EVERY_OPERAND, ...INTO_DESTINATION, "mv", "sed", "dd"]);
// Inline code in these can write any file; a mention of a guard file is enough.
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "perl", "ruby", "php", "osascript", "awk", "jq"]);

function operands(args: readonly string[]): { files: string[]; targetDir: string | undefined } {
  const files: string[] = [];
  let targetDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-t" || a === "--target-directory") targetDir = args[++i];
    else if (a.startsWith("--target-directory=")) targetDir = a.slice(19);
    else if (!a.startsWith("-")) files.push(a);
  }
  return { files, targetDir };
}

function destinations(args: readonly string[]): string[] {
  const { files, targetDir } = operands(args);
  const dest = targetDir ?? files[files.length - 1];
  if (!dest) return [];
  const sources = targetDir ? files : files.slice(0, -1);
  return [dest, ...sources.map((s) => path.join(dest, path.basename(s)))];
}

type Targets = { writes: string[]; removes: string[] };

function commandTargets(argv: readonly string[]): Targets {
  const [first, ...args] = argv;
  const command = path.basename(first ?? "");
  if (command === "mv") return { writes: destinations(args), removes: operands(args).files };
  if (DESTRUCTIVE.has(command)) return { writes: [], removes: operands(args).files };
  if (EVERY_OPERAND.has(command)) return { writes: operands(args).files, removes: [] };
  if (INTO_DESTINATION.has(command)) return { writes: destinations(args), removes: [] };
  if (command === "sed" && args.some((a) => /^(-i|--in-place)/.test(a))) {
    // sed's first operand is the script unless -e or -f supplied it.
    const files = operands(args.filter((a) => !/^-[ef]$/.test(a))).files;
    return { writes: args.some((a) => /^-[ef]$/.test(a)) ? files : files.slice(1), removes: [] };
  }
  if (command === "dd") return { writes: args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)), removes: [] };
  return { writes: [], removes: [] };
}

const isUnder = (target: string, root: string) => target === root || target.startsWith(root + path.sep);

function globRegex(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[" || ch === "]") out += ch;
    else out += ch.replace(/[.*+?^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let dir = p; dir !== path.dirname(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}

class Matcher {
  private readonly roots: string[];

  constructor(private readonly ctx: GuardContext) {
    this.roots = ctx.protectedPaths.map((p) => path.resolve(p));
  }

  // The protected root a path word reaches, or null. `removal` also counts a
  // parent directory, since deleting it deletes the guard files.
  hit(word: string, base: string | null, removal: boolean): string | null {
    const expanded = expandHome(word, this.ctx.home);
    const absolute = path.isAbsolute(expanded) ? expanded : base ? path.join(base, expanded) : null;
    if (absolute === null || /[$`]/.test(expanded)) return this.mentioned(word);
    if (/[*?[]/.test(absolute)) {
      const glob = path.normalize(absolute);
      const re = globRegex(glob);
      const literal = glob.slice(0, glob.search(/[*?[]/));
      const literalDir = literal.endsWith(path.sep) ? literal.slice(0, -1) : path.dirname(literal);
      return (
        this.roots.find(
          (root) => re.test(root) || isUnder(literalDir, root) || (removal && ancestors(root).some((a) => re.test(a))),
        ) ?? null
      );
    }
    const target = path.resolve(absolute);
    return this.roots.find((root) => isUnder(target, root) || (removal && isUnder(root, target))) ?? null;
  }

  mentioned(text: string): string | null {
    const name = path.basename(text);
    return this.roots.find((root) => path.basename(root) === name) ?? null;
  }

  textMentions(text: string): string | null {
    const home = this.ctx.home;
    return (
      this.roots.find((root) => {
        const tilde = root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
        return text.includes(root) || text.includes(tilde) || text.includes(path.basename(root));
      }) ?? null
    );
  }
}

function segmentHit(seg: ShellSegment, m: Matcher, allWords: readonly string[]): string | null {
  const name = path.basename(seg.argv[0] ?? "");
  if (seg.stdin && WRITE_COMMANDS.has(name)) {
    for (const w of allWords) {
      const hit = m.textMentions(w);
      if (hit) return hit;
    }
  }
  if (INTERPRETERS.has(name)) {
    for (const w of seg.argv.slice(1)) {
      const hit = m.textMentions(w);
      if (hit) return hit;
    }
  }
  const { writes, removes } = commandTargets(seg.argv);
  for (const w of [...seg.redirects, ...writes]) {
    const hit = m.hit(w, seg.cwd, false);
    if (hit) return hit;
  }
  for (const w of removes) {
    const hit = m.hit(w, seg.cwd, true);
    if (hit) return hit;
  }
  return null;
}

// The protected path a shell line would write, move, delete or re-permission.
export function shellWritesGuard(command: string, cwd: string | null, ctx: GuardContext): string | null {
  const m = new Matcher(ctx);
  const parsed = parseShell(command, { cwd, home: ctx.home });
  if (!parsed.ok) {
    for (const w of command.split(/[\s"'=<>;|&()]+/)) {
      const hit = m.textMentions(w);
      if (hit) return hit;
    }
    return null;
  }
  const allWords = parsed.segments.flatMap((s) => [...s.argv, ...s.redirects]);
  for (const seg of parsed.segments) {
    const hit = segmentHit(seg, m, allWords);
    if (hit) return hit;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Built-in rule run before policy: no tool may modify the guard's own files.
// Reading them is allowed. ~/.armoriq read and write is the core's built-in.
export function checkGuard(call: MappedCall, ctx: GuardContext): GuardViolation | null {
  const m = new Matcher(ctx);
  const deny = (p: string): GuardViolation => ({
    path: p,
    reason: `${call.name} may not modify ArmorIQ's guard files (${p}); they keep ArmorIQ enforcing in Antigravity`,
  });

  switch (call.category) {
    case "shell": {
      const command = str(call.args.command);
      if (command === null) return null;
      const hit = shellWritesGuard(command, str(call.args.workdir) ?? ctx.workspace, ctx);
      return hit ? deny(hit) : null;
    }
    case "write": {
      const file = str(call.args.filePath);
      const hit = file === null ? null : m.hit(file, ctx.workspace, false);
      return hit ? deny(hit) : null;
    }
    case "read":
    case "web":
    case "subagent":
    case "browser":
      return null;
    case "mcp":
    case "unknown": {
      // Read or write cannot be told apart here, so any argument that is itself
      // a guard path is refused. Text that merely mentions one is not.
      for (const value of Object.values(call.args)) {
        const p = str(value);
        if (p === null || !/^(~|\$HOME|\/)/.test(p)) continue;
        const hit = m.hit(p, null, false);
        if (hit) return deny(hit);
      }
      return null;
    }
  }
}
