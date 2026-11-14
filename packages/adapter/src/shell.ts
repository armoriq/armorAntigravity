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

// `{` and `}` only delimit a group as standalone words; inside a word they are brace expansion.
const SEPARATOR = /^(&&|\|\||[;|&\n(){}])$/;
// A character a bare word may contain, as the lexer's word alternative spelled it.
const WORD_CHAR = /[^\s"'`\\;&|<>()$]/;
const OPERATOR_CHAR = ";|&\n()";
const GROUP_OPEN_FOLLOW = " \t\n";
const GROUP_CLOSE_FOLLOW = " \t\n;|&)";
// `.` in `\\.` does not match a line terminator, so a `\` before one ends a double-quoted run.
const LINE_TERMINATOR = "\n\r\u2028\u2029";

type Wrapper = { readonly withValue?: ReadonlySet<string>; readonly positional?: number; readonly stdin?: boolean };
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ["sudo", { withValue: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from"]) }],
  ["doas", { withValue: new Set(["-u", "-C"]) }],
  ["env", { withValue: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]) }],
  ["nice", { withValue: new Set(["-n", "--adjustment"]) }],
  ["ionice", { withValue: new Set(["-c", "-n", "-p", "--class", "--classdata"]) }],
  ["exec", { withValue: new Set(["-a"]) }],
  ["timeout", { withValue: new Set(["-s", "-k", "--signal", "--kill-after"]), positional: 1 }],
  ["xargs", { withValue: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]), stdin: true }],
  ["stdbuf", { withValue: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) }],
  ["caffeinate", { withValue: new Set(["-t", "-w"]) }],
  ["flock", { withValue: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]), positional: 1 }],
  ["chrt", { positional: 1 }],
  ["taskset", { positional: 1 }],
  ["setsid", {}],
  ["nohup", {}],
  ["command", {}],
  ["builtin", {}],
  ["time", {}],
  ["unbuffer", {}],
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

// Index of the `'` closing a `$'...'` run, or -1. Mirrors `(?:\\[^]|[^'\\])*'`.
function ansiCEnd(text: string, from: number): number {
  for (let i = from; i < text.length; ) {
    const c = text[i];
    if (c === "\\") {
      if (i + 1 >= text.length) return -1;
      i += 2;
    } else if (c === "'") return i;
    else i++;
  }
  return -1;
}

// Index of the `"` closing a double-quoted run, or -1. Mirrors `(?:\\.|[^"\\])*"`.
function doubleQuoteEnd(text: string, from: number): number {
  for (let i = from; i < text.length; ) {
    const c = text[i];
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || LINE_TERMINATOR.includes(next)) return -1;
      i += 2;
    } else if (c === '"') return i;
    else i++;
  }
  return -1;
}

function unquote(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "$" && raw[i + 1] === "'") {
      const end = ansiCEnd(raw, i + 2);
      if (end >= 0) {
        out += ansiC(raw.slice(i + 2, end));
        i = end + 1;
        continue;
      }
    }
    if (c === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 2;
      continue;
    }
    if (c === '"' || (c === "$" && raw[i + 1] === '"')) {
      const open = c === "$" ? i + 2 : i + 1;
      const end = doubleQuoteEnd(raw, open);
      if (end >= 0) {
        out += raw.slice(open, end).replace(/\\(.)/g, "$1");
        i = end + 1;
        continue;
      }
    }
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end >= 0) {
        out += raw.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const digitsEnd = (text: string, from: number): number => {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  return i;
};

// End of the operator token at `at`, or -1. The alternatives are tried in the
// order the grammar lists them, so a `\d*>&` without an fd falls back to `\d*>`.
function operatorEnd(text: string, at: number): number {
  const c = text[at];
  if (c === undefined) return -1;
  if (c === "&" && text[at + 1] === "&") return at + 2;
  if (c === "|" && text[at + 1] === "|") return at + 2;
  if (c === "&" && text[at + 1] === ">") return text[at + 2] === ">" ? at + 3 : at + 2;
  const d = digitsEnd(text, at);
  const head = text[d];
  if (head === ">" && text[d + 1] === "&") {
    const fd = digitsEnd(text, d + 2);
    if (fd > d + 2) return fd;
    if (text[d + 2] === "-") return d + 3;
  }
  if (head === ">") {
    let end = d + 1;
    if (text[end] === ">") end++;
    if (text[end] === "|") end++;
    return end;
  }
  if (head === "<") {
    if (text[d + 1] === "<") return text[d + 2] === "<" ? d + 3 : text[d + 2] === "-" ? d + 3 : d + 2;
    if (text[d + 1] === "&") {
      const fd = digitsEnd(text, d + 2);
      if (fd > d + 2) return fd;
      if (text[d + 2] === "-") return d + 3;
    }
    return text[d + 1] === ">" ? d + 2 : d + 1;
  }
  if (OPERATOR_CHAR.includes(c)) return at + 1;
  const next = text[at + 1];
  if (c === "{") return next !== undefined && GROUP_OPEN_FOLLOW.includes(next) ? at + 1 : -1;
  if (c === "}") return next === undefined || GROUP_CLOSE_FOLLOW.includes(next) ? at + 1 : -1;
  return -1;
}

// `}` and `)` are searched for from every `$` in a word, and a search that fails
// at one offset fails at every later one, so the first miss is remembered.
type Absent = { brace: number; paren: number };

function closerAt(text: string, from: number, closer: "}" | ")", absent: Absent): number {
  const key = closer === "}" ? "brace" : "paren";
  if (from >= absent[key]) return -1;
  const found = text.indexOf(closer, from);
  if (found < 0) absent[key] = from;
  return found;
}

// End of the bare word starting at `at`; equal to `at` when no word starts there.
function wordEnd(text: string, at: number, absent: Absent): number {
  let i = at;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "$") {
      const next = text[i + 1];
      if (next === "'") {
        const end = ansiCEnd(text, i + 2);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      } else if (next === "{" || next === "(") {
        const end = closerAt(text, i + 2, next === "{" ? "}" : ")", absent);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === "`" || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = doubleQuoteEnd(text, i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= text.length) break;
      i += 2;
      continue;
    }
    if (!WORD_CHAR.test(c)) break;
    i++;
  }
  return i;
}

function trimTrailingBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return end === text.length ? text : text.slice(0, end);
}

// Exported for the parity test that checks this scan against the regex lexer it replaced.
export function lex(command: string): Token[] | null {
  const text = trimTrailingBlanks(command);
  const tokens: Token[] = [];
  const absent: Absent = { brace: text.length + 1, paren: text.length + 1 };
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= text.length) break;
    const op = operatorEnd(text, i);
    if (op >= 0) {
      tokens.push({ kind: "op", op: text.slice(i, op) });
      i = op;
      continue;
    }
    const end = wordEnd(text, i, absent);
    if (end === i) return null;
    tokens.push({ kind: "word", word: unquote(text.slice(i, end)) });
    i = end;
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

export function isShellWithScript(argv: readonly string[]): boolean {
  return shellScript(argv) !== null;
}

export function expandHome(word: string, home: string): string {
  return word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

// `{a,b}` brace expansion: a `{` with a `,` before the first `}` after it. Scanned
// rather than matched, because `\{[^}]*,[^}]*\}` backtracks quadratically on `{{{...`.
export function hasBraceList(text: string): boolean {
  let open = -1;
  let comma = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (open < 0) open = i;
    } else if (c === ",") {
      if (open >= 0) comma = true;
    } else if (c === "}") {
      if (comma) return true;
      open = -1;
      comma = false;
    }
  }
  return false;
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
    // popd returns to a directory this parser no longer knows.
    if (name === "popd") base = null;
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
