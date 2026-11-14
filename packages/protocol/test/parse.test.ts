import { expect, test } from "bun:test";
import { HOOK_FRAME_TAG, hookResponseLine, parseHookFrame, parseHookPayload } from "../src/index.ts";

const base = {
  conversationId: "c1",
  workspacePaths: ["/w"],
  transcriptPath: "/h/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl",
  artifactDirectoryPath: "/h/.gemini/antigravity-cli/brain/c1",
  modelName: "gemini-3.8-flash-high",
};

test("PreToolUse keeps the tool call and drops unknown fields", () => {
  expect(parseHookPayload("PreToolUse", { ...base, toolCall: { name: "run_command", args: { cmd: "ls" } }, stepIdx: 3, extra: 1 })).toEqual({
    ...base,
    event: "PreToolUse",
    toolCall: { name: "run_command", args: { cmd: "ls" } },
    stepIdx: 3,
  });
});

const stop = { executionNum: 0, fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" };

test("Stop keeps its termination fields", () => {
  expect(parseHookPayload("Stop", { ...base, ...stop })).toEqual({ ...base, ...stop, event: "Stop" });
});

test("invocation events keep their counters", () => {
  const inv = { invocationNum: 1, initialNumSteps: 0 };
  expect(parseHookPayload("PreInvocation", { ...base, ...inv })).toEqual({ ...base, ...inv, event: "PreInvocation" });
});

test("PostToolUse requires the error string", () => {
  const post = { ...base, toolCall: { name: "run_command", args: {} }, stepIdx: 1 };
  expect(parseHookPayload("PostToolUse", post)).toBeNull();
  expect(parseHookPayload("PostToolUse", { ...post, error: "" })).toMatchObject({ event: "PostToolUse", error: "" });
});

test("rejects payloads missing modelName or artifactDirectoryPath", () => {
  const { modelName: _m, ...noModel } = base;
  const { artifactDirectoryPath: _a, ...noArtifacts } = base;
  expect(parseHookPayload("Stop", { ...noModel, ...stop })).toBeNull();
  expect(parseHookPayload("Stop", { ...noArtifacts, ...stop })).toBeNull();
});

test("rejects payloads missing the session fields or the tool call", () => {
  expect(parseHookPayload("Stop", { ...base, ...stop, conversationId: "" })).toBeNull();
  expect(parseHookPayload("Stop", { ...base, ...stop, workspacePaths: [1] })).toBeNull();
  expect(parseHookPayload("PreToolUse", base)).toBeNull();
  expect(parseHookPayload("PostToolUse", { ...base, toolCall: { name: "x" }, stepIdx: 1.5 })).toBeNull();
  expect(parseHookPayload("Stop", "not an object")).toBeNull();
});

test("a hook frame carries the event, the clock reading and the payload", () => {
  const line = `${HOOK_FRAME_TAG} PreToolUse 1700000000123 ${JSON.stringify({ ...base, toolCall: { name: "run_command", args: {} }, stepIdx: 0 })}`;
  expect(parseHookFrame(line)).toMatchObject({ event: "PreToolUse", receivedAt: 1700000000123 });
  expect(parseHookPayload("PreToolUse", parseHookFrame(line)?.payload)).toMatchObject({ event: "PreToolUse", conversationId: "c1" });
});

test("a frame with an unusable payload still arrives with its event", () => {
  expect(parseHookFrame(`${HOOK_FRAME_TAG} Stop 1700000000123 not json`)).toMatchObject({ event: "Stop", payload: null });
  expect(parseHookFrame(`${HOOK_FRAME_TAG} Stop 1700000000123 `)).toMatchObject({ event: "Stop", payload: null });
});

test("a frame with a bad clock reading is stamped on arrival", () => {
  const before = Date.now();
  const frame = parseHookFrame(`${HOOK_FRAME_TAG} Stop x {}`);
  expect(frame?.receivedAt).toBeGreaterThanOrEqual(before);
});

test("lines that are not frames are left to the JSON path", () => {
  expect(parseHookFrame('{"v":1,"id":"a","event":"Stop"}')).toBeNull();
  expect(parseHookFrame(`${HOOK_FRAME_TAG} SessionStart 1 {}`)).toBeNull();
  expect(parseHookFrame(`${HOOK_FRAME_TAG} Stop`)).toBeNull();
  expect(parseHookFrame("")).toBeNull();
});

test("the null response prints as nothing", () => {
  expect(hookResponseLine(null)).toBe("");
  expect(hookResponseLine({ decision: "allow" })).toBe('{"decision":"allow"}\n');
});
