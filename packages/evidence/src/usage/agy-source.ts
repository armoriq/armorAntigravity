import { Database } from "bun:sqlite";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "../io/http.ts";
import { canonicalModel } from "../model.ts";
import type { ConversationRef, SourceRead, SourceStep, UsageSource } from "./source.ts";

export type AgySourceOptions = {
  // agy's app data dir, ~/.gemini/antigravity-cli.
  readonly cliHome: string;
  // The transcript names no model; hook payloads carry it as `modelName`.
  readonly modelOf: (conversationId: string) => string | undefined;
};

type Summary = {
  readonly title: string;
  readonly at: number;
  readonly parentId: string;
  readonly workspacePaths: readonly string[];
};

const TRANSCRIPT = path.join(".system_generated", "logs", "transcript_full.jsonl");
const MAX_NESTING = 16;

// Reads agy's own files: token counts from transcript_full.jsonl, titles and subagent parents
// from conversation_summaries.db, with cache/conversation_metadata.json as the title fallback.
export function createAgySource(options: AgySourceOptions): UsageSource {
  const { cliHome, modelOf } = options;
  return {
    async read(ref) {
      const problems: string[] = [];
      const steps = await readSteps(ref.transcriptPath, canonicalModel(modelOf(ref.conversationId) ?? ""), problems);
      const appDir = appDirOf(ref.transcriptPath) ?? cliHome;
      const summaries = openSummaries(appDir, problems);
      try {
        const own = summaries?.get(ref.conversationId) ?? null;
        const title = own?.title ? { text: own.title, at: own.at } : await metadataTitle(appDir, ref.conversationId);
        return { steps, title, parentId: summaries ? rootAncestor(summaries, ref.conversationId) : null, problems };
      } finally {
        summaries?.close();
      }
    },
    async list() {
      const brain = path.join(cliHome, "brain");
      const entries = await readdir(brain, { withFileTypes: true }).catch(() => []);
      const summaries = openSummaries(cliHome, []);
      const metadata = await readMetadata(cliHome);
      try {
        const refs: ConversationRef[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const transcriptPath = path.join(brain, entry.name, TRANSCRIPT);
          // A brain dir with no transcript would count as unread and keep a history run open forever.
          if (!(await exists(transcriptPath))) continue;
          const workspacePaths = summaries?.get(entry.name)?.workspacePaths ?? metadataSummary(metadata, entry.name)?.workspacePaths ?? [];
          refs.push({ conversationId: entry.name, transcriptPath, workspacePaths, surface: "cli" });
        }
        return refs;
      } finally {
        summaries?.close();
      }
    },
  };
}

async function readSteps(transcriptPath: string, model: string, problems: string[]): Promise<SourceStep[]> {
  let text: string;
  try {
    text = await readFile(transcriptPath, "utf8");
  } catch (error) {
    problems.push(`${transcriptPath}: ${String(error)}`);
    return [];
  }
  const steps: SourceStep[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const value = parseJson(line);
    if (value === null) {
      const partial = i === lines.length - 1 ? " (still being written)" : "";
      problems.push(`${transcriptPath}: line ${i + 1} is not JSON${partial}`);
      continue;
    }
    const step = toStep(value, model);
    if (step) steps.push(step);
  }
  return steps;
}

function toStep(value: unknown, model: string): SourceStep | null {
  if (!isRecord(value) || value.type !== "PLANNER_RESPONSE") return null;
  // A running step's counts can still change, and the usage pump keeps the first count it sees per key.
  if (value.status === "RUNNING") return null;
  const { step_index, created_at, input_tokens, output_tokens, cache_read_tokens } = value;
  if (typeof step_index !== "number" || !Number.isInteger(step_index)) return null;
  if (typeof input_tokens !== "number" || typeof output_tokens !== "number") return null;
  const at = typeof created_at === "string" ? Date.parse(created_at) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const cacheRead = typeof cache_read_tokens === "number" ? cache_read_tokens : 0;
  return {
    key: String(step_index),
    model,
    at,
    // Already excludes cached tokens: a real step had input 2313, cache_read 14259, total 2611.
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    // output_tokens already includes thinking, and the transcript has no separate count.
    reasoningTokens: 0,
  };
}

// <appDir>/brain/<id>/.system_generated/logs/transcript_full.jsonl
function appDirOf(transcriptPath: string): string | null {
  const parts = transcriptPath.split(path.sep);
  const brain = parts.lastIndexOf("brain");
  return brain > 0 ? parts.slice(0, brain).join(path.sep) : null;
}

// The top conversation, so a nested subagent's usage still lands on the session the user started.
function rootAncestor(summaries: Summaries, conversationId: string): string | null {
  let root: string | null = null;
  let id = conversationId;
  for (let depth = 0; depth < MAX_NESTING; depth++) {
    const parent = summaries.get(id)?.parentId;
    if (!parent || parent === conversationId) break;
    root = id = parent;
  }
  return root;
}

type Summaries = { get(conversationId: string): Summary | null; close(): void };

function openSummaries(appDir: string, problems: string[]): Summaries | null {
  const file = path.join(appDir, "conversation_summaries.db");
  let db: Database;
  try {
    db = new Database(file, { readonly: true });
  } catch {
    // The db is in WAL mode: a read-only open needs agy's -shm file, which exists only while agy
    // runs. With agy stopped nothing is writing, so reading it as immutable is safe.
    try {
      db = new Database(`file:${file}?immutable=1`, { readonly: true });
    } catch (error) {
      if (!String(error).includes("unable to open")) problems.push(`${file}: ${String(error)}`);
      return null;
    }
  }
  try {
    const query = db.query("SELECT title, parent_conversation_id, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?");
    return {
      get: (conversationId) => toSummary(query.get(conversationId)),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    problems.push(`${file}: ${String(error)}`);
    return null;
  }
}

function toSummary(row: unknown): Summary | null {
  if (!isRecord(row)) return null;
  const { title, parent_conversation_id, workspace_uris, last_modified_time } = row;
  return {
    title: typeof title === "string" ? title.trim() : "",
    at: typeof last_modified_time === "string" ? timeOf(last_modified_time) : Date.now(),
    parentId: typeof parent_conversation_id === "string" ? parent_conversation_id : "",
    workspacePaths: typeof workspace_uris === "string" ? pathsOf(parseJson(workspace_uris)) : [],
  };
}

async function readMetadata(appDir: string): Promise<unknown> {
  return parseJson(await readFile(path.join(appDir, "cache", "conversation_metadata.json"), "utf8").catch(() => ""));
}

function metadataSummary(metadata: unknown, conversationId: string): { title: string; at: number; workspacePaths: readonly string[] } | null {
  if (!isRecord(metadata) || !isRecord(metadata.conversations)) return null;
  const conversation = metadata.conversations[conversationId];
  if (!isRecord(conversation) || !isRecord(conversation.summary)) return null;
  const { Title, UpdatedAt, WorkspaceURIs } = conversation.summary;
  return {
    title: typeof Title === "string" ? Title.trim() : "",
    at: typeof UpdatedAt === "string" ? timeOf(UpdatedAt) : Date.now(),
    workspacePaths: pathsOf(WorkspaceURIs),
  };
}

// The same rule as the SDK's antigravitySessionTitle: summary.Title, trimmed, when not empty.
async function metadataTitle(appDir: string, conversationId: string): Promise<{ text: string; at: number } | null> {
  const summary = metadataSummary(await readMetadata(appDir), conversationId);
  return summary?.title ? { text: summary.title, at: summary.at } : null;
}

function pathsOf(uris: unknown): string[] {
  if (!Array.isArray(uris)) return [];
  const out: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    try {
      out.push(fileURLToPath(uri));
    } catch {
      continue;
    }
  }
  return out;
}

function timeOf(text: string): number {
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : Date.now();
}

const exists = (file: string) => access(file).then(
  () => true,
  () => false,
);
