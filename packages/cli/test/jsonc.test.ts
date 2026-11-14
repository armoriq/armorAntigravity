import { describe, expect, test } from "bun:test";
import { getMember, isEmptyObjectAt, JsoncError, parseJsonc, removeMember, setMember } from "../src/jsonc.ts";

const USER_MCP = `// my servers
{
  "mcpServers": {
    /* github, keep */
    "github": { "command": "gh-mcp", "args": ["--port", "1"] }, // trailing comment
    "notes": {
      "url": "http://localhost:9000/sse", // no // comment inside "strings"
    },
  },
  "other": [1, 2, 3,],
}
`;

describe("parseJsonc", () => {
  test("reads comments, trailing commas and comment-like strings", () => {
    expect(parseJsonc(USER_MCP)).toEqual({
      mcpServers: { github: { command: "gh-mcp", args: ["--port", "1"] }, notes: { url: "http://localhost:9000/sse" } },
      other: [1, 2, 3],
    });
  });

  test("treats an empty file as an empty object", () => {
    expect(parseJsonc("")).toEqual({});
    expect(parseJsonc(" \n")).toEqual({});
  });

  test.each([
    ["[1]", "top level"],
    ['{"a": 1', "end of input"],
    ['{"a": 1} x', "unexpected"],
    ['{"a": 1, "a": 2}', "duplicate key"],
    ['{"a": /* open', "unterminated comment"],
    ['{"a": 01}', "offset"],
  ])("rejects %s", (src, message) => {
    expect(() => parseJsonc(src)).toThrow(JsoncError);
    expect(() => parseJsonc(src)).toThrow(message);
  });
});

describe("setMember", () => {
  test("inserts a nested member first and leaves every other byte alone", () => {
    const out = setMember(USER_MCP, ["mcpServers", "armoriq"], { command: "/bin/x", args: ["mcp"] });
    expect(parseJsonc(out).mcpServers).toMatchObject({ armoriq: { command: "/bin/x", args: ["mcp"] } });
    expect(removeMember(out, ["mcpServers", "armoriq"])).toBe(USER_MCP);
    expect(out).toStartWith('// my servers\n{\n  "mcpServers": {\n    "armoriq": {\n      "command": "/bin/x",\n      "args": [\n        "mcp"\n      ]\n    },\n    /* github, keep */\n');
  });

  test("creates a missing parent object", () => {
    const src = '{\n  "theme": "dark", // keep\n}\n';
    const out = setMember(src, ["mcpServers", "armoriq"], { command: "x" });
    expect(parseJsonc(out)).toEqual({ theme: "dark", mcpServers: { armoriq: { command: "x" } } });
    expect(removeMember(out, ["mcpServers"])).toBe(src);
  });

  test("writes a fresh document for an empty file", () => {
    const out = setMember("", ["armoriq"], { Stop: [] });
    expect(out).toBe('{\n  "armoriq": {\n    "Stop": []\n  }\n}\n');
  });

  test("fills an empty object, including one holding only a comment", () => {
    expect(setMember("{}", ["a"], 1)).toBe('{\n  "a": 1\n}');
    const commented = "{\n  // nothing yet\n}";
    const out = setMember(commented, ["a"], 1);
    expect(parseJsonc(out)).toEqual({ a: 1 });
    expect(removeMember(out, ["a"])).toBe(commented);
  });

  test("keeps a single-line object on one line", () => {
    const out = setMember('{ "a": 1 }', ["b"], { c: [1, 2] });
    expect(out).toBe('{ "b": {"c":[1,2]}, "a": 1 }');
    expect(removeMember(out, ["b"])).toBe('{ "a": 1 }');
    expect(setMember(out, ["b"], { c: [3] })).toBe('{ "b": {"c":[3]}, "a": 1 }');
  });

  test("leaves a comment and trailing comma after the last member in place", () => {
    const src = '{\n  "a": 1, // about a\n}\n';
    const out = setMember(src, ["b"], 2);
    expect(out).toBe('{\n  "b": 2,\n  "a": 1, // about a\n}\n');
    expect(removeMember(out, ["b"])).toBe(src);
  });

  test("removes its first member without eating the comment above the next one", () => {
    const src = '{\n  /* about a */\n  "a": 1\n}';
    const out = setMember(src, ["b"], 2);
    expect(out).toBe('{\n  "b": 2,\n  /* about a */\n  "a": 1\n}');
    expect(removeMember(out, ["b"])).toBe(src);
  });

  test("returns the same text when the value is already equal", () => {
    const once = setMember(USER_MCP, ["mcpServers", "armoriq"], { command: "x", args: ["mcp"] });
    expect(setMember(once, ["mcpServers", "armoriq"], { args: ["mcp"], command: "x" })).toBe(once);
  });

  test("replaces a different value in place", () => {
    const once = setMember(USER_MCP, ["mcpServers", "armoriq"], { command: "old" });
    const twice = setMember(once, ["mcpServers", "armoriq"], { command: "new" });
    expect(getMember(twice, ["mcpServers", "armoriq"])).toEqual({ command: "new" });
    expect(removeMember(twice, ["mcpServers", "armoriq"])).toBe(USER_MCP);
  });

  test("refuses to descend into a non-object", () => {
    expect(() => setMember('{"mcpServers": []}', ["mcpServers", "armoriq"], 1)).toThrow("is not an object");
  });
});

describe("removeMember", () => {
  test("removes the first member of several", () => {
    expect(removeMember('{\n  "a": 1,\n  "b": 2\n}', ["a"])).toBe('{\n  "b": 2\n}');
  });

  test("removes the last member and keeps a comment that held a comma", () => {
    const src = '{\n  "a": 1 /* x, y */,\n  "b": 2\n}';
    const out = removeMember(src, ["b"]);
    expect(parseJsonc(out)).toEqual({ a: 1 });
    expect(out).toContain("/* x, y */");
  });

  test.each([
    ['{ // a\n "armoriq": 1 }', "{ // a\n }"],
    ['{"mcpServers": { // my servers\n  "armoriq": {"x": 1}}}', '{"mcpServers": { // my servers\n}}'],
    ['{\n  // hooks\n  "armoriq": {}, }', "{\n  // hooks\n }"],
    ['{ // c\n  "armoriq": 1, "a": 2 }', '{ // c\n  "a": 2 }'],
  ])("never pulls a closing brace or member into a line comment: %s", (src, expected) => {
    const out = removeMember(src, src.includes("mcpServers") ? ["mcpServers", "armoriq"] : ["armoriq"]);
    expect(out).toBe(expected);
    expect(() => parseJsonc(out)).not.toThrow();
  });

  test("leaves the text alone when the member is absent", () => {
    expect(removeMember(USER_MCP, ["mcpServers", "nope"])).toBe(USER_MCP);
    expect(removeMember(USER_MCP, ["nope", "deeper"])).toBe(USER_MCP);
    expect(removeMember("", ["a"])).toBe("");
  });
});

test("isEmptyObjectAt ignores objects that still hold comments", () => {
  expect(isEmptyObjectAt('{"a": {}}', ["a"])).toBe(true);
  expect(isEmptyObjectAt('{"a": { /* mine */ }}', ["a"])).toBe(false);
  expect(isEmptyObjectAt('{"a": {"b": 1}}', ["a"])).toBe(false);
});
