import path from "node:path";

// Ported from armorClaude origin/dev scripts/lib/shell-guard.mjs, then
// extended to look inside `sh -c`, `eval`, `$(...)` and backticks, to see past
// shell keywords, to decode `$'...'` and to expand variables set on the line.

type Token = { readonly kind: "op"; readonly op: string } | { readonly kind: "word"; readonly word: string };

export type ShellSegment = {
  // After keywords (if, then, !...), wrappers (sudo, env, xargs, timeout...)
  // and leading VAR=value are removed.
  readonly argv: readonly string[];
  // As written, wrappers included, so policy can judge `sudo` itself.
  readonly raw: readonly string[];
  // Targets of output redirections (`>`, `>>`, `&>`, `>|`).
  readonly redirects: readonly string[];
  // True when a wrapper such as xargs feeds it arguments from stdin.
  readonly stdin: boolean;
  // True when its stdin is a pipe, a file or a heredoc: an interpreter here runs that as code.
  readonly input: boolean;
  // Directory the segment runs in, tracked through `cd`; null when unknown.
  readonly cwd: string | null;
};

export type ShellParse = { readonly ok: true; readonly segments: readonly ShellSegment[] } | { readonly ok: false };

const SEPARATOR = /^(&&|\|\||[;|&\n(){}])$/;
const TOKEN =
  /[ \t]*(?:(&&|\|\||&>>?|\d*>&(?:\d+|-)|\d*>>?\|?|\d*<<<|\d*<<-?|\d*<&(?:\d+|-)|\d*<>?|[;|&\n(){}])|((?:\$'(?:\\[^]|[^'\\])*'|\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|"(?:\\.|[^"\\])*"|'[^']*'|\\[^]|[^\s"'`\\;&|<>(){}$]|\$)+))/y;

type Wrapper = { readonly withValue?: ReadonlySet<string>; readonly positional?: number; readonly stdin?: boolean };
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ["sudo", { withValue: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]) }],
  ["doas", { withValue: new Set(["-u", "-C"]) }],
  ["env", { withValue: new Set(["-u", "-C", "-S"]) }],
  ["nice", { withValue: new Set(["-n"]) }],
  ["exec", { withValue: new Set(["-a"]) }],
  ["timeout", { withValue: new Set(["-s", "-k"]), positional: 1 }],
  ["xargs", { withValue: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]), stdin: true }],
  ["nohup", {}],
  ["command", {}],
  ["builtin", {}],
  ["time", {}],
  ["stdbuf", {}],
]);

// Reserved words that can sit in front of a command without being it.
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "while", "until", "do", "coproc"]);
const DECLARE = new Set(["export", "declare", "typeset", "local", "readonly"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const MAX_DEPTH = 8;

const ANSI_C: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

// bash's $'...' escapes: \xHH, \uHHHH, \UHHHHHHHH, octal, and the letters above.
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[^])/g, (_m, esc: string) => {
    const head = esc[0] ?? "";
    if (head === "x" || head === "u" || head === "U") return String.fromCodePoint(parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return ANSI_C[esc] ?? esc;
  });
}

function unquote(raw: string): string {
  return raw.replace(
    /\$'((?:\\[^]|[^'\\])*)'|\\([^])|"((?:\\.|[^"\\])*)"|'([^']*)'/g,
    (_m, ansi?: string, escaped?: string, dq?: string, sq?: string) => (ansi !== undefined ? ansiC(ansi) : (escaped ?? dq?.replace(/\\(.)/g, "$1") ?? sq ?? "")),
  );
}

function lex(command: string): Token[] | null {
  const text = command.replace(/[ \t]+$/, "");
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const m = TOKEN.exec(text);
    if (!m) return null;
    if (m[1] !== undefined) tokens.push({ kind: "op", op: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "word", word: unquote(m[2]) });
    else return null;
  }
  return tokens;
}

type Simple = { argv: string[]; redirects: string[]; input: boolean };

function simpleCommands(tokens: readonly Token[]): Simple[] {
  const commands: Simple[] = [{ argv: [], redirects: [], input: false }];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const current = commands[commands.length - 1];
    if (!token || !current) continue;
    if (token.kind === "word") current.argv.push(token.word);
    else if (SEPARATOR.test(token.op)) commands.push({ argv: [], redirects: [], input: token.op === "|" });
    else {
      if (/^\d*<(?!&)/.test(token.op)) current.input = true;
      const next = tokens[i + 1];
      if (!/&(\d|-)/.test(token.op) && next?.kind === "word") {
        i++;
        if (token.op.includes(">")) current.redirects.push(next.word);
      }
    }
  }
  return commands.filter((c) => c.argv.length > 0 || c.redirects.length > 0);
}

// `$NAME` and `${NAME}` for names assigned earlier on the line; others stay as written.
function expandVars(word: string, vars: ReadonlyMap<string, string>): string {
  if (!word.includes("$") || vars.size === 0) return word;
  return word.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, braced?: string, bare?: string) => vars.get(braced ?? bare ?? "") ?? m);
}

// A command that only assigns (`F=x`, `export F=x`) sets variables for later commands.
function assignments(argv: readonly string[]): [string, string][] | null {
  const words = DECLARE.has(argv[0] ?? "") ? argv.slice(1).filter((a) => !a.startsWith("-")) : argv;
  const out: [string, string][] = [];
  for (const w of words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
    if (!m?.[1]) return null;
    out.push([m[1], m[2] ?? ""]);
  }
  return out.length > 0 ? out : null;
}

function unwrap(argv: readonly string[]): { argv: string[]; stdin: boolean } {
  let i = 0;
  let stdin = false;
  for (;;) {
    while (/^\w+=/.test(argv[i] ?? "") || KEYWORDS.has(argv[i] ?? "")) i++;
    const spec = WRAPPERS.get(path.basename(argv[i] ?? ""));
    if (!spec) return { argv: argv.slice(i), stdin };
    stdin ||= spec.stdin === true;
    i++;
    for (let a = argv[i]; a?.startsWith("-"); a = argv[i]) i += spec.withValue?.has(a) ? 2 : 1;
    i += spec.positional ?? 0;
  }
}

// Bodies of `$(...)` and backticks inside one word, balanced for nesting.
function substitutions(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "`") {
      const end = word.indexOf("`", i + 1);
      if (end === -1) break;
      out.push(word.slice(i + 1, end));
      i = end;
    } else if (word[i] === "$" && word[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < word.length; j++) {
        if (word[j] === "(") depth++;
        else if (word[j] === ")" && --depth === 0) break;
      }
      if (j >= word.length) break;
      out.push(word.slice(i + 2, j));
      i = j;
    }
  }
  return out;
}

// `bash -c script`, `bash -lc script`, `sh -ec script`: the first operand after a
// flag cluster containing `c`.
function shellScript(argv: readonly string[]): string | null {
  if (!SHELLS.has(path.basename(argv[0] ?? ""))) return null;
  let sawC = false;
  for (const arg of argv.slice(1)) {
    if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes("c")) sawC = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return sawC ? arg : null;
  }
  return null;
}

export function expandHome(word: string, home: string): string {
  return word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

function resolveDir(word: string, base: string | null, home: string): string | null {
  const expanded = expandHome(word, home);
  if (/[$*?`[]/.test(expanded)) return null;
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return base ? path.resolve(base, expanded) : null;
}

function changeDir(args: readonly string[], base: string | null, home: string): string | null {
  const dir = args.find((a) => !/^-[LPe@]+$/.test(a));
  if (dir === undefined) return home;
  return /^[-+]/.test(dir) ? null : resolveDir(dir, base, home);
}

function parseAt(command: string, cwd: string | null, home: string, vars: Map<string, string>, depth: number): ShellParse {
  if (depth > MAX_DEPTH) return { ok: false };
  const tokens = lex(command);
  if (!tokens) return { ok: false };
  const segments: ShellSegment[] = [];
  let base = cwd;
  for (const simple of simpleCommands(tokens)) {
    const raw = simple.argv.map((w) => expandVars(w, vars));
    const redirects = simple.redirects.map((w) => expandVars(w, vars));
    const assigned = assignments(raw);
    if (assigned) for (const [k, v] of assigned) vars.set(k, v);
    const { argv, stdin } = unwrap(raw);
    const name = path.basename(argv[0] ?? "");
    if (name === "cd" || name === "pushd") base = changeDir(argv.slice(1), base, home);
    segments.push({ argv, raw, redirects, stdin, input: simple.input, cwd: base });

    const nested: string[] = [];
    const script = shellScript(argv);
    if (script !== null) nested.push(script);
    if (name === "eval" && argv.length > 1) nested.push(argv.slice(1).join(" "));
    for (const word of [...raw, ...redirects]) nested.push(...substitutions(word));
    for (const inner of nested) {
      const parsed = parseAt(inner, base, home, vars, depth + 1);
      if (!parsed.ok) return parsed;
      segments.push(...parsed.segments);
    }
  }
  return { ok: true, segments };
}

// Every simple command a shell line would run, including ones nested in
// `bash -c`, `eval`, `$(...)` and backticks. `ok:false` when the line cannot be
// tokenised; callers must then fall back to a conservative text check.
export function parseShell(command: string, options: { cwd: string | null; home: string }): ShellParse {
  return parseAt(command, options.cwd, options.home, new Map(), 0);
}

function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// One segment as a standalone command line, for policy rules that read
// `bash.program`, `bash.raw` or `bash.hasWriteRedirection`.
export function segmentText(segment: ShellSegment): string {
  return [...segment.argv.map(quoteWord), ...segment.redirects.map((r) => `> ${quoteWord(r)}`)].join(" ");
}
