import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTranscriptSource, parseTranscript, transcriptPathOf } from "../src/usage/transcript.ts";
import type { ConversationRef } from "../src/usage/source.ts";
import { tempDir } from "./support.ts";

// Captured from agy in the P0 spike: a root conversation, one of its subagents, the summaries
// rows for them, and the summaries table's own CREATE statement.
const FIXTURES = path.join(import.meta.dir, "fixtures", "agy");
const ROOT = "1fea794d-29ad-455a-a5c9-5d9a8e90c7c0";
const CHILD = "b82464e5-3392-4925-8772-4bda03973e9f";
const PARENT = "95c0238a-147e-4adc-942e-376c18a16f42";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function dataDir(withDb = true): string {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  for (const id of [ROOT, CHILD]) {
    const file = transcriptPathOf(tmp.dir, id);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(path.join(FIXTURES, `${id.slice(0, 8)}-transcript_full.jsonl`), file);
  }
  if (withDb) {
    const db = new Database(path.join(tmp.dir, "conversation_summaries.db"));
    db.run(readFileSync(path.join(FIXTURES, "conversation_summaries.schema.sql"), "utf8"));
    const rows: Record<string, string | number>[] = JSON.parse(readFileSync(path.join(FIXTURES, "conversation_summaries-sample.json"), "utf8"));
    const insert = db.prepare(
      "insert into conversation_summaries (conversation_id, title, step_count, status, agent_name, parent_conversation_id, nesting_depth, workspace_uris, project_id, app_data_dir, last_modified_time, last_user_input_time) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Both timestamp forms agy writes: a stamped row and the zero value of one it has not stamped.
    for (const r of rows) {
      const stamped = r.conversation_id === ROOT ? "2026-10-12 14:02:21.5+00:00" : "0001-01-01 00:00:00+00:00";
      insert.run(r.conversation_id!, r.title!, r.step_count!, r.status!, r.agent_name!, r.parent_conversation_id!, r.nesting_depth!, r.workspace_uris!, r.project_id!, r.app_data_dir!, stamped, stamped);
    }
    db.close();
  }
  return tmp.dir;
}

const ref = (dir: string, conversationId: string, model: string | null = "gemini-3.8-flash-high"): ConversationRef => ({
  conversationId,
  transcriptPath: transcriptPathOf(dir, conversationId),
  workspacePaths: ["/private/tmp/agspike/ws"],
  surface: "cli",
  model,
});

test("reads every model step of a captured transcript with its tokens", async () => {
  const dir = dataDir();
  const read = await createTranscriptSource({ dataDir: dir }).read(ref(dir, ROOT));

  expect(read.problems).toEqual([]);
  expect(read.steps.map((s) => s.key)).toEqual(["step-1", "step-3", "step-5", "step-7", "step-9", "step-11", "step-13"]);
  expect(read.steps[0]).toEqual({
    key: "step-1",
    model: "gemini-3.8-flash-high",
    at: Date.parse("2026-10-12T14:00:33Z"),
    inputTokens: 12_761,
    outputTokens: 423,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  expect(read.steps.at(-1)).toMatchObject({ inputTokens: 5_134, cacheReadTokens: 17_966, outputTokens: 205 });
  expect(read.title).toEqual({ text: "Sequential Multi-Tool Execution Tasks", at: Date.parse("2026-10-12T14:02:21.5Z") });
  expect(read.parentId).toBeNull();
});

test("a subagent names its parent and has no title of its own", async () => {
  const dir = dataDir();
  const read = await createTranscriptSource({ dataDir: dir }).read(ref(dir, CHILD));

  expect(read.parentId).toBe(PARENT);
  expect(read.title).toBeNull();
  expect(read.steps).toHaveLength(4);
});

test("without the summaries database the steps still read, with no title or parent", async () => {
  const dir = dataDir(false);
  const read = await createTranscriptSource({ dataDir: dir }).read(ref(dir, CHILD, null));

  expect(read).toMatchObject({ title: null, parentId: null, problems: [] });
  expect(read.steps.every((s) => s.model === "unknown")).toBe(true);
});

test("a conversation with no transcript yet reads as empty, not as a problem", async () => {
  const dir = dataDir();
  const read = await createTranscriptSource({ dataDir: dir }).read(ref(dir, "3afe252b-10dc-4b17-85fc-e3f3a5f5c391"));

  expect(read).toMatchObject({ steps: [], problems: [] });
});

test("a line cut off mid-write is skipped quietly, a bad line before it is reported", () => {
  const lines = readFileSync(path.join(FIXTURES, "b82464e5-transcript_full.jsonl"), "utf8").trimEnd().split("\n");
  const last = lines.at(-1)!;

  const cut = parseTranscript([...lines.slice(0, -1), last.slice(0, 40)].join("\n"), "m");
  expect(cut).toMatchObject({ bad: 0 });
  expect(cut.steps).toHaveLength(3);

  const broken = parseTranscript(["{not json", ...lines].join("\n"), "m");
  expect(broken.bad).toBe(1);
  expect(broken.steps).toHaveLength(4);
});

test("list() returns every conversation with its brain transcript and workspace paths", async () => {
  const dir = dataDir();
  const refs = await createTranscriptSource({ dataDir: dir }).list();

  expect(refs.map((r) => r.conversationId).sort()).toEqual([ROOT, "3afe252b-10dc-4b17-85fc-e3f3a5f5c391", PARENT, CHILD].sort());
  expect(refs.find((r) => r.conversationId === ROOT)).toEqual({
    conversationId: ROOT,
    transcriptPath: transcriptPathOf(dir, ROOT),
    workspacePaths: ["/private/tmp/agspike/ws"],
    surface: "cli",
    model: null,
  });
});

test("list() fails loudly on an unreadable database so the history run reports it", async () => {
  const dir = dataDir(false);
  writeFileSync(path.join(dir, "conversation_summaries.db"), "not a database");

  await expect(createTranscriptSource({ dataDir: dir }).list()).rejects.toThrow("conversation_summaries.db");
});

const summariesDb = (dir: string) => path.join(dir, "conversation_summaries.db");

test("with agy closed and its -wal file gone, the database still reads", async () => {
  const dir = dataDir();
  const db = new Database(summariesDb(dir));
  db.run("pragma journal_mode = wal");
  db.close();
  for (const side of ["-wal", "-shm"]) rmSync(summariesDb(dir) + side, { force: true });
  expect(() => new Database(summariesDb(dir), { readonly: true }).query("select 1").get()).toThrow();

  const source = createTranscriptSource({ dataDir: dir });
  expect((await source.read(ref(dir, CHILD))).parentId).toBe(PARENT);
  expect(await source.list()).toHaveLength(4);
  expect(existsSync(summariesDb(dir) + "-wal")).toBe(false);
});

test("list() leaves out a conversation that is still running", async () => {
  const dir = dataDir();
  const db = new Database(summariesDb(dir));
  db.run("update conversation_summaries set not_fully_idle = true where conversation_id = ?", [PARENT]);
  db.close();

  const ids = (await createTranscriptSource({ dataDir: dir }).list()).map((r) => r.conversationId);
  expect(ids).not.toContain(PARENT);
  expect(ids).toContain(ROOT);
});

test("a title on a row agy has not stamped yet takes the last step's time", async () => {
  const dir = dataDir();
  const db = new Database(summariesDb(dir));
  db.run("update conversation_summaries set title = 'Sub task' where conversation_id = ?", [CHILD]);
  db.close();

  const read = await createTranscriptSource({ dataDir: dir }).read(ref(dir, CHILD));
  expect(read.title).toEqual({ text: "Sub task", at: read.steps.at(-1)!.at });
});
