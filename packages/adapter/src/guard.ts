import { existsSync, realpathSync } from "node:fs";
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

// Operands written or created in place.
const WRITES_OPERANDS = new Set(["tee", "truncate", "touch", "sponge", "ex", "vi", "vim", "nvim", "nano", "emacs", "ed"]);
// Operands removed or re-permissioned as a whole, so a parent directory counts.
const REMOVES_OPERANDS = new Set(["rm", "rmdir", "unlink", "shred", "chmod", "chown", "chattr", "chflags"]);
const INTO_DESTINATION = new Set(["cp", "install", "ln", "rsync"]);
const STDIN_WRITERS = new Set([...WRITES_OPERANDS, ...REMOVES_OPERANDS, ...INTO_DESTINATION, "mv", "sed", "dd"]);
// Inline code or a script on stdin can write any file.
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "perl", "ruby", "php", "osascript", "awk", "jq", "sh", "bash", "zsh", "dash", "ksh", "fish"]);
const GIT_WORKTREE = new Set(["checkout", "restore", "reset", "clean", "stash", "apply", "am", "pull", "merge", "rebase", "switch", "cherry-pick", "revert"]);

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

// Value of `-x VALUE`, `-xVALUE`, `--long VALUE` or `--long=VALUE`.
function flagValues(args: readonly string[], short: readonly string[], long: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const eq = long.find((l) => a.startsWith(`${l}=`));
    if (eq) out.push(a.slice(eq.length + 1));
    else if (short.includes(a) || long.includes(a)) {
      const v = args[i + 1];
      if (v !== undefined) out.push(v);
      i++;
    } else {
      const glued = short.find((s) => a.startsWith(s) && a.length > s.length && !a.startsWith("--"));
      if (glued) out.push(a.slice(glued.length));
    }
  }
  return out;
}

type Targets = { writes: string[]; removes: string[] };
const none: Targets = { writes: [], removes: [] };
const recursive = (args: readonly string[]) => args.some((a) => /^-[A-Za-z]*[rRa]/.test(a) || a === "--recursive" || a === "--archive");

function commandTargets(argv: readonly string[], cwd: string | null): Targets {
  const [first, ...args] = argv;
  const command = path.basename(first ?? "");
  const here = cwd === null ? [] : [cwd];
  switch (command) {
    case "mv":
      return { writes: destinations(args), removes: operands(args).files };
    case "sed": {
      if (!args.some((a) => /^(-i|--in-place)/.test(a))) return none;
      // sed's first operand is the script unless -e or -f supplied it.
      const scripted = args.some((a) => /^-[ef]$/.test(a));
      const files = operands(args.filter((a) => !/^-[ef]$/.test(a))).files;
      return { writes: scripted ? files : files.slice(1), removes: [] };
    }
    case "dd":
      return { writes: args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)), removes: [] };
    case "find": {
      const destructive = args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a));
      const end = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
      const roots = (end === -1 ? args : args.slice(0, end)).filter((a) => !a.startsWith("-"));
      return destructive ? { writes: [], removes: roots.length ? roots : here } : none;
    }
    case "curl":
      return { writes: flagValues(args, ["-o"], ["--output"]), removes: flagValues(args, [], ["--output-dir"]) };
    case "wget":
      return { writes: flagValues(args, ["-O", "-o", "-a"], ["--output-document", "--output-file", "--append-output"]), removes: flagValues(args, ["-P"], ["--directory-prefix"]) };
    case "tar": {
      // The mode is a bare first word (`xzf`) or a short flag cluster (`-xzf`).
      const modes = args.filter((a, i) => /^-[A-Za-z]+$/.test(a) || (i === 0 && /^[A-Za-z]+$/.test(a)));
      const extracting = args.some((a) => a === "--extract" || a === "--get") || modes.some((a) => a.includes("x"));
      const creating = args.includes("--create") || modes.some((a) => a.includes("c"));
      const dirs = flagValues(args, ["-C"], ["--directory"]);
      return { writes: creating ? flagValues(args, ["-f"], ["--file"]) : [], removes: extracting ? (dirs.length ? dirs : here) : [] };
    }
    case "unzip": {
      const dirs = flagValues(args, ["-d"], []);
      return { writes: [], removes: dirs.length ? dirs : here };
    }
    case "patch": {
      const dirs = flagValues(args, ["-d"], ["--directory"]);
      return { writes: [...operands(args).files.slice(0, 1), ...flagValues(args, ["-o"], ["--output"])], removes: dirs.length ? dirs : here };
    }
    case "git": {
      const dirs = flagValues(args, ["-C"], []);
      const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-C");
      return sub !== undefined && GIT_WORKTREE.has(sub) ? { writes: [], removes: dirs.length ? dirs : here } : none;
    }
    case "ln": {
      // A link to a guard file is a second way to write it.
      const symbolic = args.some((a) => /^-[A-Za-z]*s/.test(a) || a === "--symbolic");
      const { files, targetDir } = operands(args);
      const sources = targetDir ? files : files.slice(0, -1);
      return { writes: destinations(args), removes: symbolic ? sources : [] };
    }
  }
  if (REMOVES_OPERANDS.has(command)) return { writes: [], removes: operands(args).files };
  if (WRITES_OPERANDS.has(command)) return { writes: operands(args).files, removes: [] };
  if (INTO_DESTINATION.has(command)) {
    // A recursive copy into a parent directory can replace the guard files inside it.
    const dest = destinations(args);
    return command === "rsync" || recursive(args) ? { writes: [], removes: dest.slice(0, 1) } : { writes: dest, removes: [] };
  }
  return none;
}

const isUnder = (target: string, root: string) => target === root || target.startsWith(root + "/");

function globRegex(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[" || ch === "]") out += ch;
    else out += ch.replace(/[.*+?^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let dir = p; dir !== path.dirname(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}

// Follows symlinks in the part of the path that exists, so a link created
// earlier cannot point a write at a guard file.
function realish(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && head !== path.dirname(head)) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  try {
    return path.join(realpathSync(head), ...tail);
  } catch {
    return path.resolve(p);
  }
}

// macOS volumes are case-insensitive by default, so comparison is too.
const fold = (p: string) => realish(p).toLowerCase();

class Matcher {
  private readonly roots: { shown: string; key: string }[];
  // Each root and each directory above it below home (".gemini", ".gemini/config"),
  // as text a command may contain, longest first.
  private readonly mentionable: { text: string; shown: string }[];

  constructor(private readonly ctx: GuardContext) {
    const home = path.resolve(ctx.home);
    this.roots = ctx.protectedPaths.map((p) => ({ shown: path.resolve(p), key: fold(p) }));
    const seen = new Map<string, string>();
    for (const { shown } of this.roots) {
      const rel = shown.startsWith(home + path.sep) ? shown.slice(home.length + 1) : shown;
      const parts = rel.split(path.sep);
      parts.forEach((_, i) => {
        const text = parts.slice(0, i + 1).join("/").toLowerCase();
        if (text.length > 1 && !seen.has(text)) seen.set(text, rel === shown ? `/${text}` : path.join(home, ...parts.slice(0, i + 1)));
      });
    }
    this.mentionable = [...seen].map(([text, shown]) => ({ text, shown })).sort((a, b) => b.text.length - a.text.length);
  }

  // The protected root a path word reaches, or null. `removal` also counts a
  // parent directory, since deleting or replacing it reaches the guard files.
  hit(word: string, base: string | null, removal: boolean): string | null {
    const expanded = expandHome(word.replace(/^file:\/\//, ""), this.ctx.home);
    const absolute = path.isAbsolute(expanded) ? expanded : base ? path.join(base, expanded) : null;
    if (absolute === null || /[$`]/.test(expanded)) return this.mentions(word);
    if (/[*?[]/.test(absolute)) {
      const glob = path.normalize(absolute);
      const slash = glob.lastIndexOf("/", glob.search(/[*?[]/));
      const dir = fold(glob.slice(0, slash) || "/");
      const re = globRegex(path.join(dir, glob.slice(slash + 1)));
      const r = this.roots.find((root) => re.test(root.key) || isUnder(dir, root.key) || (removal && ancestors(root.key).some((a) => re.test(a))));
      return r?.shown ?? null;
    }
    const target = fold(absolute);
    return this.roots.find((root) => isUnder(target, root.key) || (removal && isUnder(root.key, target)))?.shown ?? null;
  }

  // A guard path, or a directory above it under home, written out in free text.
  mentions(text: string): string | null {
    const lower = text.toLowerCase();
    for (const { text: m, shown } of this.mentionable) {
      for (let i = lower.indexOf(m); i >= 0; i = lower.indexOf(m, i + 1)) {
        const before = i === 0 ? "" : (lower[i - 1] ?? "");
        const after = lower[i + m.length] ?? "";
        if ((before === "" || /[/~'"\s=:]/.test(before)) && !/[a-z0-9_.-]/.test(after)) return shown;
      }
    }
    return null;
  }
}

function segmentHit(seg: ShellSegment, m: Matcher, command: string, allWords: readonly string[]): string | null {
  const name = path.basename(seg.argv[0] ?? "");
  if (seg.stdin && STDIN_WRITERS.has(name)) {
    for (const w of allWords) {
      const hit = m.mentions(w) ?? m.hit(w, seg.cwd, true);
      if (hit) return hit;
    }
  }
  if (INTERPRETERS.has(name)) {
    // Inline code, or a script piped or redirected in: the whole line is the program text.
    const hit = seg.input ? m.mentions(command) : seg.argv.slice(1).map((w) => m.mentions(w)).find((h) => h !== null);
    if (hit) return hit;
  }
  const { writes, removes } = commandTargets(seg.argv, seg.cwd);
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
  if (!parsed.ok) return m.mentions(command);
  const allWords = parsed.segments.flatMap((s) => [...s.raw, ...s.redirects]);
  for (const seg of parsed.segments) {
    const hit = segmentHit(seg, m, command, allWords);
    if (hit) return hit;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const PATCH_PATH = /^\*\*\* (?:Add File|Delete File|Update File|Move to):(.*)$/gm;
const MUTATING = /(delete|remove|move|rename|rm|write|edit|create|copy|mv|put|upload|sync|extract|unzip|patch|chmod|truncate|save|replace)/i;

// Path-shaped strings anywhere in a tool's arguments, nested objects included.
function argPaths(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 200 || depth > 6) return out;
  if (typeof value === "string") {
    if (/^(~|\$HOME|\$\{HOME\}|\/|file:\/\/)/.test(value)) out.push(decodeURIComponentSafe(value));
  } else if (Array.isArray(value)) {
    for (const v of value) argPaths(v, out, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) argPaths(v, out, depth + 1);
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return s.startsWith("file://") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
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
      const files = [str(call.args.filePath)].filter((f): f is string => f !== null);
      const patch = str(call.args.patchText);
      if (patch) for (const match of patch.matchAll(PATCH_PATH)) files.push((match[1] ?? "").trim());
      const hit = files.map((f) => m.hit(f, ctx.workspace, false)).find((h) => h !== null);
      return hit ? deny(hit) : null;
    }
    case "read":
    case "web":
    case "subagent":
    case "browser":
      return null;
    case "mcp":
    case "unknown": {
      // Read and write cannot be told apart here. A path argument at or under
      // a guard path is refused; one above it only when the tool's name says
      // it changes files. Text that merely mentions a path is not checked.
      const removal = MUTATING.test(call.category === "mcp" ? call.mcp.tool : call.name);
      for (const p of argPaths(call.args)) {
        const hit = m.hit(p, null, removal);
        if (hit) return deny(hit);
      }
      return null;
    }
  }
}
