import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Log } from "./types.ts";
import { isAlive, withLock } from "./shared-lock.ts";

export type SendResult<T> =
  | { ok: true; rejected: readonly { item: T; error: string; permanent?: boolean }[] }
  | { ok: false; retryAfterMs?: number; relogin?: boolean };

export interface Outbox<T> {
  enqueue(item: T): void;
  drain(send: (batch: readonly T[]) => Promise<SendResult<T>>, maxBatch: number): Promise<"empty" | "more" | "blocked">;
  // Final write at shutdown. The outbox stops draining and its file becomes adoptable by a
  // later outbox in this same process, once any in-flight drain has settled.
  persist(): Promise<void>;
}

export const MAX_ATTEMPTS = 10;
export const ROTATE_BYTES = 10 * 1024 * 1024;
const COALESCE_MS = 100;
const ADOPT_EVERY_MS = 60_000;
const FILE_NAME = /^(\d+)-[0-9a-f]+\.jsonl$/;

// Files of outboxes this process created, so a later outbox (after a plugin reload) adopts one
// only after it was retired and its last drain finished, never while it is live.
const local = new Map<string, { retired: boolean; settled: () => Promise<void> }>();

type Entry<T> = { id: string; attempts: number; item: T };
type Line<T> = { t: "a"; id: string; n: number; v: T } | { t: "k"; ids: string[] };

function replay<T>(text: string): Entry<T>[] {
  const entries = new Map<string, Entry<T>>();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: Line<T>;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.t === "a") {
      entries.delete(line.id);
      entries.set(line.id, { id: line.id, attempts: line.n, item: line.v });
    } else if (line.t === "k") {
      for (const id of line.ids) entries.delete(id);
    }
  }
  return [...entries.values()];
}

// One file per process (pid + nonce); appends coalesced within 100 ms; orphans adopted under a lock.
// Memory is authoritative while the process lives; the file only exists so another process can adopt it.
export function createOutbox<T>(dir: string, name: string, log: Log): Outbox<T> {
  const root = join(dir, "outbox", name);
  const self = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const file = join(root, `${self}.jsonl`);
  const deadFile = join(root, "dead", `${self}.jsonl`);
  const entries = new Map<string, Entry<T>>();
  let seq = 0;
  let bytes = 0;
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let draining = false;
  let retired = false;
  let inflight: Promise<unknown> = Promise.resolve();
  let compactAt = ROTATE_BYTES;
  let rewrite = false;
  let lastAdopt = Date.now();
  local.set(`${self}.jsonl`, { retired: false, settled: async () => (await inflight.catch(() => {}), await flush()) });
  let ready = adopt();

  function write(line: Line<T>): void {
    buffer.push(`${JSON.stringify(line)}\n`);
    if (timer) return;
    timer = setTimeout(() => void flush().catch(() => {}), COALESCE_MS);
    timer.unref?.();
  }

  function serial(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task);
    chain = run.catch((error) => log.error("outbox write failed", { outbox: name, error: String(error) }));
    return run;
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (buffer.length === 0 && !rewrite) return chain;
    const data = buffer.join("");
    const size = Buffer.byteLength(data);
    buffer = [];
    return serial(async () => {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (!rewrite && bytes + size <= compactAt) {
          await appendFile(file, data, { mode: 0o600 });
          bytes += size;
          return;
        }
        // Memory already reflects every buffered line, so a snapshot of it replaces the whole log.
        const snapshot = [...entries.values()].map((e) => `${JSON.stringify({ t: "a", id: e.id, n: e.attempts, v: e.item })}\n`).join("");
        await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        rewrite = false;
        bytes = Buffer.byteLength(snapshot);
        // A backlog that alone exceeds the limit would otherwise be rewritten on every flush.
        compactAt = Math.max(ROTATE_BYTES, bytes * 2);
      } catch (error) {
        // The failed lines may be missing or torn on disk; the next flush rewrites the file from memory.
        rewrite = true;
        throw error;
      }
    });
  }

  function isOrphan(fileName: string): boolean {
    const match = FILE_NAME.exec(fileName);
    if (!match || fileName === `${self}.jsonl`) return false;
    const pid = Number(match[1]);
    if (pid !== process.pid) return !isAlive(pid);
    return local.get(fileName)?.retired ?? true;
  }

  async function adopt(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    const orphans = names.filter(isOrphan);
    if (orphans.length === 0) return;
    try {
      await withLock(join(root, ".adopt.lock"), async () => {
        for (const orphan of orphans) {
          const path = join(root, orphan);
          await local.get(orphan)?.settled();
          local.delete(orphan);
          let text: string;
          try {
            text = await readFile(path, "utf8");
          } catch {
            continue;
          }
          for (const entry of replay<T>(text)) {
            if (entries.has(entry.id)) continue;
            entries.set(entry.id, entry);
            write({ t: "a", id: entry.id, n: entry.attempts, v: entry.item });
          }
          await flush();
          await unlink(path).catch(() => {});
          log.info("outbox adopted", { outbox: name, from: orphan });
        }
      });
    } catch (error) {
      log.warn("outbox adoption failed", { outbox: name, error: String(error) });
    }
  }

  function deadLetter(entry: Entry<T>, error: string): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), attempts: entry.attempts, error, item: entry.item })}\n`;
    void serial(async () => {
      await mkdir(join(root, "dead"), { recursive: true, mode: 0o700 });
      await appendFile(deadFile, line, { mode: 0o600 });
    }).catch(() => {});
    log.warn("outbox row dead-lettered", { outbox: name, file: deadFile, error, attempts: entry.attempts });
  }

  return {
    enqueue(item) {
      const id = `${self}.${seq++}`;
      entries.set(id, { id, attempts: 0, item });
      write({ t: "a", id, n: 0, v: item });
    },

    drain(send, maxBatch) {
      if (draining || retired) return Promise.resolve("empty");
      draining = true;
      const run = drainOnce(send, maxBatch).finally(() => {
        draining = false;
      });
      inflight = run;
      return run;
    },

    persist() {
      retired = true;
      const entry = local.get(`${self}.jsonl`);
      if (entry) entry.retired = true;
      // A send in flight may already be stored by the backend; without its ack on disk the next
      // process adopts this file and uploads those rows again.
      return flush()
        .then(() => inflight.catch(() => {}))
        .then(() => flush())
        .catch(() => {});
    },
  };

  async function drainOnce(
    send: (batch: readonly T[]) => Promise<SendResult<T>>,
    maxBatch: number,
  ): Promise<"empty" | "more" | "blocked"> {
    await ready;
    if (Date.now() - lastAdopt > ADOPT_EVERY_MS) {
      lastAdopt = Date.now();
      ready = adopt();
      await ready;
    }
    const batch = oldest(maxBatch);
    if (batch.length === 0) return "empty";
    const hadMore = entries.size > batch.length;
    const result = await send(batch.map((e) => e.item));
    if (!result.ok) return "blocked";
    settle(batch, result.rejected);
    if (retired) await flush();
    return hadMore ? "more" : "empty";
  }

  function oldest(max: number): Entry<T>[] {
    const batch: Entry<T>[] = [];
    for (const entry of entries.values()) {
      if (batch.length >= max) break;
      batch.push(entry);
    }
    return batch;
  }

  function settle(batch: Entry<T>[], rejected: Extract<SendResult<T>, { ok: true }>["rejected"]): void {
    const byItem = new Map(batch.map((e) => [e.item, e]));
    const retried = new Set<string>();
    for (const { item, error, permanent } of rejected) {
      const entry = byItem.get(item);
      if (entry && retry(entry, error, permanent === true)) retried.add(entry.id);
    }
    const acked = batch.filter((e) => !retried.has(e.id)).map((e) => e.id);
    for (const id of acked) entries.delete(id);
    if (acked.length > 0) write({ t: "k", ids: acked });
  }

  // Returns false when the entry was dead-lettered instead, which acks it like a sent row.
  function retry(entry: Entry<T>, error: string, permanent: boolean): boolean {
    entry.attempts += 1;
    if (permanent || entry.attempts >= MAX_ATTEMPTS) {
      deadLetter(entry, error);
      return false;
    }
    entries.delete(entry.id);
    entries.set(entry.id, entry);
    write({ t: "a", id: entry.id, n: entry.attempts, v: entry.item });
    return true;
  }
}
