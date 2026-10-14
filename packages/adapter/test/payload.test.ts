import { describe, expect, test } from "bun:test";
import { isHookEvent, parseHookPayload } from "../src/payload.ts";
import { allCaptures, captured, fixture } from "./fixtures.ts";

const stdinOf = (name: string): object => {
  const stdin = captured(name).stdin;
  return typeof stdin === "object" && stdin !== null ? stdin : {};
};
const runCommand = () => stdinOf("pre-run_command");

describe("parseHookPayload on captured agy payloads", () => {
  test.each(allCaptures().map((c) => [c.file, c] as const))("%s parses", (_file, c) => {
    const r = parseHookPayload(c.event, c.stdin);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.event).toBe(c.event);
  });

  test("PreToolUse run_command keeps the captured fields", () => {
    const c = captured("pre-run_command");
    const r = parseHookPayload(c.event, c.stdin);
    if (!r.ok || r.payload.event !== "PreToolUse") throw new Error("expected PreToolUse");
    expect(r.payload).toMatchObject({
      conversationId: "ef59e687-e00f-44c2-9724-a00d0abf24d4",
      stepIdx: 2,
      modelName: "gemini-3.8-flash-high",
      workspacePaths: ["/Users/dev/src/ws"],
      toolCall: { name: "run_command", args: { CommandLine: "touch /Users/dev/src/ws/m-deny", Cwd: "/Users/dev/src/ws" } },
    });
  });

  test("PostToolUse carries agy's empty-string error and a real one", () => {
    const ok = captured("post-run_command");
    const okParsed = parseHookPayload(ok.event, ok.stdin);
    expect(okParsed.ok && okParsed.payload.event === "PostToolUse" && okParsed.payload.error).toBe("");
    const failed = captured("post-mcp_chrome_devtools_list_pages-error");
    const failedParsed = parseHookPayload(failed.event, failed.stdin);
    expect(failedParsed.ok && failedParsed.payload.event === "PostToolUse" && failedParsed.payload.error).toStartWith("Could not connect to Chrome");
  });

  test("Stop and invocation extras (fullyIdle, invocationNum) are ignored", () => {
    const c = captured("stop");
    const r = parseHookPayload(c.event, c.stdin);
    if (!r.ok) throw new Error(r.error);
    expect("fullyIdle" in r.payload).toBe(false);
    expect("terminationReason" in r.payload).toBe(false);
  });
});

describe("parseHookPayload", () => {
  test("optional fields that are absent stay absent rather than undefined", () => {
    const r = parseHookPayload("Stop", fixture("documented/stop-minimal.json"));
    if (!r.ok) throw new Error(r.error);
    expect("modelName" in r.payload).toBe(false);
    expect("artifactDirectoryPath" in r.payload).toBe(false);
  });

  test("a turn event ignores tool fields and unknown fields", () => {
    const raw = { ...stdinOf("pre-invocation"), futureField: { x: 1 } };
    const r = parseHookPayload("PreInvocation", raw);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.event).toBe("PreInvocation");
    expect("futureField" in r.payload).toBe(false);
  });

  test("a tool event without toolCall is rejected with the path", () => {
    const r = parseHookPayload("PreToolUse", captured("pre-invocation").stdin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("toolCall");
  });

  test.each([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["an empty conversation id", { conversationId: "", workspacePaths: [], transcriptPath: "" }],
    ["a non-integer step", { ...runCommand(), stepIdx: 1.5 }],
    ["an empty tool name", { ...runCommand(), toolCall: { name: "", args: {} } }],
  ])("rejects %s", (_label, raw) => {
    expect(parseHookPayload("PreToolUse", raw).ok).toBe(false);
  });
});

test("isHookEvent", () => {
  expect(isHookEvent("PreToolUse")).toBe(true);
  expect(isHookEvent("SessionStart")).toBe(false);
  expect(isHookEvent(undefined)).toBe(false);
});
