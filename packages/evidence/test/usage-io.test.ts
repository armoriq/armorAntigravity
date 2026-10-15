import { describe, expect, test } from "bun:test";
import { createUsageClient, parseSessionState } from "../src/io/backend-usage.ts";
import { repoOf, sessionTitle, toStepUsage } from "../src/usage/source.ts";
import { login, uploads } from "./support.ts";

const ROOT = "conv-root-7f3a";

describe("usage client", () => {
  test("holds titles back while the installed SDK refuses the antigravity title source", async () => {
    const up = uploads(() => null);
    const client = await createUsageClient(login("http://127.0.0.1:9"), up);
    // SDK 0.8.17 knows claude, codex and opencode sources only; registration is #43.
    expect(client.titles).toBe(false);
  });

  test("a session file that does not parse yields an empty state instead of throwing", () => {
    expect(parseSessionState(null)).toEqual({ steps: [] });
    expect(parseSessionState({ steps: [{ sessionId: 1 }], sentCalls: ["a", 2] })).toEqual({ steps: [] });
  });
});

describe("usage source helpers", () => {
  test("a subagent call is filed under the root and keyed by the child", () => {
    const step = toStepUsage(ROOT, "conv-child", { key: "k1", model: "gemini-3.8-flash", at: 5, inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, "");
    expect(step).toMatchObject({ sessionId: ROOT, messageId: "conv-child", partId: "k1" });
    expect(toStepUsage(ROOT, ROOT, { key: "k0", model: "m", at: 5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 9 }, "")).toBeNull();
  });

  test("repo is the workspace path, never a bare /", () => {
    expect(repoOf(["/Users/dev/repo"])).toBe("/Users/dev/repo");
    expect(repoOf(["/"])).toBe("");
    expect(repoOf([])).toBe("");
  });

  test("titles skip placeholders and carry the antigravity source", () => {
    expect(sessionTitle(ROOT, { text: "  New conversation ", at: 0 })).toBeNull();
    expect(sessionTitle(ROOT, { text: "Refactor   auth", at: 0 })).toEqual({ sessionId: ROOT, title: "Refactor auth", titleSource: "antigravity-session-title", titleUpdatedAt: new Date(0).toISOString() });
  });
});
