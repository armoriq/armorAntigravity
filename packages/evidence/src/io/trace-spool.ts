import type { Log } from "@armorantigravity/core";
import type { SpanSink, SpooledExportResult, SpooledSpanBatch } from "@armoriq/sdk-dev";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const SPOOL_MAX_BYTES = 8 * 1024 * 1024;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 3600_000;
const SHIP_LIMIT = 32;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
const NAME = /^([0-9a-f]{64})-(\d{13,})-([0-9a-f-]{36})\.json$/;

export interface SpoolExporter {
  readonly spoolBinding: string;
  exportSpooled(batches: readonly unknown[], options?: { deadlineMs?: number } | null): Promise<SpooledExportResult[]>;
}

export type ShipRound = { shipped: number; settled: number; failed: number; more: boolean; reasons: string[] };

type Entry = { name: string; binding: string; at: number; bytes: number };
type Retry = { tries: number; dueAt: number };

export interface TraceSpool {
  readonly sink: SpanSink;
  ship(exporter: SpoolExporter, options?: { deadlineMs?: number; limit?: number }): Promise<ShipRound>;
  pending(binding: string): Promise<number>;
}

// One file per batch the SDK hands its span sink. The daemon is the only writer and shipper
// (its lock guarantees one per user), so retry delays live in memory and restart from zero.
export function createTraceSpool(dataDir: string, log: Log): TraceSpool {
  const dir = path.join(dataDir, "traces", "spool");
  const retries = new Map<string, Retry>();

  async function list(): Promise<Entry[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: Entry[] = [];
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m) continue;
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info) out.push({ name, binding: m[1] ?? "", at: Number(m[2]), bytes: info.size });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async function remove(name: string): Promise<void> {
    retries.delete(name);
    await unlink(path.join(dir, name)).catch(() => {});
  }

  async function prune(now: number): Promise<void> {
    const entries = await list();
    let kept = 0;
    for (const e of [...entries].reverse()) {
      kept += e.bytes;
      if (now - e.at > SPOOL_MAX_AGE_MS || kept > SPOOL_MAX_BYTES) {
        await remove(e.name);
        log.warn("traces: spooled batch dropped", { reason: now - e.at > SPOOL_MAX_AGE_MS ? "expired" : "spool full" });
      }
    }
  }

  const sink: SpanSink = {
    async write(batch: SpooledSpanBatch) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const name = `${batch.binding}-${now}-${randomUUID()}.json`;
      const tmp = path.join(dir, `.${name}.tmp`);
      await writeFile(tmp, JSON.stringify(batch), { mode: 0o600 });
      await rename(tmp, path.join(dir, name));
      await prune(now);
    },
  };

  // As the SDK documents: delete on acknowledged, discarded and rejected; keep failed and
  // unsupported. Kept batches leave only through the age and size caps in prune().
  async function settle(entry: Entry, result: SpooledExportResult | undefined): Promise<"settled" | "failed"> {
    if (result && result.status !== "failed" && result.status !== "unsupported") {
      await remove(entry.name);
      if (result.status === "rejected") log.warn("traces: backend refused a spooled batch", { reason: result.reason });
      return "settled";
    }
    // A batch cut off by a deadline or never tried says nothing about the backend.
    if (result?.status === "failed" && (result.reason === "deadline" || result.reason === "not_attempted")) return "failed";
    const tries = (retries.get(entry.name)?.tries ?? 0) + 1;
    retries.set(entry.name, { tries, dueAt: Date.now() + Math.min(RETRY_FIRST_MS * 2 ** (tries - 1), RETRY_MAX_MS) });
    return "failed";
  }

  return {
    sink,

    async pending(binding) {
      return (await list()).filter((e) => e.binding === binding).length;
    },

    async ship(exporter, options = {}) {
      const now = Date.now();
      const due = (await list()).filter((e) => e.binding === exporter.spoolBinding && (retries.get(e.name)?.dueAt ?? 0) <= now);
      const picked = due.slice(0, options.limit ?? SHIP_LIMIT);
      const round: ShipRound = { shipped: 0, settled: 0, failed: 0, more: due.length > picked.length, reasons: [] };
      if (picked.length === 0) return round;
      const batches: unknown[] = [];
      const read: Entry[] = [];
      for (const entry of picked) {
        const text = await readFile(path.join(dir, entry.name), "utf8").catch(() => null);
        if (text === null) continue;
        try {
          batches.push(JSON.parse(text));
          read.push(entry);
        } catch {
          await remove(entry.name);
        }
      }
      const deadline = options.deadlineMs === undefined ? null : { deadlineMs: options.deadlineMs };
      const results = await exporter.exportSpooled(batches, deadline);
      round.shipped = read.length;
      for (const [i, entry] of read.entries()) {
        const result = results[i];
        if (result && "reason" in result && !round.reasons.includes(result.reason)) round.reasons.push(result.reason);
        round[await settle(entry, result)] += 1;
      }
      return round;
    },
  };
}
