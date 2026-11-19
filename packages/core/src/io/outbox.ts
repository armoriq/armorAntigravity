import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Log } from "../types.ts";
import { fallbackAuditRow } from "../core/audit.ts";
import { AUDIT_SIZE_LIMITS, fitRow, jsonBytes, validateSizeLimits, type SizeLimits } from "./audit-size.ts";
import { withLock } from "./shared-lock.ts";

export type QueueLogin = { backend: string; keyId: string; available?: boolean };
export type CaptureOptions = { fallback?: boolean; loggedOut?: boolean; binding?: QueueLogin | null };
export type SendResult<T> =
  | { ok: true; rejected: readonly { item: T; error: string; permanent?: boolean }[]; retryAfterMs?: number }
  | { ok: false; retryAfterMs?: number; relogin?: boolean; legacyRefusal?: boolean; deferred?: boolean; reason?: string };

export type PendingRow<T> = { id: string; row: T; attempts: number; nextAttemptAt: number };
export type DeadLetter<T> = { row: T; attempts: number; reason: string };
export type OutboxStatus = { pending: number; undeliverable: number; deadLetters: number; captureFailures: number };
export interface Outbox<T> {
  enqueue(item: T, options?: CaptureOptions): void;
  drain(send: (batch: readonly T[], login: QueueLogin) => Promise<SendResult<T>>, maxBatch?: number): Promise<"empty" | "more" | "blocked">;
  prepare(): void;
  restoreLogin(login: QueueLogin | null): Promise<void>;
  captureFailure(): void;
  readPending(): PendingRow<T>[];
  readDeadLetters(): DeadLetter<T>[];
  status(): OutboxStatus;
  // Final write at shutdown. The outbox stops draining and its file becomes adoptable by a
  // later outbox in this same process, once any in-flight drain has settled.
  persist(): Promise<void>;
}

export const MAX_ATTEMPTS = 10;
export const ROTATE_BYTES = 10 * 1024 * 1024;
const COALESCE_MS = 100;
const FILE_NAME = /^\d+-[0-9a-f]+\.jsonl$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CommitPoint = "append" | "ack" | "deadLetter";
type Options = {
  login: () => QueueLogin | null;
  clock?: { now: () => number; random: () => number };
  timing?: { baseMs: number; maxMs: number; lockTtlMs: number };
  sizeLimits?: SizeLimits;
  beforeCommit?: (point: CommitPoint) => void;
};
type Entry<T> = PendingRow<T>;
type Settlement<T> = { t: "s"; ack: string[]; retry: Entry<T>[]; dead: (DeadLetter<T> & { id: string })[]; paused?: boolean };
type Line<T> = { t: "b"; login: QueueLogin; adoptedFromLegacy?: boolean } | { t: "a"; entry: Entry<T> } | Settlement<T> | { t: "d"; id: string; value: DeadLetter<T> };
type State<T> = { binding: QueueLogin | null; adoptedFromLegacy: boolean; pending: Map<string, Entry<T>>; dead: Map<string, DeadLetter<T>>; known: Set<string>; paused: boolean };
type Writer = { file: string; fd: number; known: Set<string>; dirty: boolean; compactAt: number };
type Lease = { generation: string; expiresAt: number };
const bindingKey = (login: QueueLogin) => JSON.stringify([login.backend, login.keyId]);
const identified = (login: QueueLogin | null): login is QueueLogin => !!login && typeof login.backend === "string" && !!login.backend && typeof login.keyId === "string" && !!login.keyId;

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Replacements publish a complete file. A partial last append is uncommitted on replay.
function replaceFile(file: string, data: string, directory: string): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(directory);
}

function replay<T>(file: string): State<T> {
  const state: State<T> = { binding: null, adoptedFromLegacy: false, pending: new Map(), dead: new Map(), known: new Set(), paused: false };
  const text = readFileSync(file, "utf8");
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  for (const raw of complete.split("\n")) {
    if (!raw) continue;
    const line = JSON.parse(raw) as Line<T>;
    if (line.t === "b") {
      if (state.binding || !identified(line.login)) throw new Error("invalid audit queue binding");
      state.binding = line.login;
      state.adoptedFromLegacy = line.adoptedFromLegacy === true;
    } else if (line.t === "a" && "entry" in line) {
      state.known.add(line.entry.id);
      state.pending.set(line.entry.id, line.entry);
    } else if (line.t === "d") {
      state.known.add(line.id);
      state.dead.set(line.id, line.value);
    } else if (line.t === "s") {
      for (const entry of line.retry) state.pending.set(entry.id, entry);
      for (const id of line.ack) state.pending.delete(id);
      for (const { id, ...letter } of line.dead) { state.pending.delete(id); state.dead.set(id, letter); }
      if (line.paused !== undefined) state.paused = line.paused;
    } else {
      // Old unbound queues wait for adoption into the first identified login.
      const old = line as unknown as { t: string; id: string; n: number; v: T; ids: string[] };
      if (old.t === "a" && old.id) state.pending.set(old.id, { id: old.id, row: old.v, attempts: old.n, nextAttemptAt: 0 });
      else if (old.t === "k") for (const id of old.ids) state.pending.delete(id);
      else throw new Error("invalid audit queue record");
    }
  }
  return state;
}

// Each process appends to its open file. Delivery keeps that file and its immutable login binding.
// A settlement is one journal transaction containing both pending removal and any dead letters.
export function createOutbox<T>(dir: string, name: string, log: Log, options: Options): Outbox<T> {
  const root = join(dir, "outbox", name);
  const deadRoot = join(root, "dead");
  mkdirSync(deadRoot, { recursive: true, mode: 0o700 });
  const failureFile = join(root, "capture-failures.jsonl");
  const failureFd = openSync(failureFile, "a", 0o600);
  const clock = options.clock ?? { now: Date.now, random: Math.random };
  const timing = options.timing ?? { baseMs: 5_000, maxMs: 600_000, lockTtlMs: 60_000 };
  const limits = validateSizeLimits(options.sizeLimits ?? AUDIT_SIZE_LIMITS);
  const writers = new Map<string, Writer>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<unknown> | null = null;
  let retired = false;
  let failureDirty = false;
  let closed = false;
  let syncParents = true;
  let compacting: Promise<void> = Promise.resolve();
  let adopting: Promise<void> = Promise.resolve();

  const files = () => readdirSync(root).filter(file => FILE_NAME.test(file)).sort().map(file => join(root, file));
  const canSend = (state: State<T>) => {
    const login = options.login();
    return identified(login) && login.available !== false && state.binding !== null && bindingKey(login) === bindingKey(state.binding) && !state.paused;
  };

  function scheduleSync(): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        sync();
        compacting = compacting.then(compact).catch(() => { log.error("audit storage compaction failed"); scheduleSync(); });
      } catch { log.error("audit storage sync failed"); scheduleSync(); }
    }, COALESCE_MS);
    timer.unref?.();
  }

  function writeLine(fd: number, line: unknown): void {
    const data = `${JSON.stringify(line)}\n`;
    if (writeSync(fd, data, undefined, "utf8") !== Buffer.byteLength(data)) throw new Error("incomplete audit queue append");
  }

  function prepare(): void {
    const login = options.login();
    if (retired || !identified(login)) return;
    const legacy = files().filter(file => !replay<T>(file).binding);
    if (legacy.length) {
      const binding = { backend: login.backend, keyId: login.keyId };
      adopting = adopting.then(async () => {
        for (const file of legacy) {
          await withLock(`${file}.guard`, async () => {
            const state = replay<T>(file);
            if (state.binding) return;
            const lines: Line<T>[] = [{ t: "b", login: binding, adoptedFromLegacy: true }];
            for (const entry of state.pending.values()) {
              const value = entry.row as Record<string, unknown>;
              const id = typeof value.client_row_id === "string" && UUID.test(value.client_row_id)
                ? value.client_row_id : randomUUID();
              lines.push({ t: "a", entry: { ...entry, row: { ...entry.row, client_row_id: id } } });
            }
            for (const [id, value] of state.dead) lines.push({ t: "d", id, value });
            if (state.paused) lines.push({ t: "s", ack: [], retry: [], dead: [], paused: true });
            // Binding and resend ids become durable together, before any sender can see them.
            replaceFile(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n", root);
          });
        }
      });
      void adopting.catch(() => log.error("audit legacy adoption failed"));
    }
    if (writers.has(bindingKey(login))) return;
    const file = join(root, `${process.pid}-${randomBytes(6).toString("hex")}.jsonl`);
    const fd = openSync(file, "ax", 0o600);
    try { writeLine(fd, { t: "b", login: { backend: login.backend, keyId: login.keyId } }); }
    catch (error) { closeSync(fd); throw error; }
    writers.set(bindingKey(login), { file, fd, known: new Set(), dirty: true, compactAt: ROTATE_BYTES });
    scheduleSync();
  }

  function materializeDead(file: string, state: State<T>): void {
    if (!state.dead.size) return;
    const target = join(deadRoot, file.slice(file.lastIndexOf("/") + 1));
    const data = [...state.dead.values()].map(letter => JSON.stringify({ ...letter, item: letter.row, error: letter.reason })).join("\n") + "\n";
    replaceFile(target, data, deadRoot);
  }

  function sync(): void {
    for (const writer of writers.values()) {
      if (!writer.dirty) continue;
      fsyncSync(writer.fd);
      materializeDead(writer.file, replay<T>(writer.file));
      writer.dirty = false;
    }
    if (failureDirty) { fsyncSync(failureFd); failureDirty = false; }
    syncDirectory(root);
    syncDirectory(deadRoot);
    if (syncParents) {
      syncDirectory(join(dir, "outbox"));
      syncDirectory(dir);
      syncDirectory(dirname(dir));
      syncParents = false;
    }
  }

  function captureFailure(): void {
    writeLine(failureFd, { count: 1 });
    failureDirty = true;
    scheduleSync();
  }

  async function compact(): Promise<void> {
    for (const writer of writers.values()) {
      if (closed || statSync(writer.file).size <= writer.compactAt) continue;
      await withLock(`${writer.file}.guard`, async () => {
        if (closed) return;
        const state = replay<T>(writer.file);
        const lines: Line<T>[] = [{ t: "b", login: state.binding!, ...(state.adoptedFromLegacy ? { adoptedFromLegacy: true } : {}) }];
        for (const entry of state.pending.values()) lines.push({ t: "a", entry });
        for (const [id, value] of state.dead) lines.push({ t: "d", id, value });
        if (state.paused) lines.push({ t: "s", ack: [], retry: [], dead: [], paused: true });
        const data = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
        // The writer and its descriptor change in one synchronous turn under the settlement guard.
        // A concurrent append cannot land between this snapshot and the replacement.
        replaceFile(writer.file, data, root);
        const next = openSync(writer.file, "a");
        closeSync(writer.fd);
        writer.fd = next;
        writer.dirty = false;
        // A backlog that alone exceeds the limit would otherwise be rewritten on every flush.
        writer.compactAt = Math.max(ROTATE_BYTES, Buffer.byteLength(data) * 2);
      });
    }
  }

  function enqueue(item: T, capture: CaptureOptions = {}): void {
    if (capture.loggedOut) return;
    if (retired) throw new Error("audit queue is closed");
    const login = capture.binding === undefined ? options.login() : capture.binding;
    if (!identified(login)) { captureFailure(); return; }
    const writer = writers.get(bindingKey(login));
    if (!writer) { captureFailure(); throw new Error("audit queue login is not prepared"); }
    const value = item as Record<string, unknown>;
    const id = typeof value.client_row_id === "string" ? value.client_row_id : typeof value.id === "string" ? value.id : "";
    if (!id) { captureFailure(); throw new Error("audit row has no action identity"); }
    if (writer.known.has(id)) return;
    const original = capture.fallback ? fallbackAuditRow(id, typeof value.session_id === "string" ? value.session_id : undefined, Date.parse(String(value.executed_at)), value.decision_code as never) as T : item;
    const fitted = fitRow(original, limits);
    const line: Line<T> = fitted.oversize
      ? { t: "d", id, value: { row: fitted.item, attempts: 0, reason: "oversize" } }
      : { t: "a", entry: { id, row: fitted.item, attempts: 0, nextAttemptAt: 0 } };
    try {
      options.beforeCommit?.("append");
      writeLine(writer.fd, line);
    } catch (error) { captureFailure(); throw error; }
    writer.known.add(id);
    writer.dirty = true;
    scheduleSync();
  }

  async function lease(file: string): Promise<Lease | null> {
    return withLock(`${file}.guard`, async () => {
      const previous = readLease(file);
      if (previous && previous.expiresAt > clock.now()) return null;
      const next = { generation: randomBytes(16).toString("hex"), expiresAt: clock.now() + timing.lockTtlMs };
      replaceFile(`${file}.lease`, JSON.stringify(next), root);
      return next;
    });
  }

  function readLease(file: string): Lease | null {
    try { return JSON.parse(readFileSync(`${file}.lease`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  const owned = (file: string, owner: Lease) => {
    const current = readLease(file);
    return current?.generation === owner.generation && current.expiresAt > clock.now();
  };

  async function release(file: string, owner: Lease): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (readLease(file)?.generation === owner.generation) { unlinkSync(`${file}.lease`); syncDirectory(root); }
    });
  }

  async function settle(file: string, owner: Lease, batch: Entry<T>[], result: SendResult<T>): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (!owned(file, owner)) return;
      const change: Settlement<T> = { t: "s", ack: [], retry: [], dead: [] };
      if (!result.ok && result.relogin) change.paused = true;
      else {
        const rejects = result.ok ? new Map(result.rejected.map(r => [r.item, r])) : null;
        for (const entry of batch) {
          const rejected = rejects?.get(entry.row);
          if (result.ok && !rejected) { change.ack.push(entry.id); continue; }
          const attempts = entry.attempts + 1;
          const reason = rejected?.error ?? (!result.ok ? result.reason : undefined) ?? "audit delivery not confirmed";
          if (rejected?.permanent || attempts >= MAX_ATTEMPTS) {
            change.dead.push({ id: entry.id, row: entry.row, attempts, reason });
          } else {
            const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** (attempts - 1));
            const delay = ceiling / 2 + clock.random() * ceiling / 2;
            change.retry.push({ ...entry, attempts, nextAttemptAt: clock.now() + Math.max(delay, result.retryAfterMs ?? 0) });
          }
        }
      }
      options.beforeCommit?.(change.dead.length ? "deadLetter" : "ack");
      // The sidecar is prepared first; only the journal commits its visibility and pending removal.
      // A crash before the journal commit replays pending, and the uncommitted sidecar is ignored.
      if (change.dead.length) {
        const state = replay<T>(file);
        for (const { id, ...letter } of change.dead) state.dead.set(id, letter);
        materializeDead(file, state);
      }
      const fd = openSync(file, "a", 0o600);
      try { writeLine(fd, change); fsyncSync(fd); } finally { closeSync(fd); }
      for (const letter of change.dead) log.warn("outbox row dead-lettered", { outbox: name, attempts: letter.attempts, reason: letter.reason });
    });
  }

  async function deliver(file: string, owner: Lease, batch: Entry<T>[], send: (batch: readonly T[], login: QueueLogin) => Promise<SendResult<T>>, binding: QueueLogin): Promise<void> {
    if (!owned(file, owner) || !canSend(replay<T>(file))) return;
    const outbound = batch.map(entry => structuredClone(entry.row));
    let result: SendResult<T>;
    try { result = await send(outbound, binding); }
    catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : "audit network failure" }; }
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
    if (result.ok) result = { ...result, rejected: result.rejected.map(rejected => ({ ...rejected, item: batch[outbound.indexOf(rejected.item)]!.row })) };
    await settle(file, owner, batch, result);
  }

  async function drainOnce(send: (batch: readonly T[], login: QueueLogin) => Promise<SendResult<T>>, maxBatch: number, singleBatch: boolean): Promise<"empty" | "more" | "blocked"> {
    await adopting;
    let blocked = false;
    const selected = files().map(file => ({ file, state: replay<T>(file) })).filter(({ state }) => canSend(state));
    queues: for (const { file } of selected) {
      const owner = await lease(file);
      if (!owner) continue;
      try {
        const state = replay<T>(file);
        if (!canSend(state)) continue;
        const eligible = [...state.pending.values()].filter(entry => entry.nextAttemptAt <= clock.now());
        for (let offset = 0; offset < eligible.length;) {
          const batch: Entry<T>[] = [];
          let bytes = 11; // The complete {"rows":[]} envelope, plus commas between rows.
          while (offset < eligible.length && batch.length < Math.min(maxBatch, limits.maxBatchRows)) {
            const entry = eligible[offset]!;
            const next = jsonBytes(entry.row) + (batch.length ? 1 : 0);
            if (bytes + next > limits.maxBatchBytes) break;
            batch.push(entry); bytes += next; offset++;
          }
          if (!batch.length || !owned(file, owner)) break;
          await deliver(file, owner, batch, send, state.binding!);
          const remaining = replay<T>(file);
          if (batch.some(entry => remaining.pending.has(entry.id))) blocked = true;
          if (singleBatch) break queues;
          if (!canSend(remaining)) break;
        }
      } finally { await release(file, owner); }
    }
    const states = files().map(file => replay<T>(file));
    if (blocked && states.some(state => state.pending.size)) return "blocked";
    if (states.some(state => canSend(state) && [...state.pending.values()].some(entry => entry.nextAttemptAt <= clock.now()))) return "more";
    return states.some(state => state.pending.size) ? "blocked" : "empty";
  }

  function readPending(): PendingRow<T>[] { return files().flatMap(file => [...replay<T>(file).pending.values()]); }
  function readDeadLetters(): DeadLetter<T>[] { return files().flatMap(file => [...replay<T>(file).dead.values()]); }

  prepare();
  return {
    enqueue, prepare, captureFailure, readPending, readDeadLetters,
    status() {
      const states = files().map(file => replay<T>(file));
      const captureFailures = readFileSync(failureFile, "utf8").split("\n").filter(Boolean).reduce((n, raw) => n + Number(JSON.parse(raw).count), 0);
      return { pending: states.reduce((n, s) => n + s.pending.size, 0), undeliverable: states.reduce((n, s) => n + (canSend(s) ? 0 : s.pending.size), 0), deadLetters: states.reduce((n, s) => n + s.dead.size, 0), captureFailures };
    },
    async restoreLogin(login) {
      if (!identified(login)) return;
      await adopting;
      // Explicit credential restoration is separate from an automatic timer retry.
      for (const file of files()) {
        await withLock(`${file}.guard`, async () => {
          const state = replay<T>(file);
          if (!state.paused || !state.binding || bindingKey(state.binding) !== bindingKey(login)) return;
          const fd = openSync(file, "a");
          try { writeLine(fd, { t: "s", ack: [], retry: [], dead: [], paused: false }); fsyncSync(fd); } finally { closeSync(fd); }
        });
      }
    },
    drain(send, maxBatch) {
      if (retired || inflight) return Promise.resolve("empty");
      prepare();
      const run = drainOnce(send, maxBatch ?? limits.maxBatchRows, maxBatch !== undefined).finally(() => { inflight = null; });
      inflight = run;
      return run;
    },
    async persist() {
      if (closed) return;
      retired = true;
      clearTimeout(timer); timer = undefined;
      // A send in flight may already be stored by the backend; without its ack on disk the next
      // process adopts this file and uploads those rows again.
      await adopting;
      await inflight;
      sync();
      await compacting;
      await compact();
      for (const writer of writers.values()) closeSync(writer.fd);
      closeSync(failureFd);
      closed = true;
    },
  };
}
