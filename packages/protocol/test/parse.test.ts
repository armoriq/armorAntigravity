import { expect, test } from "bun:test";
import { parseHookPayload } from "../src/index.ts";

const base = {
  conversationId: "c1",
  workspacePaths: ["/w"],
  transcriptPath: "/h/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl",
};

test("PreToolUse keeps the tool call and drops unknown fields", () => {
  expect(parseHookPayload("PreToolUse", { ...base, toolCall: { name: "run_command", args: { cmd: "ls" } }, stepIdx: 3, extra: 1 })).toEqual({
    ...base,
    event: "PreToolUse",
    toolCall: { name: "run_command", args: { cmd: "ls" } },
    stepIdx: 3,
  });
});

test("turn events need only the base fields", () => {
  expect(parseHookPayload("Stop", { ...base, modelName: "gemini-3" })).toEqual({ ...base, modelName: "gemini-3", event: "Stop" });
});

test("rejects payloads missing the session fields or the tool call", () => {
  expect(parseHookPayload("Stop", { ...base, conversationId: "" })).toBeNull();
  expect(parseHookPayload("Stop", { ...base, workspacePaths: [1] })).toBeNull();
  expect(parseHookPayload("PreToolUse", base)).toBeNull();
  expect(parseHookPayload("PostToolUse", { ...base, toolCall: { name: "x" }, stepIdx: 1.5 })).toBeNull();
  expect(parseHookPayload("Stop", "not an object")).toBeNull();
});
