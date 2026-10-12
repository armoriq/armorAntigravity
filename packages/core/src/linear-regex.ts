// Policy patterns run on the agent's only JS thread, and the native engine
// backtracks: /.*foo/ is quadratic and /(a+)+$/ exponential. This compiles
// to an NFA and matches with a lazily built DFA, so test() is linear in the
// input for every pattern it accepts. Constructs that need backtracking (backreferences,
// lookaround) are compile errors. Semantics follow `new RegExp(source).test()`
// with no flags.

type Range = readonly [number, number];
type CharSet = { ranges: readonly Range[]; negated: boolean };
type AssertKind = "start" | "end" | "word" | "nonword";

type Node =
  | { t: "set"; set: CharSet }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "repeat"; node: Node; min: number; max: number }
  | { t: "assert"; kind: AssertKind };

type Inst =
  | { op: "set"; set: CharSet }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "assert"; kind: AssertKind }
  | { op: "match" };

export type LinearRegex = { readonly source: string; test(input: string): boolean };
export type RegexCompileResult = { ok: true; regex: LinearRegex } | { ok: false; error: string };

const MAX_PROGRAM = 2000;
const MAX_EMIT_STEPS = 20_000;
const MAX_REPEAT = 1000;

const DIGIT: Range[] = [[48, 57]];
const WORD: Range[] = [[48, 57], [65, 90], [95, 95], [97, 122]];
const SPACE: Range[] = [
  [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279],
];
const LINE_TERMINATORS: Range[] = [[10, 10], [13, 13], [8232, 8233]];

const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

class ParseError extends Error {}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alternation();
    if (this.i < this.src.length) throw new ParseError(`unmatched ")" at ${this.i}`);
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === "|") {
      this.i++;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0]! : { t: "alt", options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      items.push(this.quantified(this.atom()));
    }
    return { t: "seq", items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      const m = BRACE_QUANTIFIER.exec(this.src.slice(this.i));
      if (!m) return atom;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) throw new ParseError("numbers out of order in {} quantifier");
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) throw new ParseError(`repeat count above ${MAX_REPEAT}`);
      this.i += m[0].length - 1;
    } else return atom;
    this.i++;
    if (this.peek() === "?") this.i++;
    if (atom.t === "assert") throw new ParseError("nothing to repeat");
    const next = this.peek();
    if (next === "*" || next === "+" || next === "?" || (next === "{" && /^\{\d/.test(this.src.slice(this.i)))) {
      throw new ParseError("nothing to repeat");
    }
    return { t: "repeat", node: atom, min, max };
  }

  private atom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case ".":
        return { t: "set", set: { ranges: LINE_TERMINATORS, negated: true } };
      case "^":
        return { t: "assert", kind: "start" };
      case "$":
        return { t: "assert", kind: "end" };
      case "[":
        return { t: "set", set: this.charClass() };
      case "(":
        return this.group();
      case ")":
        throw new ParseError(`unmatched ")" at ${this.i - 1}`);
      case "*":
      case "+":
      case "?":
        throw new ParseError("nothing to repeat");
      case "\\":
        return this.escape();
      case "{":
        if (BRACE_QUANTIFIER.test(this.src.slice(this.i - 1))) throw new ParseError("nothing to repeat");
        return lit(c.charCodeAt(0));
      default:
        return lit(c.charCodeAt(0));
    }
  }

  private group(): Node {
    if (this.peek() === "?") {
      const head = this.src.slice(this.i, this.i + 3);
      if (head.startsWith("?:")) this.i += 2;
      else if (head.startsWith("?=") || head.startsWith("?!") || head === "?<=" || head === "?<!") {
        throw new ParseError("lookaround is not supported in policy patterns");
      } else if (head.startsWith("?<")) {
        const end = this.src.indexOf(">", this.i);
        if (end < 0) throw new ParseError("invalid group name");
        this.i = end + 1;
      } else throw new ParseError("invalid group");
    }
    const inner = this.alternation();
    if (this.peek() !== ")") throw new ParseError("unterminated group");
    this.i++;
    return inner;
  }

  private escape(): Node {
    const c = this.src[this.i++];
    if (c === undefined) throw new ParseError("\\ at end of pattern");
    if (c === "b") return { t: "assert", kind: "word" };
    if (c === "B") return { t: "assert", kind: "nonword" };
    if (/[1-9]/.test(c) || c === "k") throw new ParseError("backreferences are not supported in policy patterns");
    const cls = classEscape(c);
    if (cls) return { t: "set", set: cls };
    return lit(this.charEscape(c));
  }

  private charEscape(c: string): number {
    switch (c) {
      case "n":
        return 10;
      case "r":
        return 13;
      case "t":
        return 9;
      case "f":
        return 12;
      case "v":
        return 11;
      case "0":
        if (/[0-9]/.test(this.peek() ?? "")) throw new ParseError("octal escapes are not supported");
        return 0;
      case "x":
        return this.hex(2);
      case "u":
        return this.hex(4);
      case "c": {
        const ch = this.src[this.i++];
        if (!ch || !/[A-Za-z]/.test(ch)) throw new ParseError("invalid \\c escape");
        return ch.charCodeAt(0) % 32;
      }
      case "p":
      case "P":
        throw new ParseError("unicode property escapes are not supported");
      default:
        return c.charCodeAt(0);
    }
  }

  private hex(len: number): number {
    const digits = this.src.slice(this.i, this.i + len);
    if (digits.length !== len || !/^[0-9a-fA-F]+$/.test(digits)) throw new ParseError("invalid hex escape");
    this.i += len;
    return parseInt(digits, 16);
  }

  private charClass(): CharSet {
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.i++;
    }
    const ranges: Range[] = [];
    while (true) {
      const c = this.src[this.i++];
      if (c === undefined) throw new ParseError("unterminated character class");
      if (c === "]") break;
      let lo: number;
      if (c === "\\") {
        const e = this.src[this.i++];
        if (e === undefined) throw new ParseError("\\ at end of pattern");
        const cls = classEscape(e);
        if (cls) {
          ranges.push(...(cls.negated ? invert(cls.ranges) : cls.ranges));
          continue;
        }
        // Without the u flag, a digit escape in a class is an octal escape.
        if (/[1-9]/.test(e) || (e === "0" && /[0-9]/.test(this.peek() ?? ""))) {
          throw new ParseError("octal escapes are not supported");
        }
        lo = e === "b" ? 8 : e === "-" ? 45 : this.charEscape(e);
      } else lo = c.charCodeAt(0);
      if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.src[this.i + 1] !== undefined) {
        this.i++;
        let hiChar = this.src[this.i++]!;
        let hi: number;
        if (hiChar === "\\") {
          hiChar = this.src[this.i++] ?? "";
          if (classEscape(hiChar)) throw new ParseError("invalid character class range");
          hi = hiChar === "b" ? 8 : this.charEscape(hiChar);
        } else hi = hiChar.charCodeAt(0);
        if (hi < lo) throw new ParseError("range out of order in character class");
        ranges.push([lo, hi]);
      } else ranges.push([lo, lo]);
    }
    return { ranges, negated };
  }
}

function lit(code: number): Node {
  return { t: "set", set: { ranges: [[code, code]], negated: false } };
}

function classEscape(c: string): CharSet | null {
  switch (c) {
    case "d":
      return { ranges: DIGIT, negated: false };
    case "D":
      return { ranges: DIGIT, negated: true };
    case "w":
      return { ranges: WORD, negated: false };
    case "W":
      return { ranges: WORD, negated: true };
    case "s":
      return { ranges: SPACE, negated: false };
    case "S":
      return { ranges: SPACE, negated: true };
    default:
      return null;
  }
}

function invert(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}

function inSet(set: CharSet, code: number): boolean {
  let hit = false;
  for (const [lo, hi] of set.ranges) {
    if (code >= lo && code <= hi) {
      hit = true;
      break;
    }
  }
  return hit !== set.negated;
}

function isWord(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
}

// `steps` counts calls, not instructions: repeating an empty group emits
// nothing, so program size alone would not bound compile time.
function emit(node: Node, prog: Inst[], steps: { n: number }): void {
  if (prog.length > MAX_PROGRAM || ++steps.n > MAX_EMIT_STEPS) throw new ParseError("pattern too large");
  switch (node.t) {
    case "set":
      prog.push({ op: "set", set: node.set });
      return;
    case "assert":
      prog.push({ op: "assert", kind: node.kind });
      return;
    case "seq":
      for (const item of node.items) emit(item, prog, steps);
      return;
    case "alt": {
      const jumps: Inst[] = [];
      node.options.forEach((option, idx) => {
        if (idx === node.options.length - 1) return emit(option, prog, steps);
        const split: Inst = { op: "split", x: prog.length + 1, y: -1 };
        prog.push(split);
        emit(option, prog, steps);
        const jmp: Inst = { op: "jmp", x: -1 };
        prog.push(jmp);
        jumps.push(jmp);
        (split as { y: number }).y = prog.length;
      });
      for (const j of jumps) (j as { x: number }).x = prog.length;
      return;
    }
    case "repeat": {
      for (let k = 0; k < node.min; k++) emit(node.node, prog, steps);
      if (node.max === Infinity) {
        const split: Inst = { op: "split", x: prog.length + 1, y: -1 };
        const at = prog.length;
        prog.push(split);
        emit(node.node, prog, steps);
        prog.push({ op: "jmp", x: at });
        (split as { y: number }).y = prog.length;
        return;
      }
      const splits: Inst[] = [];
      for (let k = node.min; k < node.max; k++) {
        const split: Inst = { op: "split", x: prog.length + 1, y: -1 };
        prog.push(split);
        splits.push(split);
        emit(node.node, prog, steps);
      }
      for (const s of splits) (s as { y: number }).y = prog.length;
      return;
    }
  }
}

type Context = { atStart: boolean; atEnd: boolean; prevWord: boolean; nextWord: boolean };

type DState = {
  kernel: readonly number[];
  atStart: boolean;
  prevWord: boolean;
  ascii: Int32Array;
  other: Map<number, number>;
};

const UNKNOWN = -1;
const MATCH = -2;
const MAX_STATES = 4096;

function assertHolds(kind: AssertKind, ctx: Context): boolean {
  if (kind === "start") return ctx.atStart;
  if (kind === "end") return ctx.atEnd;
  return (ctx.prevWord !== ctx.nextWord) === (kind === "word");
}

// A DFA built lazily from the NFA program. Each state is the set of NFA
// positions before epsilon closure, plus the context word-boundary and ^
// assertions need. Closure runs once per new (state, char) pair; after that
// each input character is one table lookup. The state cache is bounded, so
// the worst case degrades to NFA simulation, still linear in the input.
function makeMatcher(source: string, prog: readonly Inst[], literal: string): LinearRegex {
  const anchored = prog[0]?.op === "assert" && prog[0].kind === "start";
  const states: DState[] = [];
  const index = new Map<string, number>();
  const mark = new Int32Array(prog.length).fill(-1);
  let markGen = 0;

  const closure = (kernel: readonly number[], ctx: Context): number[] | null => {
    const gen = ++markGen;
    const sets: number[] = [];
    const stack = [...kernel];
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (mark[pc] === gen) continue;
      mark[pc] = gen;
      const inst = prog[pc]!;
      if (inst.op === "match") return null;
      if (inst.op === "set") sets.push(pc);
      else if (inst.op === "jmp") stack.push(inst.x);
      else if (inst.op === "split") stack.push(inst.y, inst.x);
      else if (assertHolds(inst.kind, ctx)) stack.push(pc + 1);
    }
    return sets;
  };

  const intern = (kernel: number[], atStart: boolean, prevWord: boolean): number => {
    const key = `${atStart ? "S" : ""}${prevWord ? "w" : "n"}${kernel.join(",")}`;
    const found = index.get(key);
    if (found !== undefined) return found;
    if (states.length >= MAX_STATES) {
      states.length = 0;
      index.clear();
    }
    states.push({ kernel, atStart, prevWord, ascii: new Int32Array(128).fill(UNKNOWN), other: new Map() });
    index.set(key, states.length - 1);
    return states.length - 1;
  };

  const step = (state: DState, code: number): number => {
    const nextWord = isWord(code);
    const sets = closure(state.kernel, { atStart: state.atStart, atEnd: false, prevWord: state.prevWord, nextWord });
    if (sets === null) return MATCH;
    const next = new Set<number>();
    for (const pc of sets) if (inSet((prog[pc] as { set: CharSet }).set, code)) next.add(pc + 1);
    if (!anchored) next.add(0);
    return intern([...next].sort((a, b) => a - b), false, nextWord);
  };

  return {
    source,
    test(input: string): boolean {
      if (literal && !input.includes(literal)) return false;
      let id = intern([0], true, false);
      let state = states[id]!;
      for (let pos = 0; pos < input.length; pos++) {
        if (anchored && state.kernel.length === 0) return false;
        const code = input.charCodeAt(pos);
        let next = code < 128 ? state.ascii[code]! : (state.other.get(code) ?? UNKNOWN);
        if (next === UNKNOWN) {
          next = step(state, code);
          // step() may have reset the cache; only memoize into a live state.
          if (states[id] === state) {
            if (code < 128) state.ascii[code] = next;
            else state.other.set(code, next);
          }
        }
        if (next === MATCH) return true;
        id = next;
        state = states[id]!;
      }
      return closure(state.kernel, { atStart: state.atStart, atEnd: true, prevWord: state.prevWord, nextWord: false }) === null;
    },
  };
}

// The longest run of single-character literals in the top-level sequence.
// Every match contains it contiguously (assertions are zero-width), so its
// absence rules out a match with one native substring scan.
function requiredLiteral(ast: Node): string {
  if (ast.t !== "seq") return "";
  let best = "";
  let run = "";
  for (const item of ast.items) {
    if (item.t === "assert") continue;
    const r = item.t === "set" && !item.set.negated && item.set.ranges.length === 1 ? item.set.ranges[0]! : null;
    if (r && r[0] === r[1]) {
      run += String.fromCharCode(r[0]);
      if (run.length > best.length) best = run;
    } else run = "";
  }
  return best;
}

export function compileLinearRegex(source: string): RegexCompileResult {
  try {
    const ast = new Parser(source).parse();
    const prog: Inst[] = [];
    emit(ast, prog, { n: 0 });
    prog.push({ op: "match" });
    if (prog.length > MAX_PROGRAM) throw new ParseError("pattern too large");
    return { ok: true, regex: makeMatcher(source, prog, requiredLiteral(ast)) };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: `invalid pattern /${source}/: ${error.message}` };
    throw error;
  }
}
