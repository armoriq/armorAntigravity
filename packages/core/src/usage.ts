import { createHash } from "node:crypto";
import type { SessionID, StepUsage, TokenUsageEntry } from "./types.ts";

// SDK 0.8.17 usage_sync limits, pinned here so this module never loads the SDK; test/core/usage.test.ts checks them.
export const MAX_BATCH_SNAPSHOTS = 100;
export const MAX_BATCH_ENTRIES = 500;
export const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_SESSIONS = 100;
const MAX_TEXT_CHARS = 200;

export type HourKey = { sessionId: SessionID; usageDate: string; usageHour: number };

export type HourBucket = HourKey & { repo: string; entries: TokenUsageEntry[]; digest: string };

export type UsageSnapshot = {
  sessionId: string;
  usageDate: string;
  usageHour: number;
  revision: number;
  armored: true;
  repo?: string;
  entries: TokenUsageEntry[];
};

export const hourKey = (h: { usageDate: string; usageHour: number }) =>
  `${h.usageDate}T${String(h.usageHour).padStart(2, "0")}`;

export const entriesDigest = (entries: readonly TokenUsageEntry[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");

const hourOf = (at: number) => {
  const iso = new Date(at).toISOString();
  return { usageDate: iso.slice(0, 10), usageHour: Number(iso.slice(11, 13)) };
};

const sessionHour = (sessionId: string, h: { usageDate: string; usageHour: number }) => `${sessionId}\n${hourKey(h)}`;

export function bucketByHour(steps: readonly StepUsage[]): HourBucket[] {
  const hours = new Map<string, { key: HourKey; repo: string; models: Map<string, TokenUsageEntry> }>();
  for (const step of steps) {
    const key: HourKey = { sessionId: step.sessionId, ...hourOf(step.at) };
    const id = sessionHour(key.sessionId, key);
    let hour = hours.get(id);
    if (!hour) hours.set(id, (hour = { key, repo: step.repo, models: new Map() }));
    const sum = hour.models.get(step.entry.model);
    if (!sum) hour.models.set(step.entry.model, { ...step.entry });
    else {
      sum.inputTokens += step.entry.inputTokens;
      sum.outputTokens += step.entry.outputTokens;
      sum.cacheReadTokens += step.entry.cacheReadTokens;
      sum.cacheWriteTokens += step.entry.cacheWriteTokens;
    }
  }
  return [...hours.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { key, repo, models }]) => {
      const entries = [...models.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
      return { ...key, repo, entries, digest: entriesDigest(entries) };
    });
}

export function changedBuckets(buckets: readonly HourBucket[], known: Readonly<Record<string, string>>): HourBucket[] {
  return buckets.filter((b) => known[hourKey(b)] !== b.digest);
}

export function toSnapshots(buckets: readonly HourBucket[], revision: number): UsageSnapshot[] {
  return buckets.map((b) => ({
    sessionId: b.sessionId,
    usageDate: b.usageDate,
    usageHour: b.usageHour,
    revision,
    armored: true,
    ...(b.repo ? { repo: clip(b.repo) } : {}),
    entries: b.entries,
  }));
}

function clip(text: string): string {
  const cut = text.slice(0, MAX_TEXT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type UsageCallRecord = TokenUsageEntry & { key: string; reasoningOutputTokens: number; occurredAt: string };

export type UsageCallSession = { sessionId: string; armored: true; repo?: string; records: UsageCallRecord[] };

export type SessionTitle = { sessionId: string; title: string; titleSource: string; titleUpdatedAt: string };

export type UsageParts = { snapshots: UsageSnapshot[]; calls: UsageCallSession[]; sessions: SessionTitle[] };

// Null for a blank title; the caller skips its host's placeholder titles first.
export function sessionTitle(sessionId: string, title: string, titleSource: string, at: number): SessionTitle | null {
  const text = title.trim();
  if (!text) return null;
  return { sessionId, title: clip(text), titleSource, titleUpdatedAt: new Date(at).toISOString() };
}

export const callKey = (step: Pick<StepUsage, "messageId" | "partId">) => `${step.messageId}:${step.partId}`;

const recordCount = (calls: readonly UsageCallSession[]) => calls.reduce((n, c) => n + c.records.length, 0);

function callSessions(steps: readonly StepUsage[]): UsageCallSession[] {
  const [first] = steps;
  if (!first) return [];
  const records = steps.map((s) => ({
    key: callKey(s),
    ...s.entry,
    reasoningOutputTokens: s.reasoningTokens,
    occurredAt: new Date(s.at).toISOString(),
  }));
  return [{ sessionId: first.sessionId, armored: true, ...(first.repo ? { repo: clip(first.repo) } : {}), records }];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Each changed session-hour's snapshot travels with that hour's new call records; records of an
// unchanged hour, and an hour's records beyond one batch, travel without a snapshot.
export function toParts(snapshots: readonly UsageSnapshot[], steps: readonly StepUsage[], titles: readonly SessionTitle[] = []): UsageParts[] {
  const byHour = new Map<string, StepUsage[]>();
  for (const s of steps) {
    const id = sessionHour(s.sessionId, hourOf(s.at));
    const list = byHour.get(id);
    if (list) list.push(s);
    else byHour.set(id, [s]);
  }
  const parts: UsageParts[] = [];
  for (const snapshot of snapshots) {
    const id = sessionHour(snapshot.sessionId, snapshot);
    const [first = [], ...rest] = chunks(byHour.get(id) ?? [], MAX_BATCH_ENTRIES);
    byHour.delete(id);
    parts.push({ snapshots: [snapshot], calls: callSessions(first), sessions: [] });
    for (const c of rest) parts.push({ snapshots: [], calls: callSessions(c), sessions: [] });
  }
  for (const left of byHour.values()) for (const c of chunks(left, MAX_BATCH_ENTRIES)) parts.push({ snapshots: [], calls: callSessions(c), sessions: [] });
  for (const title of titles) parts.push({ snapshots: [], calls: [], sessions: [title] });
  return parts;
}

// A refused batch is resent one session-hour at a time, each snapshot with its own hour's records.
export function splitParts(batch: UsageParts): UsageParts[] {
  let left = batch.calls;
  const inHour = (r: UsageCallRecord, s: UsageSnapshot) => hourKey(hourOf(Date.parse(r.occurredAt))) === hourKey(s);
  const parts = batch.snapshots.map((snapshot) => {
    const own = left.filter((c) => c.sessionId === snapshot.sessionId);
    const calls = own.map((c) => ({ ...c, records: c.records.filter((r) => inHour(r, snapshot)) })).filter((c) => c.records.length);
    left = left.map((c) => (c.sessionId === snapshot.sessionId ? { ...c, records: c.records.filter((r) => !inHour(r, snapshot)) } : c));
    return { snapshots: [snapshot], calls, sessions: [] };
  });
  const callsOnly = left.filter((c) => c.records.length).map((c) => ({ snapshots: [], calls: [c], sessions: [] }));
  return [...parts, ...callsOnly, ...batch.sessions.map((title) => ({ snapshots: [], calls: [], sessions: [title] }))];
}

type Load = { entries: number; records: number; bytes: number };

const emptyParts = (): UsageParts => ({ snapshots: [], calls: [], sessions: [] });
const isEmpty = (p: UsageParts) => !p.snapshots.length && !p.calls.length && !p.sessions.length;

function loadOf(p: UsageParts): Load {
  const entries = p.snapshots.reduce((n, s) => n + s.entries.length, 0);
  return { entries, records: recordCount(p.calls), bytes: Buffer.byteLength(JSON.stringify(p)) + 1 };
}

function fits(batch: UsageParts, load: Load, p: UsageParts, add: Load): boolean {
  return (
    batch.snapshots.length + p.snapshots.length <= MAX_BATCH_SNAPSHOTS &&
    batch.calls.length + p.calls.length <= MAX_BATCH_SESSIONS &&
    batch.sessions.length + p.sessions.length <= MAX_BATCH_SESSIONS &&
    load.entries + add.entries <= MAX_BATCH_ENTRIES &&
    load.records + add.records <= MAX_BATCH_ENTRIES &&
    load.bytes + add.bytes <= MAX_BATCH_BYTES
  );
}

export function packBatches(parts: readonly UsageParts[], overheadBytes = 512): UsageParts[] {
  const batches: UsageParts[] = [];
  const fresh = (): Load => ({ entries: 0, records: 0, bytes: overheadBytes });
  let current = emptyParts();
  let load = fresh();
  for (const p of parts) {
    const add = loadOf(p);
    if (!isEmpty(current) && !fits(current, load, p, add)) {
      batches.push(current);
      current = emptyParts();
      load = fresh();
    }
    current.snapshots.push(...p.snapshots);
    current.calls.push(...p.calls);
    current.sessions.push(...p.sessions);
    load = { entries: load.entries + add.entries, records: load.records + add.records, bytes: load.bytes + add.bytes };
  }
  if (!isEmpty(current)) batches.push(current);
  return batches;
}
