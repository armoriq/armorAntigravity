import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Log } from "../types.ts";
import { fallbackAuditRow } from "../core/audit.ts";
import { CLIENT_EVENTS, clientEvent, type ClientEvent, type DeadLetterReason, type StallReason } from "../core/client-events.ts";
import { RUNS, runTransportId, type RunReport } from "../core/runs.ts";
import { AUDIT_SIZE_LIMITS, fitRow, jsonBytes, validateSizeLimits, type SizeLimits } from "./audit-size.ts";
import { isAlive, withLock } from "./shared-lock.ts";

export type QueueLogin = { backend: string; keyId: string; available?: boolean };
export type JournalCheckpoint = { id: string; value: unknown; sequence?: number; delta?: boolean };
export type CaptureOptions = { fallback?: boolean; loggedOut?: boolean; binding?: QueueLogin | null; notBefore?: number; checkpoint?: JournalCheckpoint };
export type SendResult<T> = { endpointStatus?: number; stallReason?: StallReason } & (
  | { ok: true; rejected: readonly { item: T; error: string; permanent?: boolean; transient?: boolean }[]; retryAfterMs?: number }
  | { ok: false; retryAfterMs?: number; relogin?: boolean; legacyRefusal?: boolean; deferred?: boolean; nonTransient?: boolean; tooLarge?: boolean; reason?: string; hold?: string });

export type PendingRow<T> = { id: string; row: T; attempts: number; nextAttemptAt: number; retries?: number; sent?: boolean; enqueuedAt?: number; notBefore?: number };
export type DeadLetter<T> = { row: T; attempts: number; reason: string };
export type OutboxStatus = { pending: number; undeliverable: number; deadLetters: number; captureFailures: number; legacyPending?: number; corruptRecords?: number; paused?: boolean; holds?: string[] };
type Sender<T> = (batch: readonly T[], login: QueueLogin) => Promise<SendResult<T>>;
type DrainOptions = { probe?: ((login: QueueLogin) => Promise<boolean>) | undefined };
export interface Outbox<T> {
  enqueue(item: T, options?: CaptureOptions): void;
  checkpoint(checkpoint: JournalCheckpoint, binding: QueueLogin, item?: T): void;
  readCheckpoints(): JournalCheckpoint[];
  closedCheckpoints(): string[];
  retireCheckpoints(ids: readonly string[]): Promise<void>;
  drain(send: Sender<T>, maxBatch?: number, options?: DrainOptions): Promise<"empty" | "more" | "blocked">;
  prepare(login?: QueueLogin | null): void;
  flush(): Promise<void>;
  reportHealth(spool: Outbox<ClientEvent>, reason?: StallReason): Promise<void>;
  cancelScheduled(id: string, binding: QueueLogin | null): Promise<void>;
  updateScheduled(item: T, binding: QueueLogin | null, notBefore?: number): Promise<boolean>;
  restoreLogin(login: QueueLogin | null): Promise<void>;
  authenticationSucceeded(login: QueueLogin | null): Promise<void>;
  captureFailure(): void;
  readPending(): PendingRow<T>[];
  readDeadLetters(): DeadLetter<T>[];
  status(): OutboxStatus;
  diagnostics(): { replays: number; leases: number };
  // Final write at shutdown. The outbox stops draining and its file becomes adoptable by a
  // later outbox in this same process, once any in-flight drain has settled.
  persist(): Promise<void>;
}

export class CaptureError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : "audit capture failed", { cause }); }
}

export const MAX_ATTEMPTS = 10;
export const ROTATE_BYTES = 10 * 1024 * 1024;
const COALESCE_MS = 100;
const FILE_NAME = /^queue-(\d+)-[0-9a-f]+\.jsonl$/;
const RELEASED_FILE = /^\d+-[0-9a-f]+\.jsonl$/;
// An open descriptor must never be archived, including one owned by another handle in this process.
const localWriters = new Set<string>();
type CommitPoint = "append" | "ack" | "deadLetter";
type Options = {
  login: () => QueueLogin | null;
  preopen?: boolean;
  probeLogin?: () => QueueLogin | null;
  clock?: { now: () => number; random: () => number };
  timing?: { baseMs: number; maxMs: number; lockTtlMs: number; authProbeMs?: number; endpointProbeMs?: number; endpointMaxProbeMs?: number };
  sizeLimits?: SizeLimits;
  beforeCommit?: (point: CommitPoint) => void;
};
type Entry<T> = PendingRow<T>;
type HealthState = { healthEvents?: ClientEvent[]; healthAck?: string[]; lastStallAt?: number; stallReason?: StallReason | null; known?: string[] };
type Settlement<T> = HealthState & { t: "s"; ack: string[]; retry: Entry<T>[]; dead: (DeadLetter<T> & { id: string })[]; batchLimit?: number };
type Line<T> = { t: "b"; login: QueueLogin } | { t: "a"; entry: Entry<T>; checkpoint?: JournalCheckpoint } | { t: "c"; checkpoint: JournalCheckpoint } | Settlement<T> | { t: "d"; id: string; value: DeadLetter<T>; healthEvents?: ClientEvent[]; checkpoint?: JournalCheckpoint };
type State<T> = { binding: QueueLogin | null; pending: Map<string, Entry<T>>; dead: Map<string, DeadLetter<T>>; known: Set<string>; batchLimit: number; healthEvents: Map<string, ClientEvent>; checkpoints: Map<string, JournalCheckpoint>; lastStallAt?: number; stallReason?: StallReason };
type Writer = { file: string; fd: number; known: Set<string>; dirty: boolean; compactAt: number; tainted: boolean };
type Lease = { generation: string; expiresAt: number };
type Auth = { paused: boolean; nextProbeAt: number };
const bindingKey = (login: QueueLogin) => JSON.stringify([login.backend, login.keyId]);
const identified = (login: QueueLogin | null): login is QueueLogin => !!login && typeof login.backend === "string" && !!login.backend && typeof login.keyId === "string" && !!login.keyId;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const entryValid = (value: any) => object(value) && typeof value.id === "string" && !!value.id && object(value.row) &&
  Number.isSafeInteger(value.attempts) && value.attempts >= 0 && Number.isFinite(value.nextAttemptAt) &&
  (value.retries === undefined || (Number.isSafeInteger(value.retries) && value.retries >= 0)) &&
  (value.sent === undefined || typeof value.sent === "boolean") &&
  (value.enqueuedAt === undefined || Number.isFinite(value.enqueuedAt)) && (value.notBefore === undefined || Number.isFinite(value.notBefore));
const checkpointValid = (value: any) => object(value) && typeof value.id === "string" && !!value.id;
const eventValid = (value: any) => object(value) && typeof value.event_id === "string" && !!value.event_id;
const deadValid = (value: any) => object(value) && object(value.row) && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && typeof value.reason === "string";
const checkpointSequence = (checkpoint: JournalCheckpoint) => checkpoint.sequence ?? (object(checkpoint.value) && Number.isSafeInteger(checkpoint.value.version) ? checkpoint.value.version as number : 0);
function mergeCheckpoint(previous: JournalCheckpoint | undefined, next: JournalCheckpoint): JournalCheckpoint {
  if (previous && checkpointSequence(previous) > checkpointSequence(next)) return previous;
  if (!next.delta || !previous) return next;
  return { ...next, delta: previous.delta ?? false, value: { ...previous.value as object, ...next.value as object } };
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Replacements publish a complete file. A partial last append is quarantined on replay.
function replaceFile(file: string, data: string | Buffer, directory: string): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(directory);
}

// Each process appends to its open file. Delivery keeps that file and its immutable login binding.
// A settlement is one journal transaction containing both pending removal and any dead letters.
export function createOutbox<T>(dir: string, name: string, log: Log, options: Options): Outbox<T> {
  // Released readers scan outbox/<name>. Neither this directory nor its file names match them.
  const health = name === "health";
  const runs = name === "runs";
  const endpointPause = health || runs;
  const root = join(dir, "outbox", `${name}-v2`);
  const releasedRoot = join(dir, "outbox", name);
  const deadRoot = join(root, "dead");
  const archiveRoot = join(root, "archive");
  const corruptRoot = join(root, "corrupt");
  const historyRoot = join(root, "history");
  const closedFile = join(root, "closed-checkpoints.json");
  const instance = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const failureFile = join(root, `failures-${instance}.json`);
  const clock = options.clock ?? { now: Date.now, random: Math.random };
  const timing = { baseMs: 5_000, maxMs: 600_000, lockTtlMs: 60_000, authProbeMs: 120_000, endpointProbeMs: 300_000, endpointMaxProbeMs: 3_600_000, ...options.timing };
  const limits = validateSizeLimits(options.sizeLimits ?? AUDIT_SIZE_LIMITS);
  if (health) limits.maxBatchRows = Math.min(limits.maxBatchRows, CLIENT_EVENTS.maxBatchEvents);
  if (runs) {
    limits.maxBatchRows = Math.min(limits.maxBatchRows, RUNS.limits.maxBatchReports);
    limits.maxBatchBytes = Math.min(limits.maxBatchBytes, RUNS.limits.maxBatchBytes);
  }
  const writers = new Map<string, Writer>();
  const cache = new Map<string, { stamp: string; state: State<T> }>();
  const eventJournals = new Map<string, string>();
  const indexedStamps = new Map<string, string>();
  const eventKey = (binding: QueueLogin, id: string) => JSON.stringify([binding.backend, binding.keyId, id]);
  const smallCache = new Map<string, { stamp: string; value: any }>();
  const sidecars = new Map<string, { stamp: string; ids: Set<string> }>();
  const unsavedCorrupt = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<unknown> | null = null;
  let closing: Promise<void> | null = null;
  let retired = false;
  let failureDirty = false;
  let failures = 0;
  let closed = false;
  let syncParents = true;
  let syncFailures = 0;
  let compacting: Promise<void> = Promise.resolve();
  let healthSignature = "";
  let healthCheckAt = 0;
  const metrics = { replays: 0, leases: 0 };

  function ensureDirectories(): void {
    for (const folder of [deadRoot, archiveRoot, corruptRoot, historyRoot]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  }

  function names(folder: string): string[] {
    try { return readdirSync(folder).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error("audit directory could not be read"); return []; }
  }
  const files = (folder = root) => names(folder).filter(file => FILE_NAME.test(file)).map(file => join(folder, file));
  const stamp = (file: string) => { const info = statSync(file); return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; };

  function quarantine(file: string, offset: number, raw: Buffer): void {
    const id = digest(Buffer.concat([Buffer.from(`${basename(file)}:${offset}:`), raw]));
    const target = join(corruptRoot, `${id}.raw`);
    try {
      mkdirSync(corruptRoot, { recursive: true, mode: 0o700 });
      if (!names(corruptRoot).includes(`${id}.raw`)) {
        replaceFile(target, raw, corruptRoot);
      }
      unsavedCorrupt.delete(id);
    } catch (error) {
      if (!unsavedCorrupt.has(id)) log.error("audit corruption could not be saved");
      unsavedCorrupt.add(id);
    }
  }

  function replay(file: string): State<T> {
    const empty = (): State<T> => ({ binding: null, pending: new Map(), dead: new Map(), known: new Set(), batchLimit: limits.maxBatchRows, healthEvents: new Map(), checkpoints: new Map() });
    let key: string;
    let bytes: Buffer;
    try {
      key = stamp(file);
      const previous = cache.get(file);
      if (previous?.stamp === key) return previous.state;
      bytes = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        quarantine(file, -1, Buffer.from(JSON.stringify({ file: basename(file), error: (error as NodeJS.ErrnoException).code ?? "unreadable" })));
        log.error("audit queue could not be read");
      }
      return empty();
    }
    metrics.replays++;
    const state = empty();
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const raw = bytes.subarray(offset, end < 0 ? bytes.length : end);
      try {
        if (end < 0) throw new Error("partial audit queue line");
        if (raw.length) {
          const line = JSON.parse(raw.toString("utf8"));
          if (!object(line)) throw new Error("invalid audit queue record");
          if (line.t === "b" && !state.binding && identified(line.login)) {
            state.binding = { backend: line.login.backend, keyId: line.login.keyId };
          } else if (line.t === "c") {
            // Applied below, once the line is known to be well formed.
          } else if (line.t === "a" && entryValid(line.entry)) {
            if (!state.known.has(line.entry.id)) state.pending.set(line.entry.id, line.entry);
            state.known.add(line.entry.id);
          } else if (line.t === "d" && typeof line.id === "string" && deadValid(line.value)) {
            state.known.add(line.id); state.pending.delete(line.id); state.dead.set(line.id, line.value);
          } else if (line.t === "s" && Array.isArray(line.ack) && line.ack.every((id: any) => typeof id === "string") &&
              Array.isArray(line.retry) && line.retry.every(entryValid) && Array.isArray(line.dead) &&
              line.dead.every((letter: any) => typeof letter?.id === "string" && deadValid(letter)) &&
              (line.batchLimit === undefined || (Number.isSafeInteger(line.batchLimit) && line.batchLimit > 0))) {
            for (const entry of line.retry) if (state.pending.has(entry.id)) state.pending.set(entry.id, entry);
            for (const id of line.ack) state.pending.delete(id);
            for (const { id, ...letter } of line.dead) { state.pending.delete(id); state.dead.set(id, letter as DeadLetter<T>); }
            if (line.batchLimit !== undefined) state.batchLimit = line.batchLimit;
            if (Number.isFinite(line.lastStallAt)) state.lastStallAt = line.lastStallAt;
            if (typeof line.stallReason === "string") state.stallReason = line.stallReason as StallReason;
            else if (line.stallReason === null) delete state.stallReason;
            if (Array.isArray(line.known)) for (const id of line.known) if (typeof id === "string") state.known.add(id);
            if (Array.isArray(line.healthAck)) for (const id of line.healthAck) state.healthEvents.delete(id);
          } else throw new Error("invalid audit queue record");
          if (line.t === "c") { if (!checkpointValid(line.checkpoint)) throw new Error("invalid audit queue record"); state.checkpoints.set(line.checkpoint.id, mergeCheckpoint(state.checkpoints.get(line.checkpoint.id), line.checkpoint)); }
          if ((line.t === "a" || line.t === "d") && checkpointValid(line.checkpoint)) state.checkpoints.set(line.checkpoint.id, mergeCheckpoint(state.checkpoints.get(line.checkpoint.id), line.checkpoint));
          if ((line.t === "s" || line.t === "d") && Array.isArray(line.healthEvents)) for (const event of line.healthEvents) if (eventValid(event)) state.healthEvents.set(event.event_id, event);
        }
      } catch { quarantine(file, offset, raw); }
      if (end < 0) break;
      offset = end + 1;
    }
    cache.set(file, { stamp: key, state });
    if (health && state.binding && dirname(file) === root) {
      for (const id of state.known) {
        const key = eventKey(state.binding, id);
        if (!eventJournals.has(key)) eventJournals.set(key, file);
      }
      indexedStamps.set(file, key);
    }
    return state;
  }

  function eventJournal(id: string, binding: QueueLogin): string | undefined {
    const key = eventKey(binding, id);
    const found = eventJournals.get(key);
    if (found) return found;
    // Discover captures by other handles without locking or replaying unchanged journals.
    for (const file of files()) {
      try { if (indexedStamps.get(file) !== stamp(file)) replay(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return eventJournals.get(key);
  }

  function readSmall(file: string, missing: any): any {
    try {
      const key = stamp(file);
      const cached = smallCache.get(file);
      if (cached?.stamp === key) return cached.value;
      const raw = readFileSync(file);
      let value;
      try { value = JSON.parse(raw.toString("utf8")); }
      catch { quarantine(file, 0, raw); value = missing; }
      smallCache.set(file, { stamp: key, value });
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error("audit metadata could not be read"); return missing; }
  }

  const authFile = (login: QueueLogin) => join(root, `auth-${digest(bindingKey(login))}.json`);
  const auth = (login: QueueLogin): Auth => {
    const file = authFile(login);
    const value = readSmall(file, { paused: false, nextProbeAt: 0 });
    if (object(value) && typeof value.paused === "boolean" && Number.isFinite(value.nextProbeAt)) return value as Auth;
    try { quarantine(file, 0, readFileSync(file)); } catch { log.error("audit authentication state could not be read"); }
    return { paused: true, nextProbeAt: 0 };
  };
  const available = (binding: QueueLogin | null) => {
    const login = options.login();
    return identified(login) && login.available !== false && binding !== null && bindingKey(login) === bindingKey(binding);
  };
  const holdFile = (login: QueueLogin) => join(root, `hold-${digest(bindingKey(login))}.json`);
  const holdState = (login: QueueLogin): { reason?: string; probeAt?: number; failures?: number } | null => readSmall(holdFile(login), null);
  const hold = (login: QueueLogin) => holdState(login)?.reason;
  const canSend = (state: State<T>) => available(state.binding) && !auth(state.binding!).paused &&
    (!hold(state.binding!) || (holdState(state.binding!)?.probeAt ?? 0) <= clock.now());
  const endpointFile = join(root, "endpoint-state.json");
  const endpoints = (): Record<string, { paused: boolean; probeAt: number; failures?: number }> => {
    const value = readSmall(endpointFile, {});
    return object(value) ? value as Record<string, { paused: boolean; probeAt: number; failures?: number }> : {};
  };
  const endpointReady = (state: State<T>) => {
    if (!endpointPause || !state.binding) return true;
    const endpoint = endpoints()[bindingKey(state.binding)];
    return !endpoint?.paused || endpoint.probeAt <= clock.now();
  };

  async function authenticationSucceeded(login: QueueLogin | null): Promise<void> {
    if (!identified(login) || !auth(login).paused) return;
    const target = authFile(login);
    await withLock(`${target}.guard`, async () => {
      replaceFile(target, JSON.stringify({ paused: false, nextProbeAt: 0 }), root);
      smallCache.delete(target);
    });
  }

  async function pause(login: QueueLogin): Promise<void> {
    const target = authFile(login);
    await withLock(`${target}.guard`, async () => {
      replaceFile(target, JSON.stringify({ paused: true, nextProbeAt: clock.now() + timing.authProbeMs }), root);
      smallCache.delete(target);
    });
  }

  async function probePaused(probe: DrainOptions["probe"]): Promise<void> {
    const login = options.probeLogin ? options.probeLogin() : options.login();
    if (!probe || !identified(login) || login.available === false || !auth(login).paused || auth(login).nextProbeAt > clock.now()) return;
    const target = authFile(login);
    const eligible = await withLock(`${target}.guard`, async () => {
      if (!auth(login).paused || auth(login).nextProbeAt > clock.now()) return false;
      // Publish the next probe before network work so crashes and competing drainers cannot probe in a loop.
      replaceFile(target, JSON.stringify({ paused: true, nextProbeAt: clock.now() + timing.authProbeMs }), root);
      smallCache.delete(target);
      return true;
    });
    if (!eligible) return;
    try { if (await probe(login)) await authenticationSucceeded(login); } catch { /* The persisted pause and probe deadline stand. */ }
  }

  function scheduleSync(delay = COALESCE_MS): void {
    if (timer || closed || retired) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        sync();
        compacting = compacting.then(compact).then(() => { syncFailures = 0; }).catch(retrySync);
      } catch { retrySync(); }
    }, delay);
    timer.unref?.();
  }
  function retrySync(): void {
    log.error("audit storage sync failed");
    syncFailures++;
    scheduleSync(Math.min(60_000, COALESCE_MS * 2 ** Math.min(syncFailures, 10)));
  }

  function writeLine(fd: number, line: unknown): void {
    const data = `${JSON.stringify(line)}\n`;
    if (writeSync(fd, data, undefined, "utf8") !== Buffer.byteLength(data)) throw new Error("incomplete audit queue append");
  }

  function separateAppend(file: string, fd: number): void {
    const size = statSync(file).size;
    if (!size) return;
    const reader = openSync(file, "r");
    const last = Buffer.alloc(1);
    try { readSync(reader, last, 0, 1, size - 1); } finally { closeSync(reader); }
    if (last[0] !== 10 && writeSync(fd, "\n") !== 1) throw new Error("incomplete audit queue separator");
  }

  function newWriter(login: QueueLogin): Writer {
    ensureDirectories();
    const file = join(root, `queue-${process.pid}-${randomBytes(6).toString("hex")}.jsonl`);
    const fd = openSync(file, "ax", 0o600);
    try { writeLine(fd, { t: "b", login: { backend: login.backend, keyId: login.keyId } }); }
    catch (error) { closeSync(fd); throw error; }
    const writer = { file, fd, known: new Set<string>(), dirty: true, compactAt: ROTATE_BYTES, tainted: false };
    writers.set(bindingKey(login), writer);
    localWriters.add(file);
    scheduleSync();
    return writer;
  }

  function prepare(login = options.login()): void {
    if (retired || !identified(login)) return;
    if (!writers.has(bindingKey(login))) newWriter(login);
  }

  function materializeDead(file: string, state: State<T>): void {
    if (!state.dead.size) return;
    mkdirSync(deadRoot, { recursive: true, mode: 0o700 });
    const target = join(deadRoot, basename(file));
    let key = "";
    try { key = stamp(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cached = sidecars.get(target);
    let known = cached?.stamp === key ? cached.ids : undefined;
    if (!known) {
      known = new Set();
      try {
        for (const raw of readFileSync(target, "utf8").split("\n")) {
          try { const line = JSON.parse(raw); if (typeof line.id === "string") known.add(line.id); } catch {}
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const missing = [...state.dead].filter(([id]) => !known!.has(id));
    if (!missing.length) return;
    const fd = openSync(target, "a", 0o600);
    try {
      // A separator also keeps an interrupted sidecar append from swallowing the next complete row.
      separateAppend(target, fd);
      for (const [id, letter] of missing) writeLine(fd, { id, ...letter });
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(deadRoot);
    for (const [id] of missing) known.add(id);
    sidecars.set(target, { stamp: stamp(target), ids: known });
  }

  function sync(): void {
    if (!writers.size && !failureDirty) return;
    if (!failureDirty && !syncParents && ![...writers.values()].some(writer => writer.dirty)) return;
    ensureDirectories();
    for (const writer of writers.values()) {
      if (!writer.dirty) continue;
      fsyncSync(writer.fd);
      materializeDead(writer.file, replay(writer.file));
      writer.dirty = false;
    }
    if (failureDirty) {
      replaceFile(failureFile, JSON.stringify({ count: failures }), root);
      failureDirty = false;
    }
    syncDirectory(root);
    if (syncParents) {
      syncDirectory(join(dir, "outbox"));
      syncDirectory(dir);
      syncDirectory(dirname(dir));
      syncParents = false;
    }
  }

  function captureFailure(): void {
    failures++;
    failureDirty = true;
    try {
      ensureDirectories();
      replaceFile(failureFile, JSON.stringify({ count: failures }), root);
      failureDirty = false;
    } catch { log.error("audit capture failure count could not be saved"); }
    scheduleSync();
  }

  function closedCheckpoints(): string[] {
    return [...new Set([...readSmall(closedFile, []) as string[], ...files().flatMap(file => [...replay(file).checkpoints.values()].filter(checkpoint => object(checkpoint.value) && checkpoint.value.closed === true).map(checkpoint => checkpoint.id))])];
  }

  async function retireCheckpoints(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await withLock(`${closedFile}.guard`, async () => {
      const previous = readSmall(closedFile, []) as string[];
      const next = [...new Set([...previous, ...ids])];
      if (next.length !== previous.length) {
        replaceFile(closedFile, JSON.stringify(next), root);
        smallCache.delete(closedFile);
      }
    });
    await compact();
  }

  async function compact(): Promise<void> {
    const retiredIds = new Set(closedCheckpoints());
    if (retiredIds.size) await withLock(`${closedFile}.guard`, async () => {
      const next = [...new Set([...readSmall(closedFile, []) as string[], ...retiredIds])];
      if (next.length !== (readSmall(closedFile, []) as string[]).length) {
        replaceFile(closedFile, JSON.stringify(next), root);
        smallCache.delete(closedFile);
      }
    });
    for (const writer of writers.values()) {
      if (closed || writer.tainted) continue;
      const hasClosed = [...replay(writer.file).checkpoints.keys()].some(id => retiredIds.has(id));
      if (!hasClosed && statSync(writer.file).size <= writer.compactAt) continue;
      await withLock(`${writer.file}.guard`, async () => {
        if (closed) return;
        const state = replay(writer.file);
        const lines: Line<T>[] = [{ t: "b", login: state.binding! }];
        for (const entry of state.pending.values()) lines.push({ t: "a", entry });
        for (const [id, value] of state.dead) lines.push({ t: "d", id, value });
        for (const checkpoint of state.checkpoints.values()) if (!retiredIds.has(checkpoint.id)) lines.push({ t: "c", checkpoint });
        if (state.batchLimit !== limits.maxBatchRows || state.healthEvents.size || state.lastStallAt !== undefined || state.stallReason !== undefined || health) {
          lines.push({ t: "s", ack: [], retry: [], dead: [], batchLimit: state.batchLimit, healthEvents: [...state.healthEvents.values()],
            ...(state.lastStallAt !== undefined ? { lastStallAt: state.lastStallAt } : {}), ...(state.stallReason !== undefined ? { stallReason: state.stallReason } : {}),
            ...(health ? { known: [...state.known] } : {}) });
        }
        const data = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
        // Preserve the complete earlier journal, including settled envelopes, before replacing it.
        const history = join(historyRoot, `${basename(writer.file)}.${randomBytes(6).toString("hex")}.jsonl`);
        copyFileSync(writer.file, history);
        const historyFd = openSync(history, "r");
        try { fsyncSync(historyFd); } finally { closeSync(historyFd); }
        syncDirectory(historyRoot);
        // The writer and its descriptor change in one synchronous turn under the settlement guard.
        // A concurrent append cannot land between this snapshot and the replacement.
        replaceFile(writer.file, data, root);
        const next = openSync(writer.file, "a");
        closeSync(writer.fd);
        writer.fd = next;
        writer.dirty = false;
        cache.delete(writer.file);
        // A backlog that alone exceeds the limit would otherwise be rewritten on every flush.
        writer.compactAt = Math.max(ROTATE_BYTES, Buffer.byteLength(data) * 2);
      });
    }
  }

  function enqueue(item: T, capture: CaptureOptions = {}): void {
    if (capture.loggedOut) return;
    try {
      if (retired) throw new Error("audit queue is closed");
      const login = capture.binding === undefined ? options.login() : capture.binding;
      if (!identified(login)) { captureFailure(); return; }
      let writer = writers.get(bindingKey(login));
      if (!writer) throw new Error("audit queue login is not prepared");
      if (writer.tainted) {
        fsyncSync(writer.fd);
        closeSync(writer.fd);
        localWriters.delete(writer.file);
        const known = writer.known;
        writer = newWriter(login);
        writer.known = known;
      }
      const value = item as Record<string, unknown>;
      const id = runs && typeof value.run_id === "string" && Number.isSafeInteger(value.report_seq) ? runTransportId(value as unknown as RunReport) : health && typeof value.event_id === "string" ? value.event_id : typeof value.client_row_id === "string" ? value.client_row_id : typeof value.id === "string" ? value.id : "";
      if (!id) throw new Error("audit row has no action identity");
      if (writer.known.has(id)) return;
      if (health && eventJournal(id, login)) return;
      const original = capture.fallback ? fallbackAuditRow(id, typeof value.session_id === "string" ? value.session_id : undefined, Date.parse(String(value.executed_at)), value.decision_code as never) as T : item;
      const fitted = fitRow(original, limits);
      const line: Line<T> = fitted.oversize
        ? { t: "d", id, value: { row: fitted.item, attempts: 0, reason: "oversize" }, healthEvents: deadEvents(1, "oversize") }
        : { t: "a", entry: { id, row: fitted.item, attempts: 0, nextAttemptAt: health ? capture.notBefore ?? 0 : 0, retries: 0, enqueuedAt: clock.now(), ...(health && capture.notBefore !== undefined ? { notBefore: capture.notBefore } : {}) } };
      if (capture.checkpoint) line.checkpoint = capture.checkpoint;
      try {
        options.beforeCommit?.("append");
        writeLine(writer.fd, line);
      } catch (error) { writer.tainted = true; writer.dirty = true; cache.delete(writer.file); throw error; }
      cache.delete(writer.file);
      writer.known.add(id);
      if (health) {
        eventJournals.set(eventKey(login, id), writer.file);
      }
      writer.dirty = true;
      scheduleSync();
    } catch (error) { captureFailure(); throw new CaptureError(error); }
  }

  async function lease(file: string): Promise<Lease | null> {
    return withLock(`${file}.guard`, async () => {
      const previous = readLease(file);
      if (previous && previous.expiresAt > clock.now()) return null;
      const next = { generation: randomBytes(16).toString("hex"), expiresAt: clock.now() + timing.lockTtlMs };
      replaceFile(`${file}.lease`, JSON.stringify(next), root);
      metrics.leases++;
      return next;
    });
  }

  function readLease(file: string): Lease | null {
    return readSmall(`${file}.lease`, null);
  }
  const owned = (file: string, owner: Lease) => {
    const current = readLease(file);
    return current?.generation === owner.generation && current.expiresAt > clock.now();
  };

  async function renew(file: string, owner: Lease): Promise<boolean> {
    return withLock(`${file}.guard`, async () => {
      if (!owned(file, owner)) return false;
      owner.expiresAt = clock.now() + timing.lockTtlMs;
      replaceFile(`${file}.lease`, JSON.stringify(owner), root);
      smallCache.delete(`${file}.lease`);
      return true;
    });
  }

  async function release(file: string, owner: Lease): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (readLease(file)?.generation === owner.generation) {
        unlinkSync(`${file}.lease`); smallCache.delete(`${file}.lease`); syncDirectory(root);
      }
    });
  }

  async function settle(file: string, owner: Lease, batch: Entry<T>[], result: SendResult<T>): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (!owned(file, owner)) return;
      const change: Settlement<T> = { t: "s", ack: [], retry: [], dead: [] };
      let endpointPaused = false;
      if (endpointPause) {
        // Every writer for this login shares the endpoint pause and probe schedule.
        const key = bindingKey(replay(file).binding!);
        endpointPaused = await withLock(`${endpointFile}.guard`, async () => {
          const states = { ...endpoints() };
          if (!owned(file, owner)) return states[key]?.paused ?? false;
          const paused = result.endpointStatus === 404 || (states[key]?.paused === true && result.endpointStatus === undefined);
          const failures = paused ? (states[key]?.failures ?? 0) + 1 : 0;
          const next = { paused, failures, probeAt: paused ? clock.now() + Math.min(timing.endpointMaxProbeMs, timing.endpointProbeMs * 2 ** Math.min(failures - 1, 8)) : 0 };
          if ((states[key] || paused) && JSON.stringify(states[key]) !== JSON.stringify(next)) {
            states[key] = next;
            replaceFile(endpointFile, JSON.stringify(states), root);
            smallCache.delete(endpointFile);
          }
          return paused;
        });
        if (!owned(file, owner)) return;
      }
      const deadCounts = new Map<DeadLetterReason, number>();
      const binding = replay(file).binding!;
      if ((!result.ok && result.hold) || hold(binding)) {
        const target = holdFile(binding);
        await withLock(`${target}.guard`, async () => {
          if (!owned(file, owner)) return;
          const previous = holdState(binding);
          if (result.ok) {
            replaceFile(target, JSON.stringify({}), root);
          } else {
            const failures = (previous?.failures ?? 0) + 1;
            replaceFile(target, JSON.stringify({ reason: result.hold ?? previous?.reason, failures,
              probeAt: clock.now() + Math.min(timing.endpointMaxProbeMs, timing.endpointProbeMs * 2 ** Math.min(failures - 1, 8)) }), root);
          }
          smallCache.delete(target);
        });
        if (!owned(file, owner)) return;
      }
      if (!result.ok && result.hold) {
        // The login wide hold and its persisted probe schedule retain every pending row.
      }
      else if (!endpointPaused && !result.ok && result.relogin) { await pause(replay(file).binding!); change.stallReason = "auth_paused"; }
      else if (!endpointPaused) {
        if (result.ok) change.stallReason = result.rejected.length ? result.stallReason ?? "backend_unreachable" : null;
        else if (result.stallReason) change.stallReason = result.stallReason;
        const rejects = result.ok ? new Map(result.rejected.map(r => [r.item, r])) : null;
        for (const entry of batch) {
          const rejected = rejects?.get(entry.row);
          if (result.ok && !rejected) { change.ack.push(entry.id); continue; }
          const charged = rejected ? rejected.permanent || !rejected.transient : !result.ok && result.nonTransient;
          const attempts = entry.attempts + (charged ? 1 : 0);
          const retries = (entry.retries ?? 0) + 1;
          const reason = rejected?.error ?? (!result.ok ? result.reason : undefined) ?? "audit delivery not confirmed";
          if (rejected?.permanent || attempts >= MAX_ATTEMPTS) {
            change.dead.push({ id: entry.id, row: entry.row, attempts, reason });
            const code = rejected?.permanent ? "rejected" : "attempts_exhausted";
            deadCounts.set(code, (deadCounts.get(code) ?? 0) + 1);
          } else {
            const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** Math.min(retries - 1, 30));
            const delay = ceiling / 2 + clock.random() * ceiling / 2;
            change.retry.push({ ...entry, attempts, retries, nextAttemptAt: clock.now() + Math.max(delay, result.retryAfterMs ?? 0) });
          }
        }
        // 413 is not a bisection probe. Reduce the following request while retaining R9's refusal count.
        if (!result.ok && result.tooLarge && batch.length > 1) change.batchLimit = Math.max(1, Math.floor(batch.length / 2));
      }
      change.healthEvents = [...deadCounts].flatMap(([reason, count]) => deadEvents(count, reason));
      options.beforeCommit?.(change.dead.length ? "deadLetter" : "ack");
      // The sidecar is prepared first; only the journal commits its visibility and pending removal.
      // A crash before the journal commit replays pending, and the uncommitted sidecar is ignored.
      if (change.dead.length) {
        const current = replay(file);
        const state = { ...current, dead: new Map(current.dead) };
        for (const { id, ...letter } of change.dead) state.dead.set(id, letter);
        materializeDead(file, state);
      }
      const fd = openSync(file, "a", 0o600);
      try {
        separateAppend(file, fd);
        writeLine(fd, change); fsyncSync(fd);
      } finally { closeSync(fd); cache.delete(file); }
      for (const letter of change.dead) log.warn("outbox row dead-lettered", { outbox: name, attempts: letter.attempts, reason: letter.reason });
    });
  }

  async function deliver(file: string, owner: Lease, batch: Entry<T>[], send: Sender<T>, binding: QueueLogin): Promise<void> {
    const current = replay(file);
    if (!canSend(current) || !endpointReady(current) || !owned(file, owner)) return;
    if (owner.expiresAt - clock.now() <= timing.lockTtlMs / 2 && !await renew(file, owner)) return;
    if (health) {
      batch = await withLock(`${file}.guard`, async () => {
        const state = replay(file);
        if (!canSend(state) || !endpointReady(state) || !owned(file, owner)) return [];
        const selected = batch.flatMap(entry => {
          const current = state.pending.get(entry.id);
          return current && current.nextAttemptAt <= clock.now() ? [{ ...current, sent: true }] : [];
        });
        // Publish sent before network work, including the case where its reply or settlement is lost.
        const changed = selected.filter(entry => !state.pending.get(entry.id)!.sent);
        if (changed.length) commit(file, { t: "s", ack: [], retry: changed, dead: [] });
        return selected;
      });
      if (!batch.length) return;
    }
    const outbound = batch.map(entry => structuredClone(entry.row));
    let result: SendResult<T>;
    try { result = await send(outbound, binding); }
    catch { result = { ok: false, stallReason: "backend_unreachable", reason: "audit network failure" }; }
    if (!owned(file, owner)) return;
    if (!result.ok && result.deferred) return;
    if (!result.ok && result.legacyRefusal && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      await deliver(file, owner, batch.slice(0, middle), send, binding);
      await deliver(file, owner, batch.slice(middle), send, binding);
      return;
    }
    if (!result.ok && result.legacyRefusal) result = { ok: true, rejected: [{ item: outbound[0]!, error: result.reason ?? "legacy row rejected", permanent: true }] };
    // The sender receives copies. Settlement uses the stored envelope even if it mutates those copies.
    if (result.ok) {
      if (result.rejected.some(rejected => !outbound.includes(rejected.item))) result = { ok: false, reason: "invalid audit sender outcome" };
      else {
        result = { ...result, rejected: result.rejected.map(rejected => ({ ...rejected, item: batch[outbound.indexOf(rejected.item)]!.row })) };
        await authenticationSucceeded(binding);
      }
    }
    await settle(file, owner, batch, result);
  }

  async function archive(file: string): Promise<void> {
    try { statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const pid = Number(FILE_NAME.exec(basename(file))?.[1]);
    if (localWriters.has(file) || (pid !== process.pid && isAlive(pid))) return;
    const closedIds = [...replay(file).checkpoints.values()].filter(checkpoint => object(checkpoint.value) && checkpoint.value.closed === true).map(checkpoint => checkpoint.id);
    if (closedIds.length) await retireCheckpoints(closedIds);
    const retiredIds = new Set(readSmall(closedFile, []) as string[]);
    const hasLiveCheckpoints = (state: State<T>) => [...state.checkpoints.keys()].some(id => !retiredIds.has(id));
    if (replay(file).pending.size || replay(file).healthEvents.size || hasLiveCheckpoints(replay(file))) return;
    await withLock(`${file}.guard`, async () => {
      try { statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const owner = readLease(file);
      if ((owner && owner.expiresAt > clock.now()) || replay(file).pending.size || replay(file).healthEvents.size || hasLiveCheckpoints(replay(file))) return;
      const target = join(archiveRoot, basename(file));
      renameSync(file, target);
      const cached = cache.get(file);
      if (cached) cache.set(target, { stamp: stamp(target), state: cached.state });
      cache.delete(file);
      if (health && cached?.state.binding) {
        for (const id of cached.state.known) {
          const key = eventKey(cached.state.binding, id);
          if (eventJournals.get(key) === file) eventJournals.delete(key);
        }
        indexedStamps.delete(file);
      }
      syncDirectory(archiveRoot);
      syncDirectory(root);
    });
  }

  async function drainOnce(send: Sender<T>, maxBatch: number, singleBatch: boolean, controls: DrainOptions): Promise<"empty" | "more" | "blocked"> {
    await probePaused(controls.probe);
    let blocked = false;
    const ready = (state: State<T>) => canSend(state) && endpointReady(state);
    queues: for (const file of files()) {
      let state = replay(file);
      if (!state.pending.size) { await archive(file); continue; }
      if (!ready(state) || ![...state.pending.values()].some(entry => entry.nextAttemptAt <= clock.now())) continue;
      const owner = await lease(file);
      if (!owner) continue;
      try {
        state = replay(file);
        if (!ready(state)) continue;
        const eligible = [...state.pending.values()].filter(entry => entry.nextAttemptAt <= clock.now());
        for (let offset = 0; offset < eligible.length;) {
          const batch: Entry<T>[] = [];
          let bytes = runs ? 14 : health ? 13 : 11; // The complete rows or events envelope, plus commas between records.
          while (offset < eligible.length && batch.length < Math.min(maxBatch, limits.maxBatchRows, state.batchLimit)) {
            const entry = eligible[offset]!;
            const next = jsonBytes(entry.row) + (batch.length ? 1 : 0);
            if (bytes + next > limits.maxBatchBytes) break;
            batch.push(entry); bytes += next; offset++;
          }
          if (!batch.length || !owned(file, owner)) break;
          await deliver(file, owner, batch, send, state.binding!);
          state = replay(file);
          if (batch.some(entry => state.pending.has(entry.id))) blocked = true;
          if (singleBatch) break queues;
          if (!ready(state)) break;
        }
      } finally { await release(file, owner); }
      await archive(file);
    }
    const states = files().map(replay);
    if (blocked && states.some(state => state.pending.size)) return "blocked";
    if (states.some(state => ready(state) && [...state.pending.values()].some(entry => entry.nextAttemptAt <= clock.now()))) return "more";
    return states.some(state => state.pending.size) ? "blocked" : "empty";
  }

  function readPending(): PendingRow<T>[] { return files().flatMap(file => [...replay(file).pending.values()]); }
  function readDeadLetters(): DeadLetter<T>[] { return [...files(), ...files(archiveRoot)].flatMap(file => [...replay(file).dead.values()]); }

  function deadEvents(count: number, reason: DeadLetterReason): ClientEvent[] {
    if (health) return [];
    const events: ClientEvent[] = [];
    while (count > 0) {
      const part = Math.min(count, CLIENT_EVENTS.maxCount);
      events.push(clientEvent("dead_letter", name, part, reason, clock.now(), randomUUID()));
      count -= part;
    }
    return events;
  }

  function commit(file: string, change: Settlement<T>): void {
    const fd = openSync(file, "a", 0o600);
    try { separateAppend(file, fd); writeLine(fd, change); fsyncSync(fd); } finally { closeSync(fd); cache.delete(file); }
  }

  async function reportHealth(spool: Outbox<ClientEvent>, stallReason?: StallReason): Promise<void> {
    if (health) return;
    const signature = () => JSON.stringify([options.login(), stallReason, ...names(root).filter(file => FILE_NAME.test(file) || /^(auth-|hold-|endpoint-state)/.test(file)).flatMap(file => {
      try { return [[file, stamp(join(root, file))]]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    })]);
    const before = signature();
    if (before === healthSignature && clock.now() < healthCheckAt) return;
    let nextCheckAt = clock.now() + 60_000;
    // The queue wide guard shares each binding's hourly bookmark across writers and processes.
    await withLock(join(root, "health.guard"), async () => {
      const sources = files().map(file => ({ file, state: replay(file) }));
      const bookmark = join(root, "health-state.json");
      const saved = readSmall(bookmark, null);
      const bookmarks: Record<string, number> = object(saved?.lastStallAtByBinding) ? { ...saved.lastStallAtByBinding } : {};
      const saveBookmarks = () => {
        replaceFile(bookmark, JSON.stringify({ lastStallAtByBinding: bookmarks }), root);
        smallCache.delete(bookmark);
      };
      const bindings = new Map<string, typeof sources>();
      for (const source of sources) {
        if (!source.state.binding) continue;
        const key = bindingKey(source.state.binding);
        const group = bindings.get(key) ?? [];
        group.push(source);
        bindings.set(key, group);
        for (const entry of source.state.pending.values()) {
          const eligibleAt = Math.max(entry.nextAttemptAt, (entry.enqueuedAt ?? clock.now()) + 60_000);
          if (eligibleAt > clock.now()) nextCheckAt = Math.min(nextCheckAt, eligibleAt);
        }
      }
      for (const [key, group] of bindings) {
        const savedAt = Number.isFinite(bookmarks[key]) ? bookmarks[key]! : -Infinity;
        const last = Math.max(savedAt, ...group.map(({ state }) => state.lastStallAt ?? -Infinity));
        if (Number.isFinite(last) && last > savedAt) {
          // The bookmark must survive archival even when its first write failed after the event append.
          bookmarks[key] = last;
          saveBookmarks();
        }
        if (clock.now() - last < 3_600_000) {
          nextCheckAt = Math.min(nextCheckAt, last + 3_600_000);
          continue;
        }
        const overdue = (entry: Entry<T>) => entry.nextAttemptAt <= clock.now() && clock.now() - (entry.enqueuedAt ?? clock.now()) >= 60_000;
        for (const { file } of group) {
          const reported = await withLock(`${file}.guard`, async () => {
            const state = replay(file);
            if (state.binding && hold(state.binding) && available(state.binding) && !auth(state.binding).paused) return false;
            const reason = state.binding && auth(state.binding).paused ? "auth_paused" : !canSend(state) ? "undeliverable_login" : stallReason ?? state.stallReason;
            if (!state.pending.size || !reason || !state.binding) return false;
            if (![...state.pending.values()].some(overdue)) return false;
            const entries = group.flatMap(source => [...replay(source.file).pending.values()].filter(overdue));
            const oldest = entries.reduce((oldest, entry) => Math.min(oldest, entry.enqueuedAt ?? clock.now()), clock.now());
            const events = [clientEvent("queue_stalled", name, Math.min(entries.length, CLIENT_EVENTS.maxCount), reason, clock.now(), randomUUID(), Math.max(0, Math.floor((clock.now() - oldest) / 1000)))];
            commit(file, { t: "s", ack: [], retry: [], dead: [], healthEvents: events, lastStallAt: clock.now() });
            bookmarks[key] = clock.now();
            saveBookmarks();
            return true;
          });
          if (reported) break;
        }
      }
      for (const { file } of sources) {
        const state = replay(file);
        if (!state.binding || !state.healthEvents.size) continue;
        for (const event of state.healthEvents.values()) {
          // Queue diagnostics retain the source journal's immutable login binding.
          spool.prepare(state.binding);
          // Keep the source receipt until the health append is durable. A replay keeps its event id.
          spool.enqueue(event, { binding: state.binding });
          await spool.flush();
          await withLock(`${file}.guard`, async () => commit(file, { t: "s", ack: [], retry: [], dead: [], healthAck: [event.event_id] }));
        }
      }
    });
    healthSignature = signature();
    healthCheckAt = nextCheckAt;
  }

  function releasedStatus(): { pending: number; dead: number } {
    // Released rows have no provable login binding. These reads are for counts only, never delivery.
    const pending = new Set<string>();
    for (const name of names(releasedRoot).filter(file => RELEASED_FILE.test(file))) {
      const file = join(releasedRoot, name);
      try {
        const rows = new Set<string>();
        for (const raw of readFileSync(file, "utf8").split("\n")) {
          try {
            const line = JSON.parse(raw);
            if (line.t === "a" && typeof line.id === "string") rows.add(line.id);
            else if (line.t === "k" && Array.isArray(line.ids)) for (const id of line.ids) rows.delete(id);
          } catch {}
        }
        for (const id of rows) pending.add(id);
      } catch { log.error("released audit queue could not be counted"); }
    }
    let dead = 0;
    const oldDead = join(releasedRoot, "dead");
    for (const name of names(oldDead).filter(file => RELEASED_FILE.test(file))) {
      try { for (const raw of readFileSync(join(oldDead, name), "utf8").split("\n")) { try { if (object(JSON.parse(raw))) dead++; } catch {} } }
      catch { log.error("released audit dead letters could not be counted"); }
    }
    return { pending: pending.size, dead };
  }

  // Local storage cannot disable the guard during host setup. Capture still reports its own failure.
  try {
    if (health) for (const file of files()) replay(file);
    if (options.preopen !== false) prepare();
  } catch { log.error("audit storage initialization failed"); captureFailure(); }
  return {
    enqueue, prepare, captureFailure, readPending, readDeadLetters, authenticationSucceeded, reportHealth, closedCheckpoints, retireCheckpoints,
    readCheckpoints: () => {
      // Explicit checkpoint sequences preserve write order when file timestamps tie or go backwards.
      const ordered = files().flatMap(file => [...replay(file).checkpoints.values()]).sort((x, y) => checkpointSequence(x) - checkpointSequence(y));
      const latest = new Map<string, JournalCheckpoint>();
      for (const checkpoint of ordered) latest.set(checkpoint.id, mergeCheckpoint(latest.get(checkpoint.id), checkpoint));
      const retiredIds = new Set(closedCheckpoints());
      return [...latest.values()].filter(checkpoint => !retiredIds.has(checkpoint.id));
    },
    checkpoint(checkpoint, binding, item) {
      if (item !== undefined) { enqueue(item, { binding, checkpoint }); return; }
      if (retired) throw new Error("outbox is closed");
      let writer = writers.get(bindingKey(binding));
      if (!writer) throw new Error("outbox checkpoint login is not prepared");
      if (writer.tainted) {
        fsyncSync(writer.fd); closeSync(writer.fd); localWriters.delete(writer.file);
        const known = writer.known;
        writer = newWriter(binding);
        writer.known = known;
      }
      try {
        options.beforeCommit?.("append");
        writeLine(writer.fd, { t: "c", checkpoint });
      } catch (error) {
        writer.tainted = true; writer.dirty = true; cache.delete(writer.file);
        captureFailure(); throw new CaptureError(error);
      }
      cache.delete(writer.file);
      writer.dirty = true;
      scheduleSync();
    },
    async flush() { sync(); await compact(); },
    async updateScheduled(item, binding, notBefore) {
      if (!health || !identified(binding)) return false;
      const id = (item as Record<string, unknown>).event_id as string;
      const file = eventJournal(id, binding);
      if (!file) return false;
      return withLock(`${file}.guard`, async () => {
        const state = replay(file);
        if (!state.binding || bindingKey(state.binding) !== bindingKey(binding) || !state.known.has(id)) return false;
        const entry = state.pending.get(id);
        if (entry?.notBefore !== undefined && !entry.sent && entry.attempts === 0 && (entry.retries ?? 0) === 0) {
          const fitted = fitRow(item, limits);
          if (fitted.oversize) throw new Error("scheduled client event exceeds the size contract");
          const updated = { ...entry, row: fitted.item, nextAttemptAt: notBefore ?? 0 };
          if (notBefore === undefined) delete updated.notBefore;
          else updated.notBefore = notBefore;
          commit(file, { t: "s", ack: [], retry: [updated], dead: [] });
        }
        return true;
      });
    },
    async cancelScheduled(id, binding) {
      if (!health || !identified(binding)) return;
      const file = eventJournal(id, binding);
      if (!file) return;
      await withLock(`${file}.guard`, async () => {
        const state = replay(file);
        const entry = state.pending.get(id);
        // Only an unsent provisional failure can be canceled by a confirmed token request.
        if (!state.binding || bindingKey(state.binding) !== bindingKey(binding) || entry?.notBefore === undefined || entry.sent || entry.attempts !== 0 || (entry.retries ?? 0) !== 0) return;
        commit(file, { t: "s", ack: [id], retry: [], dead: [] });
      });
    },
    restoreLogin: authenticationSucceeded,
    diagnostics: () => ({ ...metrics }),
    status() {
      const states = files().map(replay);
      const current = options.login();
      const legacy = releasedStatus();
      let captureFailures = failures;
      for (const name of names(root).filter(file => /^failures-.*\.json$/.test(file))) {
        if (join(root, name) === failureFile) continue;
        const value = readSmall(join(root, name), { count: 0 });
        if (object(value) && Number.isSafeInteger(value.count) && value.count > 0) captureFailures += value.count;
      }
      return {
        pending: legacy.pending + states.reduce((n, s) => n + s.pending.size, 0),
        undeliverable: legacy.pending + states.reduce((n, s) => n + (canSend(s) && endpointReady(s) && !hold(s.binding!) ? 0 : s.pending.size), 0),
        deadLetters: legacy.dead + readDeadLetters().length, captureFailures, legacyPending: legacy.pending,
        corruptRecords: names(corruptRoot).filter(file => file.endsWith(".raw")).length + unsavedCorrupt.size,
        holds: [...new Set(states.flatMap(state => state.binding && hold(state.binding) ? [hold(state.binding)!] : []))],
        ...(endpointPause ? { paused: identified(current) && (endpoints()[bindingKey(current)]?.paused === true || auth(current).paused) } : {}),
      };
    },
    drain(send, maxBatch, controls = {}) {
      if (retired || inflight) return Promise.resolve("empty");
      const run = Promise.resolve().then(() => {
        return drainOnce(send, maxBatch ?? limits.maxBatchRows, maxBatch !== undefined, controls);
      }).finally(() => { inflight = null; });
      inflight = run;
      return run;
    },
    persist() {
      if (closing) return closing;
      closing = (async () => {
        if (closed) return;
        retired = true;
        clearTimeout(timer); timer = undefined;
        try {
          // A send in flight may already be stored by the backend; without its ack on disk the next
          // process adopts this file and uploads those rows again.
          await inflight;
          sync();
          await compacting;
          await compact();
        } finally {
          await compacting;
          for (const writer of writers.values()) {
            try { closeSync(writer.fd); } catch { log.error("audit queue descriptor could not be closed"); }
            finally { localWriters.delete(writer.file); }
          }
          closed = true;
        }
      })();
      return closing;
    },
  };
}
