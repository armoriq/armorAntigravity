export const MAX_PARAM_CHARS = 2000;

const LIMITS = { maxDepth: 4, maxKeys: 50, maxItems: 50 };

// A superset of ArmorClaude common.mjs SECRET_PATTERNS (from PR #36): also
// prefixed names such as OPENAI_API_KEY, quoted JSON keys, Basic auth,
// `curl -u`, URL userinfo and bare provider keys.
const SECRET_PATTERNS = [
  /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
  /(\s-u\s+["']?[^\s:"']+:)[^\s"']+/g,
  /(:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_\-]{16,}/g,
  /\bak_[A-Za-z0-9_\-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_KEYWORD = /api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|credential|authorization/gi;

function isNameChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
}

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

// `<name containing a keyword>[quote] [:=] [quote]<value of 6+ chars>`.
// A regex with open-ended name runs around the keyword backtracks
// quadratically on inputs like "token-token-..."; this scan never revisits
// a character.
function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  const re = new RegExp(SECRET_KEYWORD.source, "gi");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    while (i < text.length && isNameChar(text.charCodeAt(i))) i++;
    re.lastIndex = i;
    if (text[i] === '"' || text[i] === "'") i++;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (text[i] !== ":" && text[i] !== "=") continue;
    i++;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (text[i] === '"' || text[i] === "'") i++;
    if (/^(?:bearer|basic)\s/i.test(text.slice(i, i + 7))) continue;
    let j = i;
    while (j < text.length && !isSpace(text.charCodeAt(j)) && !"\"',;".includes(text[j]!)) j++;
    if (j - i < 6) continue;
    out += `${text.slice(last, i)}<redacted>`;
    last = j;
    re.lastIndex = j;
  }
  return last === 0 ? text : out + text.slice(last);
}

export function redactText(text: string): string {
  let out = redactAssignments(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: unknown) => `${typeof prefix === "string" ? prefix : ""}<redacted>`);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Redaction runs before the final cut so a secret straddling the cut is never
// left as a prefix too short to match. The wider first cut bounds regex cost
// on megabyte-sized arguments.
function scrubString(value: string): string {
  const redacted = redactText(value.slice(0, MAX_PARAM_CHARS * 4));
  return redacted.length > MAX_PARAM_CHARS ? `${redacted.slice(0, MAX_PARAM_CHARS)}...` : redacted;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > LIMITS.maxDepth) return "<max-depth>";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "<function>";
  if (value instanceof Uint8Array) return `<binary:${value.length}>`;
  if (Array.isArray(value)) return value.slice(0, LIMITS.maxItems).map((entry) => scrub(entry, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, LIMITS.maxKeys)) out[key] = scrub(entry, depth + 1);
    return out;
  }
  return String(value);
}

export function sanitizeParams(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return scrub(value, 0) as Record<string, unknown>;
}
