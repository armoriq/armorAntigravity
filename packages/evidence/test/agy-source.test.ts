import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgySource } from "../src/usage/agy-source.ts";
import type { ConversationRef } from "../src/usage/source.ts";

// A real agy 1.3.3 print-mode run; content fields trimmed, token counts untouched. agy's own
// stream-json result for it: input 77013, output 2652, cache_read 14259, total 79665.
const CONVERSATION = "27fc2833-559f-45ea-a6fb-1cb2c0d049cd";
const FIXTURE = path.join(import.meta.dir, "fixtures", "agy");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function cliHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "agy-source-"));
  homes.push(home);
  cpSync(FIXTURE, home, { recursive: true });
  return home;
}

function ref(home: string, conversationId = CONVERSATION): ConversationRef {
  return {
    conversationId,
    transcriptPath: path.join(home, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
    workspacePaths: [],
    surface: "cli",
  };
}

function summaries(home: string, rows: { id: string; title: string; parent: string }[]): void {
  const db = new Database(path.join(home, "conversation_summaries.db"));
  db.run(
    "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', last_modified_time datetime NOT NULL)",
  );
  for (const row of rows) {
    db.run("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)", [row.id, row.title, '["file:///tmp/agy-demo/ws"]', row.parent, "2026-10-12T20:05:00Z"]);
  }
  db.close();
}

describe("agy transcript source", () => {
  test("token totals match agy's own result; cached tokens are counted apart from input", async () => {
    const home = cliHome();
    const read = await createAgySource({ cliHome: home, modelOf: () => "gemini-3.8-flash-high" }).read(ref(home));
    const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens") => read.steps.reduce((n, s) => n + s[k], 0);
    expect(read.problems).toEqual([]);
    expect(sum("inputTokens")).toBe(77013);
    expect(sum("cacheReadTokens")).toBe(14259);
    expect(sum("outputTokens")).toBe(2652);
    expect(new Set(read.steps.map((s) => s.model))).toEqual(new Set(["gemini-3.8-flash"]));
    expect(new Set(read.steps.map((s) => s.key)).size).toBe(read.steps.length);
  });

  test("a model never seen in a hook is unknown", async () => {
    const home = cliHome();
    const read = await createAgySource({ cliHome: home, modelOf: () => undefined }).read(ref(home));
    expect(read.steps.every((s) => s.model === "unknown")).toBe(true);
  });

  test("a half-written last line is reported, not thrown, and earlier steps still count", async () => {
    const home = cliHome();
    appendFileSync(ref(home).transcriptPath, '{"step_index":99,"type":"PLANNER_RESPONSE","input_tok');
    const read = await createAgySource({ cliHome: home, modelOf: () => "gemini-3.8-flash-high" }).read(ref(home));
    expect(read.steps.reduce((n, s) => n + s.outputTokens, 0)).toBe(2652);
    expect(read.problems).toHaveLength(1);
  });

  test("a missing transcript gives no steps and one problem", async () => {
    const home = cliHome();
    const read = await createAgySource({ cliHome: home, modelOf: () => undefined }).read(ref(home, "no-such-conversation"));
    expect(read.steps).toEqual([]);
    expect(read.problems).toHaveLength(1);
  });

  test("a subagent resolves to its root conversation and has no title of its own", async () => {
    const home = cliHome();
    summaries(home, [
      { id: "root", title: "README And CHANGELOG Summary", parent: "" },
      { id: "child", title: "", parent: "root" },
      { id: CONVERSATION, title: "", parent: "child" },
    ]);
    const source = createAgySource({ cliHome: home, modelOf: () => undefined });
    const read = await source.read(ref(home));
    expect(read.parentId).toBe("root");
    expect(read.title).toBeNull();
    const listed = await source.list();
    expect(listed.map((r) => r.conversationId)).toEqual([CONVERSATION]);
    expect(listed[0]?.workspacePaths).toEqual(["/tmp/agy-demo/ws"]);
  });
});
