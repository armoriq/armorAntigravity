import { expect, test } from "bun:test";
import { sessionKey, surfaceFromTranscriptPath } from "../src/surface.ts";

const transcript = (dir: string) => `/Users/a/.gemini/${dir}/brain/c-1/.system_generated/logs/transcript.jsonl`;

test("each app data dir maps to its surface", () => {
  expect(surfaceFromTranscriptPath(transcript("antigravity"))).toBe("app");
  expect(surfaceFromTranscriptPath(transcript("antigravity-cli"))).toBe("cli");
  expect(surfaceFromTranscriptPath(transcript("antigravity-ide"))).toBe("ide");
});

test("only the dir that owns brain/ decides, so a workspace named antigravity does not", () => {
  expect(surfaceFromTranscriptPath("/work/antigravity/.gemini/antigravity-ide/brain/c/t.jsonl")).toBe("ide");
  expect(surfaceFromTranscriptPath("/work/antigravity/other/brain/c/t.jsonl")).toBe("unknown");
  expect(surfaceFromTranscriptPath("")).toBe("unknown");
});

test("the same conversation id on two surfaces gives two keys", () => {
  expect(String(sessionKey("cli", "c-1"))).toBe("cli:c-1");
  expect(sessionKey("cli", "c-1")).not.toBe(sessionKey("ide", "c-1"));
});
