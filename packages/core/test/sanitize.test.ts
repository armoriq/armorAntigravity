import { describe, expect, test } from "bun:test";
import { MAX_PARAM_CHARS, redactText, sanitizeParams } from "../src/sanitize.ts";

// Split so secret scanners do not flag the fixture as a real key.
const KEY = "PRIVATE " + "KEY";

describe("redactText", () => {
  test("keeps the label and drops the secret value", () => {
    expect(redactText("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv")).toBe("export OPENAI_API_KEY=<redacted>");
    expect(redactText("curl -H 'Authorization: Bearer abcdefghijklmnopqrst'")).toBe("curl -H 'Authorization: Bearer <redacted>'");
    expect(redactText('{"password": "hunter2hunter2"}')).toBe('{"password": "<redacted>"}');
    expect(redactText("curl -u admin:s3cretpass https://x")).toBe("curl -u admin:<redacted> https://x");
    expect(redactText("git clone https://bob:tok3n@github.com/x")).toBe("git clone https://bob:<redacted>@github.com/x");
  });

  test("redacts bare provider keys and key blocks", () => {
    expect(redactText("key AKIAABCDEFGHIJKLMNOP here")).toBe("key <redacted> here");
    expect(redactText(`t ghp_${"a".repeat(36)}`)).toBe("t <redacted>");
    expect(redactText(`-----BEGIN RSA ${KEY}-----\nabc\n-----END RSA ${KEY}-----`)).toBe("<redacted>");
    expect(redactText("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4")).toBe("jwt <redacted>");
  });

  test("stays fast on text dense with secret keywords", () => {
    for (const text of ["token-".repeat(1333), "a-".repeat(4000), "api_key= ".repeat(900), `-----BEGIN ${KEY}-----`.repeat(300)]) {
      const t = performance.now();
      sanitizeParams({ content: text });
      expect(performance.now() - t).toBeLessThan(20);
    }
  });

  test("leaves ordinary text alone", () => {
    expect(redactText("bun test && git status")).toBe("bun test && git status");
  });
});

describe("sanitizeParams", () => {
  test("truncates every string to the limit with a marker", () => {
    const out = sanitizeParams({ content: "x".repeat(5000), nested: { list: ["y".repeat(2001)] } });
    expect(out.content).toBe(`${"x".repeat(MAX_PARAM_CHARS)}...`);
    expect((out.nested as { list: string[] }).list[0]).toBe(`${"y".repeat(2000)}...`);
    expect(MAX_PARAM_CHARS).toBe(2000);
  });

  test("redacts before truncating, so a secret across the cut is not left as a stub", () => {
    const out = sanitizeParams({ command: `${"a ".repeat(995)} TOKEN=abcdefghijklmnopqrstuvwxyz` });
    expect(out.command).not.toContain("abcdef");
  });

  test("non-objects become an empty object and odd values become strings", () => {
    expect(sanitizeParams("text")).toEqual({});
    expect(sanitizeParams(null)).toEqual({});
    expect(sanitizeParams([1, 2])).toEqual({});
    expect(sanitizeParams({ a: undefined, b: 10n, c: new Uint8Array(3), d: true, e: 1.5 })).toEqual({
      a: null,
      b: "10",
      c: "<binary:3>",
      d: true,
      e: 1.5,
    });
  });

  test("depth and breadth are bounded", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(sanitizeParams(deep)).toEqual({ a: { b: { c: { d: { e: "<max-depth>" } } } } });
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeParams(wide))).toHaveLength(50);
  });
});
