import {
  entriesDigest,
  hourKey,
  withLock,
  type Login,
  type SessionTitle,
  type StepUsage,
  type UsageCallSession,
  type UsageSnapshot,
} from "@armorantigravity/core";
import type { RecordTokenLatencyPayload, TokenUsageBatch, TokenUsageSessionTitle, UsageCallResult, UsageRunReport } from "@armoriq/sdk-dev";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT, TITLE_SOURCE, type Uploads } from "../context.ts";
import { isRecord } from "./http.ts";

export type UsageBatch = {
  generation: string;
  batchId: string;
  runId?: string;
  deviceName?: string;
  snapshots: UsageSnapshot[];
  calls: UsageCallSession[];
  sessions: SessionTitle[];
};

export type UsageResult<T> =
  | { ok: true; value: T }
  | { ok: false; status?: number; retryable: boolean; retryAfterMs?: number; reason: string; relogin?: boolean };

export interface UsageClient {
  // False while the installed SDK refuses this product's title source client-side; titles then
  // stay unsent instead of being recorded as refused.
  readonly titles: boolean;
  initialize(): Promise<UsageResult<{ generation: string }>>;
  send(batch: UsageBatch): Promise<UsageResult<unknown>>;
  reportRun(runId: string, report: UsageRunReport): Promise<UsageResult<{ historyCompleted: boolean }>>;
  recordLatency(payload: RecordTokenLatencyPayload): Promise<UsageResult<unknown>>;
}

const AUTH_STATUSES = new Set([401, 402, 403]);

export const isFenced = (r: UsageResult<unknown>) => !r.ok && r.status === 409 && /generation/i.test(r.reason);

// The SDK client is loaded only from a pump, never on the hook path.
export async function createUsageClient(login: Login, uploads: Uploads): Promise<UsageClient> {
  const sdk = await import("@armoriq/sdk-dev");
  const client = new sdk.ArmorIQClient({ apiKey: login.apiKey, backendEndpoint: login.backend, product: PRODUCT, client: uploads.client });
  const result = <T>(r: UsageCallResult<T>): UsageResult<T> => {
    if (r.ok) return { ok: true, value: r.value };
    if (r.status !== undefined) uploads.report(r.status, r.reloginRequired ? { error: "relogin_required" } : { message: r.reason });
    return {
      ok: false,
      ...(r.status === undefined ? {} : { status: r.status }),
      // The SDK treats 401, 402 and 403 as final, but they describe the key or the account, not the
      // usage: refusing would set those hours aside for good. Hold them until the key works again.
      retryable: r.retryable || (r.status !== undefined && AUTH_STATUSES.has(r.status)),
      ...(r.retryAfterMs === undefined ? {} : { retryAfterMs: r.retryAfterMs }),
      reason: r.reason,
      ...(r.reloginRequired ? { relogin: true } : {}),
    };
  };
  const titles = await titleSourceAccepted();
  return {
    titles,
    initialize: async () => result(await client.initializeUsageStream()),
    send: async (batch) => result(await client.recordTokenUsageBatch(toSdkBatch(batch, titles))),
    async reportRun(runId, report) {
      const r = result(await client.reportUsageRun(runId, report));
      if (!r.ok) return r;
      // conmap marks the device's history request done on the run's complete report.
      const run: unknown = isRecord(r.value) ? r.value.run : null;
      return { ok: true, value: { historyCompleted: isRecord(run) && typeof run.completedAt === "string" } };
    },
    async recordLatency(payload) {
      const r = await client.recordTokenLatency(payload);
      if (r.ok) return { ok: true, value: null };
      return { ok: false, retryable: true, reason: r.reason ?? "latency upload failed", ...(r.status === undefined ? {} : { status: r.status }) };
    },
  };
}

type SdkTitleSource = TokenUsageSessionTitle["titleSource"];

// The SDK checks titleSource against its own list before any request. Asking it, rather than
// pinning a version, lets a newer SDK that knows this product's source enable titles unchanged.
async function titleSourceAccepted(): Promise<boolean> {
  const { batchError } = await import("@armoriq/sdk-dev/dist/usage_sync.js");
  const id = randomUUID();
  const title = { sessionId: "probe", title: "probe", titleSource: TITLE_SOURCE, titleUpdatedAt: new Date().toISOString() };
  // Deliberately outside the SDK's type: the probe asks whether its runtime list has the source.
  const error = batchError({ generation: id, batchId: id, snapshots: [], sessions: [title] } as unknown as TokenUsageBatch);
  return !(typeof error === "string" && error.includes("titleSource"));
}

function toSdkBatch(batch: UsageBatch, titles: boolean): TokenUsageBatch {
  // Only reached when titleSourceAccepted() saw the SDK accept TITLE_SOURCE, the one source queued.
  const sessions = titles ? batch.sessions.map((t) => ({ ...t, titleSource: t.titleSource as SdkTitleSource })) : [];
  return { ...batch, sessions };
}

export const newBatchId = () => randomUUID();

// One directory per backend, product, user and device, as ArmorClaude live-usage liveDir.
export function scopeDir(dataDir: string, login: Login): string {
  const id = createHash("sha256")
    .update(JSON.stringify([login.backend, PRODUCT, login.userId, login.deviceId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(dataDir, "usage", id);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

type Stream = { generation?: string; revision?: number };

function parseStream(raw: unknown): Stream {
  if (!isRecord(raw)) return {};
  return {
    ...(typeof raw.generation === "string" ? { generation: raw.generation } : {}),
    ...(typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) ? { revision: raw.revision } : {}),
  };
}

const streamFile = (dir: string) => path.join(dir, "stream.json");
const streamLock = (dir: string) => path.join(dir, "stream.lock");

export function allocateRevision(dir: string): Promise<number> {
  return withLock(streamLock(dir), async () => {
    const stream = parseStream(await readJson(streamFile(dir)));
    const revision = (stream.revision ?? 0) + 1;
    await writeJson(streamFile(dir), { ...stream, revision });
    return revision;
  });
}

export async function storedGeneration(dir: string): Promise<string | null> {
  return parseStream(await readJson(streamFile(dir))).generation ?? null;
}

export function setGeneration(dir: string, generation: string): Promise<void> {
  return withLock(streamLock(dir), async () => {
    await writeJson(streamFile(dir), { ...parseStream(await readJson(streamFile(dir))), generation });
  });
}

export type SessionState = {
  steps: StepUsage[];
  generation?: string;
  acknowledged?: Record<string, string>;
  refused?: Record<string, string>;
  sentCalls?: string[];
  refusedCalls?: string[];
  title?: SessionTitle;
  sentTitle?: string;
  refusedTitle?: string;
};

const stringRecord = (v: unknown): Record<string, string> | undefined =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined;
const stringList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map(String) : undefined);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function parseStep(v: unknown): StepUsage | null {
  if (!isRecord(v) || !isRecord(v.entry)) return null;
  const { sessionId, messageId, partId, at, repo, reasoningTokens } = v;
  const e = v.entry;
  const tokens = [count(e.inputTokens), count(e.outputTokens), count(e.cacheReadTokens), count(e.cacheWriteTokens)] as const;
  if (typeof sessionId !== "string" || typeof messageId !== "string" || typeof partId !== "string" || typeof repo !== "string") return null;
  if (typeof e.model !== "string" || count(at) === null || tokens.some((t) => t === null)) return null;
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = tokens.map(Number);
  return {
    sessionId: sessionId as StepUsage["sessionId"],
    messageId,
    partId,
    at: Number(at),
    repo,
    entry: { model: e.model, inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0, cacheWriteTokens: cacheWriteTokens ?? 0 },
    reasoningTokens: count(reasoningTokens) ?? 0,
  };
}

function parseTitle(v: unknown): SessionTitle | undefined {
  if (!isRecord(v)) return undefined;
  const { sessionId, title, titleSource, titleUpdatedAt } = v;
  if (typeof sessionId !== "string" || typeof title !== "string" || typeof titleSource !== "string" || typeof titleUpdatedAt !== "string") return undefined;
  return { sessionId, title, titleSource, titleUpdatedAt };
}

export function parseSessionState(raw: unknown): SessionState {
  if (!isRecord(raw)) return { steps: [] };
  const steps = Array.isArray(raw.steps) ? raw.steps.map(parseStep).filter((s): s is StepUsage => s !== null) : [];
  const out: SessionState = { steps };
  if (typeof raw.generation === "string") out.generation = raw.generation;
  const acknowledged = stringRecord(raw.acknowledged);
  if (acknowledged) out.acknowledged = acknowledged;
  const refused = stringRecord(raw.refused);
  if (refused) out.refused = refused;
  const sentCalls = stringList(raw.sentCalls);
  if (sentCalls) out.sentCalls = sentCalls;
  const refusedCalls = stringList(raw.refusedCalls);
  if (refusedCalls) out.refusedCalls = refusedCalls;
  const title = parseTitle(raw.title);
  if (title) out.title = title;
  if (typeof raw.sentTitle === "string") out.sentTitle = raw.sentTitle;
  if (typeof raw.refusedTitle === "string") out.refusedTitle = raw.refusedTitle;
  return out;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const sessionName = (id: string) => (SAFE_ID.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 40));
const sessionsDir = (dir: string) => path.join(dir, "sessions");
const sessionFile = (dir: string, id: string) => path.join(sessionsDir(dir), `${sessionName(id)}.json`);

export async function readSession(dir: string, id: string): Promise<SessionState> {
  return parseSessionState(await readJson(sessionFile(dir, id)));
}

export function updateSession<T>(dir: string, id: string, fn: (state: SessionState) => Promise<[SessionState, T]>): Promise<T> {
  return withLock(path.join(sessionsDir(dir), `${sessionName(id)}.lock`), async () => {
    const [next, out] = await fn(await readSession(dir, id));
    await writeJson(sessionFile(dir, id), next);
    return out;
  });
}

export function mergeSteps(state: SessionState, steps: readonly StepUsage[]): SessionState {
  const seen = new Set(state.steps.map((s) => `${s.messageId}:${s.partId}`));
  const added: StepUsage[] = [];
  for (const s of steps) {
    const key = `${s.messageId}:${s.partId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(s);
  }
  return added.length ? { ...state, steps: [...state.steps, ...added] } : state;
}

export const acknowledgedIn = (state: SessionState, generation: string) => (state.generation === generation ? (state.acknowledged ?? {}) : {});
export const sentCallsIn = (state: SessionState, generation: string) => (state.generation === generation ? (state.sentCalls ?? []) : []);
export const sentTitleIn = (state: SessionState, generation: string) => (state.generation === generation ? state.sentTitle : undefined);

export type Sent = { snapshots: readonly UsageSnapshot[]; callKeys: readonly string[]; title?: string };

export function acknowledge(state: SessionState, generation: string, sent: Sent): SessionState {
  const acknowledged = { ...acknowledgedIn(state, generation) };
  for (const s of sent.snapshots) acknowledged[hourKey(s)] = entriesDigest(s.entries);
  const sentCalls = [...new Set([...sentCallsIn(state, generation), ...sent.callKeys])];
  const sentTitle = sent.title ?? sentTitleIn(state, generation);
  return { ...state, generation, acknowledged, sentCalls, ...(sentTitle === undefined ? {} : { sentTitle }) };
}

export function refuse(state: SessionState, sent: Sent): SessionState {
  const refused = { ...state.refused };
  for (const s of sent.snapshots) refused[hourKey(s)] = entriesDigest(s.entries);
  const refusedCalls = [...new Set([...(state.refusedCalls ?? []), ...sent.callKeys])];
  return { ...state, refused, refusedCalls, ...(sent.title === undefined ? {} : { refusedTitle: sent.title }) };
}

// conmap keeps a stored title unless the new one is strictly newer.
export function noteTitle(state: SessionState, title: SessionTitle): SessionState {
  if (state.title?.title === title.title) return state;
  const floor = state.title ? Date.parse(state.title.titleUpdatedAt) + 1 : 0;
  const at = Math.max(Date.parse(title.titleUpdatedAt), floor);
  return { ...state, title: { ...title, titleUpdatedAt: new Date(at).toISOString() } };
}

export async function storedSessionIds(dir: string, maxAgeMs: number): Promise<string[]> {
  const ids: string[] = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const name of await readdir(sessionsDir(dir)).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(sessionsDir(dir), name);
    const st = await stat(file).catch(() => null);
    if (!st) continue;
    if (st.mtimeMs < cutoff) {
      await unlink(file).catch(() => {});
      continue;
    }
    const state = parseSessionState(await readJson(file));
    const id = state.steps[0]?.sessionId ?? state.title?.sessionId;
    if (id) ids.push(id);
  }
  return ids;
}

const QUEUED = /^\d{16}-[0-9a-f-]{36}\.json$/;
const queueDir = (dir: string) => path.join(dir, "queue");
let lastOrder = 0;

export type QueuedBatch = { batch: UsageBatch; file: string };

export async function enqueueBatches(dir: string, batches: readonly UsageBatch[]): Promise<void> {
  for (const batch of batches) {
    lastOrder = Math.max(lastOrder + 1, Date.now() * 1000);
    await writeJson(path.join(queueDir(dir), `${String(lastOrder).padStart(16, "0")}-${batch.batchId}.json`), { batch });
  }
}

export async function queuedBatches(dir: string): Promise<QueuedBatch[]> {
  const names = (await readdir(queueDir(dir)).catch(() => [] as string[])).filter((n) => QUEUED.test(n)).sort();
  const items: QueuedBatch[] = [];
  for (const name of names) {
    const file = path.join(queueDir(dir), name);
    // A read error leaves the file for a later pass; only content that does not parse is dropped,
    // since writeJson never leaves a partial file.
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const batch = parseQueued(text);
    if (batch) items.push({ batch, file });
    else await unlink(file).catch(() => {});
  }
  return items;
}

// The queue is written only by this module, so a structural check of the envelope is enough.
function parseQueued(text: string): UsageBatch | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.batch)) return null;
  const b = raw.batch;
  if (typeof b.generation !== "string" || typeof b.batchId !== "string") return null;
  if (!Array.isArray(b.snapshots) || !Array.isArray(b.calls) || !Array.isArray(b.sessions)) return null;
  return {
    generation: b.generation,
    batchId: b.batchId,
    ...(typeof b.runId === "string" ? { runId: b.runId } : {}),
    ...(typeof b.deviceName === "string" ? { deviceName: b.deviceName } : {}),
    snapshots: b.snapshots.filter(isSnapshot),
    calls: b.calls.filter(isCallSession),
    sessions: b.sessions.map(parseTitle).filter((t): t is SessionTitle => t !== undefined),
  };
}

function isSnapshot(v: unknown): v is UsageSnapshot {
  return isRecord(v) && typeof v.sessionId === "string" && typeof v.usageDate === "string" && typeof v.usageHour === "number" && Array.isArray(v.entries);
}

function isCallSession(v: unknown): v is UsageCallSession {
  return isRecord(v) && typeof v.sessionId === "string" && Array.isArray(v.records) && v.records.every((r) => isRecord(r) && typeof r.key === "string");
}

export const settle = (file: string) => unlink(file).catch(() => {});

export async function clearQueue(dir: string): Promise<void> {
  for (const { file } of await queuedBatches(dir)) await settle(file);
}

export const queueLockPath = (dir: string) => path.join(dir, "queue.lock");

export async function setAside(dir: string, item: QueuedBatch, reason: string): Promise<void> {
  await writeJson(path.join(queueDir(dir), "refused", path.basename(item.file)), { ...item, refused: reason });
  await settle(item.file);
}
