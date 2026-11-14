// Text-preserving edits for Antigravity's JSONC config files (PRD N2): only the member being set or
// removed changes, so the user's comments, trailing commas, key order and formatting survive.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class JsoncError extends Error {}

type Token = { t: "{" | "}" | "[" | "]" | ":" | "," | "str" | "lit"; s: number; e: number; v?: string };
type Member = { key: string; s: number; e: number; value: Node };
type Node =
  | { type: "object"; s: number; e: number; members: Member[] }
  | { type: "array"; s: number; e: number; items: Node[] }
  | { type: "scalar"; s: number; e: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (/\s/.test(c) || c === "﻿") {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new JsoncError(`unterminated comment at offset ${i}`);
      i = end + 2;
    } else if ("{}[]:,".includes(c)) {
      tokens.push({ t: c as Token["t"], s: i, e: i + 1 });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (src[j] !== '"') throw new JsoncError(`unterminated string at offset ${i}`);
      let v: unknown;
      try {
        v = JSON.parse(src.slice(i, j + 1));
      } catch {
        throw new JsoncError(`invalid string at offset ${i}`);
      }
      tokens.push({ t: "str", s: i, e: j + 1, v: String(v) });
      i = j + 1;
    } else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i, i + 400));
      if (!m) throw new JsoncError(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
      tokens.push({ t: "lit", s: i, e: i + m[0].length });
      i += m[0].length;
    }
  }
  return tokens;
}

function parseTree(src: string): Node {
  const tokens = tokenize(src);
  let k = 0;
  const take = (t?: Token["t"]): Token => {
    const tok = tokens[k];
    if (!tok) throw new JsoncError("unexpected end of input");
    if (t && tok.t !== t) throw new JsoncError(`expected ${t} at offset ${tok.s}`);
    k++;
    return tok;
  };
  const value = (depth: number): Node => {
    if (depth > 512) throw new JsoncError("nesting too deep");
    const tok = take();
    if (tok.t === "{") {
      const members: Member[] = [];
      const seen = new Set<string>();
      while (tokens[k]?.t !== "}") {
        const key = take("str");
        take(":");
        const v = value(depth + 1);
        const name = key.v ?? "";
        if (seen.has(name)) throw new JsoncError(`duplicate key ${JSON.stringify(name)} at offset ${key.s}`);
        seen.add(name);
        members.push({ key: name, s: key.s, e: v.e, value: v });
        if (tokens[k]?.t !== ",") break;
        take(",");
      }
      return { type: "object", s: tok.s, e: take("}").e, members };
    }
    if (tok.t === "[") {
      const items: Node[] = [];
      while (tokens[k]?.t !== "]") {
        items.push(value(depth + 1));
        if (tokens[k]?.t !== ",") break;
        take(",");
      }
      return { type: "array", s: tok.s, e: take("]").e, items };
    }
    if (tok.t === "str" || tok.t === "lit") return { type: "scalar", s: tok.s, e: tok.e };
    throw new JsoncError(`unexpected ${tok.t} at offset ${tok.s}`);
  };
  const root = value(0);
  const extra = tokens[k];
  if (extra) throw new JsoncError(`trailing content at offset ${extra.s}`);
  return root;
}

function rootObject(src: string): Extract<Node, { type: "object" }> | null {
  if (isBlank(src)) return null;
  const root = parseTree(src);
  if (root.type !== "object") throw new JsoncError("the top level must be an object");
  return root;
}

function toValue(src: string, node: Node): Json {
  if (node.type === "object") return Object.fromEntries(node.members.map((m) => [m.key, toValue(src, m.value)]));
  if (node.type === "array") return node.items.map((item) => toValue(src, item));
  return JSON.parse(src.slice(node.s, node.e)) as Json;
}

// An empty or whitespace-only file is an empty object: agy creates an empty mcp_config.json.
export function parseJsonc(src: string): JsonObject {
  const root = rootObject(src);
  return root ? (toValue(src, root) as JsonObject) : {};
}

export function getMember(src: string, key: readonly string[]): Json | undefined {
  const root = rootObject(src);
  if (!root) return undefined;
  const found = walk(root, key);
  return found.missing === key.length ? toValue(src, found.node) : undefined;
}

// Sets the member at `key`, creating missing parent objects. Returns `src` unchanged when the
// member already holds an equal value.
export function setMember(src: string, key: readonly string[], value: Json): string {
  if (key.length === 0) throw new JsoncError("empty key path");
  const root = rootObject(src);
  if (!root) return `{\n  ${renderMember(key, value, "  ")}\n}\n`;
  const { node, missing, member } = walk(root, key);
  if (missing === key.length) {
    if (member && sameJson(toValue(src, node), value)) return src;
    if (!member) throw new JsoncError("cannot replace the root");
    const compact = !src.slice(node.s, node.e).includes("\n");
    return checked(splice(src, node.s, node.e, render(value, indentAt(src, member.s), compact)));
  }
  if (node.type !== "object") throw new JsoncError(`${JSON.stringify(key.slice(0, missing).join("."))} is not an object`);
  const indent = memberIndent(src, node);
  // A single-line object stays on one line.
  const first = node.members[0];
  const compact = first !== undefined && !src.slice(node.s, first.s).includes("\n");
  return checked(insertMember(src, node, renderMember(key.slice(missing), value, indent, compact), indent));
}

// Removes the member at `key` with the separator that joined it to its neighbours. Returns `src`
// unchanged when it is absent.
export function removeMember(src: string, key: readonly string[]): string {
  const root = rootObject(src);
  if (!root || key.length === 0) return src;
  const parentPath = key.slice(0, -1);
  const { node: parent, missing } = walk(root, parentPath);
  if (missing !== parentPath.length || parent.type !== "object") return src;
  const index = parent.members.findIndex((m) => m.key === key[key.length - 1]);
  if (index < 0) return src;
  return checked(deleteMember(src, parent, index));
}

export function isEmptyObjectAt(src: string, key: readonly string[]): boolean {
  const root = rootObject(src);
  if (!root) return key.length === 0;
  const { node, missing } = walk(root, key);
  return missing === key.length && node.type === "object" && node.members.length === 0 && isBlank(src.slice(node.s + 1, node.e - 1));
}

function walk(root: Node, key: readonly string[]): { node: Node; missing: number; member: Member | null } {
  let node = root;
  let member: Member | null = null;
  for (const [i, k] of key.entries()) {
    if (node.type !== "object") return { node, missing: i, member };
    const next = node.members.find((m) => m.key === k);
    if (!next) return { node, missing: i, member };
    member = next;
    node = next.value;
  }
  return { node, missing: key.length, member };
}

function insertMember(src: string, obj: Extract<Node, { type: "object" }>, text: string, indent: string): string {
  // First, not last: a comment or trailing comma after the last member stays where the user put it.
  const first = obj.members[0];
  if (first) {
    if (src.slice(obj.s, first.s).includes("\n")) return splice(src, obj.s + 1, obj.s + 1, `\n${indent}${text},`);
    return splice(src, first.s, first.s, `${text}, `);
  }
  const inner = src.slice(obj.s + 1, obj.e - 1);
  if (isBlank(inner)) return splice(src, obj.s + 1, obj.e - 1, `\n${indent}${text}\n${indentAt(src, obj.s)}`);
  const end = obj.s + 1 + inner.trimEnd().length;
  return splice(src, end, end, `\n${indent}${text}`);
}

function deleteMember(src: string, obj: Extract<Node, { type: "object" }>, index: number): string {
  const node = obj.members[index];
  if (!node) return src;
  const prev = obj.members[index - 1];
  const next = obj.members[index + 1];
  if (prev) {
    const gap = src.slice(prev.e, node.s);
    if (/^\s*,\s*$/.test(gap)) return splice(src, prev.e, node.e);
    const comma = prev.e + commaOffset(gap);
    return splice(splice(src, node.s, node.e), comma, comma + 1);
  }
  if (next) {
    const gap = src.slice(node.e, next.s);
    if (/^\s*,\s*$/.test(gap)) return splice(src, node.s, next.s);
    const comma = node.e + commaOffset(gap);
    const lineStart = src.lastIndexOf("\n", node.s - 1);
    if (lineStart > obj.s && isBlank(src.slice(lineStart, node.s)) && !endsInLineComment(src, obj.s + 1, lineStart)) return splice(src, lineStart, comma + 1);
    return splice(src, node.s, comma + 1);
  }
  const after = src.slice(node.e, obj.e - 1);
  const trailing = /^\s*,/.exec(after)?.[0].length ?? 0;
  if (isBlank(src.slice(obj.s + 1, node.s)) && isBlank(after.slice(trailing))) return splice(src, obj.s + 1, obj.e - 1);
  const start = obj.s + 1 + src.slice(obj.s + 1, node.s).trimEnd().length;
  // Joining the rest onto a `//` line would comment out the closing brace.
  const rest = src.slice(node.e + trailing);
  const newline = endsInLineComment(src, obj.s + 1, start) && !/^[ \t]*(?:\r?\n)/.test(rest) ? "\n" : "";
  return splice(src, start, node.e + trailing, newline);
}

// Whether the text in [from, to) ends inside a `//` comment that runs to `to`. Callers pass a span
// that holds only whitespace and comments.
function endsInLineComment(src: string, from: number, to: number): boolean {
  const line = src.slice(Math.max(from, src.lastIndexOf("\n", to - 1) + 1), to);
  return line.replace(/\/\*[\s\S]*?\*\//g, "").includes("//");
}

// Every edit must leave a document that still parses; refuse rather than write a broken file.
function checked(out: string): string {
  try {
    parseTree(out);
  } catch (error) {
    throw new JsoncError(`edit would produce invalid JSONC (${error instanceof Error ? error.message : String(error)})`);
  }
  return out;
}

// The separating comma may follow a comment that itself contains commas.
function commaOffset(gap: string): number {
  let i = 0;
  while (i < gap.length) {
    if (gap[i] === ",") return i;
    if (gap.startsWith("//", i)) i = gap.indexOf("\n", i) < 0 ? gap.length : gap.indexOf("\n", i);
    else if (gap.startsWith("/*", i)) i = gap.indexOf("*/", i) + 2;
    else i++;
  }
  throw new JsoncError("no comma between members");
}

function memberIndent(src: string, obj: Extract<Node, { type: "object" }>): string {
  const first = obj.members[0];
  if (first && src.slice(obj.s, first.s).includes("\n")) return indentAt(src, first.s);
  return `${indentAt(src, obj.s)}  `;
}

function renderMember(key: readonly string[], value: Json, indent: string, compact = false): string {
  const [head, ...rest] = key;
  let nested = value;
  for (const k of [...rest].reverse()) nested = { [k]: nested };
  return `${JSON.stringify(head)}: ${render(nested, indent, compact)}`;
}

function render(value: Json, indent: string, compact = false): string {
  return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

function indentAt(src: string, offset: number): string {
  const lineStart = src.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart, offset))?.[0] ?? "";
}

function sameJson(a: Json, b: Json): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k] ?? null)]));
}

const isBlank = (text: string) => text.trim() === "";
const splice = (src: string, s: number, e: number, text = "") => src.slice(0, s) + text + src.slice(e);
