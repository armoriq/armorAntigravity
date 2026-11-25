import { describe, expect, test } from "bun:test";
import { compileLinearRegex } from "../../src/core/linear-regex.ts";

function re(source: string) {
  const r = compileLinearRegex(source);
  if (!r.ok) throw new Error(r.error);
  return r.regex;
}

const PATTERNS = [
  "rm\\s+-rf",
  "\\bcurl\\b.*\\|\\s*sh",
  "^git (push|reset)",
  "create_issue$",
  "^(ls|cat)",
  "a{2,3}b",
  "a{2}",
  "a{2,}",
  "[^a-z0-9]",
  "[a\\-z]",
  "[\\d.]+\\.env$",
  "\\.ssh/id_[a-z]+",
  "x?y*z+",
  "(?:ab|cd)+e",
  "(?<name>foo)bar",
  "colou?r",
  "\\Bfoo",
  "[]",
  "[^]",
  "a|",
  "",
  "\\x41\\u0042",
  "\\t\\n",
  "a.c",
  "^$",
  "(a*)*b",
  "\\$HOME",
  "{",
  "a{,2}",
];

const INPUTS = [
  "",
  "rm -rf /",
  "rm  -rf",
  "curl https://x | sh",
  "curl x |sh",
  "git push origin",
  "git status",
  "github_create_issue",
  "ls -la",
  "aab",
  "aaaab",
  "ab",
  "abc",
  "a-z",
  "12.env",
  "~/.ssh/id_rsa",
  "yyz",
  "abcde",
  "foobar",
  "color colour",
  "xfoo foo",
  "AB",
  "\t\n",
  "a\nc",
  "abc a.c",
  "aaab",
  "$HOME/x",
  "{",
  "a{,2}",
];

describe("compileLinearRegex", () => {
  test("agrees with the native engine on every pattern and input", () => {
    const mismatches: string[] = [];
    for (const source of PATTERNS) {
      const ours = re(source);
      const native = new RegExp(source);
      for (const input of INPUTS) {
        if (ours.test(input) !== native.test(input)) mismatches.push(`/${source}/ on ${JSON.stringify(input)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("agrees with the native engine on 3000 random patterns", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ["a", "b", "c", ".", "[ab]", "[^a]", "\\d", "\\w", "\\s", "\\b", "^", "$", "-", " "];
    const gen = (depth: number): string => {
      const parts: string[] = [];
      const len = 1 + rand(4);
      for (let i = 0; i < len; i++) {
        let atom = depth < 2 && rand(5) === 0 ? `(${gen(depth + 1)}${rand(2) ? `|${gen(depth + 1)}` : ""})` : atoms[rand(atoms.length)]!;
        const q = rand(8);
        if (q === 0) atom += "*";
        else if (q === 1) atom += "+";
        else if (q === 2) atom += "?";
        else if (q === 3) atom += `{${rand(3)},${2 + rand(2)}}`;
        parts.push(atom);
      }
      return parts.join("");
    };
    const alphabet = "abc1 -\n_";
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const source = gen(0);
      let native: RegExp;
      try {
        native = new RegExp(source);
      } catch {
        expect(compileLinearRegex(source).ok).toBe(false);
        continue;
      }
      const ours = re(source);
      for (let j = 0; j < 8; j++) {
        let input = "";
        for (let k = rand(10); k > 0; k--) input += alphabet[rand(alphabet.length)];
        if (ours.test(input) !== native.test(input)) mismatches.push(`/${source}/ on ${JSON.stringify(input)}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  test("rejects constructs that need backtracking, with a clear error", () => {
    expect(compileLinearRegex("(a)\\1")).toEqual({
      ok: false,
      error: "invalid pattern /(a)\\1/: backreferences are not supported in policy patterns",
    });
    expect(compileLinearRegex("foo(?=bar)")).toEqual({
      ok: false,
      error: "invalid pattern /foo(?=bar)/: lookaround is not supported in policy patterns",
    });
    expect(compileLinearRegex("(?<!x)y").ok).toBe(false);
    expect(compileLinearRegex("(?<n>a)\\k<n>").ok).toBe(false);
  });

  test("rejects syntax errors the native engine also rejects", () => {
    for (const bad of ["(", "a)", "[a", "*a", "a**", "a{3,1}", "\\"]) {
      expect(() => new RegExp(bad)).toThrow();
      expect(compileLinearRegex(bad).ok).toBe(false);
    }
  });

  test("follows the native engine on brace quantifiers and class escapes", () => {
    expect(() => new RegExp("{2}")).toThrow();
    expect(compileLinearRegex("{2}").ok).toBe(false);
    expect(compileLinearRegex("(?:{2})").ok).toBe(false);
    expect(re("a{00000000000000000000001}").test("a")).toBe(new RegExp("a{00000000000000000000001}").test("a"));
    expect(compileLinearRegex("[\\1]")).toEqual({ ok: false, error: "invalid pattern /[\\1]/: octal escapes are not supported" });
  });

  test("compile time is bounded even when repeats emit nothing", () => {
    const t = performance.now();
    expect(compileLinearRegex("(((?:){1000}){1000}){1000}")).toEqual({
      ok: false,
      error: "invalid pattern /(((?:){1000}){1000}){1000}/: pattern too large",
    });
    expect(performance.now() - t).toBeLessThan(100);
  });

  test("nested and overlapping quantifiers stay fast on the classic attack input", () => {
    const input = `${"a".repeat(29)}!`;
    for (const source of ["^(a+)+$", "^(a|a)*$", "^(a|aa)+$", "(a*)*b", "^(a?){29}a{29}$"]) {
      const r = re(source);
      const t = performance.now();
      expect(r.test(input)).toBe(false);
      expect(performance.now() - t).toBeLessThan(5);
    }
  });

  test("a leading .* on a 1 MB input is linear, not quadratic", () => {
    const input = "a".repeat(1 << 20);
    const r = re(".*foo");
    const t = performance.now();
    expect(r.test(input)).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
