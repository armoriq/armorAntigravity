import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Surface } from "@armorantigravity/protocol";
import { isRecord } from "../io/http.ts";
import type { ConversationRef, SourceRead, SourceStep, UsageSource } from "./source.ts";

// Layout and fields as captured from agy in the P0 spike (spike/FINDINGS.md #3 and #5):
// <dataDir>/brain/<id>/.system_generated/logs/transcript_full.jsonl holds one line per step, with
// token counts on PLANNER_RESPONSE lines and no model id; <dataDir>/conversation_summaries.db
// holds the title and, for subagents, parent_conversation_id.
export type TranscriptSourceOptions = {
  readonly dataDir?: string;
  readonly surface?: Surface;
};

export function defaultDataDir(): string {
  return path.join(homedir(), ".gemini", "antigravity-cli");
}

export function transcriptPathOf(dataDir: string, conversationId: string): string {
  return path.join(dataDir, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

type Summary = {
  readonly conversationId: string;
  readonly title: string;
  readonly parentId: string;
  readonly modifiedAt: number;
  readonly workspacePaths: readonly string[];
};

export function createTranscriptSource(options: TranscriptSourceOptions = {}): UsageSource {
  const dataDir = options.dataDir ?? defaultDataDir();
  const dbPath = path.join(dataDir, "conversation_summaries.db");

  // agy keeps the database in WAL mode, so each read opens and closes its own read-only handle
  // rather than holding one across agy's writes. With agy closed the -wal file is gone and a
  // read-only open fails; nothing is writing then, so the file can be read as immutable.
  // The failed open only surfaces on the first statement.
  function open(): Database {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      db.query("select 1").get();
      return db;
    } catch {
      db?.close();
      return new Database(`${pathToFileURL(dbPath).href}?immutable=1`, { readonly: true });
    }
  }

  function summaries(where: string, ...params: string[]): { rows: Summary[]; problem: string | null } {
    if (!existsSync(dbPath)) return { rows: [], problem: null };
    let db: Database | null = null;
    try {
      db = open();
      const raw = db
        .query(`select conversation_id, title, parent_conversation_id, last_modified_time, workspace_uris from conversation_summaries ${where}`)
        .all(...params);
      return { rows: raw.flatMap((r) => toSummary(r) ?? []), problem: null };
    } catch (error) {
      return { rows: [], problem: `conversation_summaries.db: ${String(error)}` };
    } finally {
      db?.close();
    }
  }

  return {
    async read(ref: ConversationRef): Promise<SourceRead> {
      const problems: string[] = [];
      const file = ref.transcriptPath || transcriptPathOf(dataDir, ref.conversationId);
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (!isMissing(error)) problems.push(`${file}: ${String(error)}`);
      }
      const parsed = parseTranscript(text, ref.model ?? "unknown");
      if (parsed.bad) problems.push(`${file}: ${parsed.bad} unreadable line(s)`);
      const { rows, problem } = summaries("where conversation_id = ?", ref.conversationId);
      if (problem) problems.push(problem);
      const row = rows[0];
      return {
        steps: parsed.steps,
        title: row?.title ? { text: row.title, at: row.modifiedAt || (parsed.steps.at(-1)?.at ?? Date.now()) } : null,
        parentId: row?.parentId || null,
        problems,
      };
    },

    // Only finished conversations: history reads carry no model, and the first stored copy of a
    // step wins, so reading a running one would label its steps "unknown" ahead of the live turn
    // end that knows the model. A running conversation is picked up by a later pass.
    async list(): Promise<readonly ConversationRef[]> {
      const { rows, problem } = summaries("where (status = 'CASCADE_RUN_STATUS_IDLE' and not not_fully_idle) or killed order by last_modified_time");
      if (problem) throw new Error(problem);
      return rows.map((r) => ({
        conversationId: r.conversationId,
        transcriptPath: transcriptPathOf(dataDir, r.conversationId),
        workspacePaths: r.workspacePaths,
        surface: options.surface ?? "cli",
        model: null,
      }));
    },
  };
}

// The transcript is appended while the agent runs, so a cut-off last line is expected and
// skipped quietly; only a bad line before the end is counted.
export function parseTranscript(text: string, model: string): { steps: SourceStep[]; bad: number } {
  const lines = text.split("\n");
  const last = lines.length - 1;
  const steps: SourceStep[] = [];
  let bad = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (i < last) bad++;
      return;
    }
    const step = toStep(value, model);
    if (step) steps.push(step);
  });
  return { steps, bad };
}

function toStep(value: unknown, model: string): SourceStep | null {
  if (!isRecord(value) || value.type !== "PLANNER_RESPONSE") return null;
  const index = value.step_index;
  const at = typeof value.created_at === "string" ? Date.parse(value.created_at) : Number.NaN;
  if (typeof index !== "number" || !Number.isFinite(at)) return null;
  // input_tokens excludes cache reads: a cached step reports a small input next to a large
  // cache_read_tokens that together match the previous step's context.
  return {
    key: `step-${index}`,
    model,
    at,
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    cacheReadTokens: count(value.cache_read_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

function toSummary(row: unknown): Summary | null {
  if (!isRecord(row) || typeof row.conversation_id !== "string" || !row.conversation_id) return null;
  // Rows agy has not stamped yet carry 0001-01-01, which Bun parses as 2001.
  const raw = row.last_modified_time;
  const modified = typeof raw === "string" && !raw.startsWith("0001-") ? Date.parse(raw) : Number.NaN;
  return {
    conversationId: row.conversation_id,
    title: typeof row.title === "string" ? row.title : "",
    parentId: typeof row.parent_conversation_id === "string" ? row.parent_conversation_id : "",
    modifiedAt: Number.isFinite(modified) ? modified : 0,
    workspacePaths: workspacePaths(row.workspace_uris),
  };
}

function workspacePaths(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  let uris: unknown;
  try {
    uris = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(uris)) return [];
  return uris.flatMap((u) => {
    if (typeof u !== "string" || !u.startsWith("file:")) return [];
    try {
      return [fileURLToPath(u)];
    } catch {
      return [];
    }
  });
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
