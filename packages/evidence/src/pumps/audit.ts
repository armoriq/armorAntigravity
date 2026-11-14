import { createOutbox, type AuditRow, type BatchAck, type Login, type SendResult } from "@armorantigravity/core";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { EvidenceDeps } from "../context.ts";
import { MAX_BATCH_ROWS, PAYLOAD_TOO_LARGE, postAuditBatch, type QueuedAuditRow } from "../io/backend-audit.ts";
import type { CallResult } from "../io/http.ts";

export interface AuditPump {
  readonly name: "audit";
  enqueue(row: AuditRow): void;
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 2_000 };

type Failure = Extract<CallResult<BatchAck>, { ok: false }>;
type DrainState = "empty" | "more" | "blocked";

// The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
const isPermanent = (error: string) => error.startsWith("invalid row:");
// conmap stops writing a batch when its time budget runs out and defers the remaining rows.
const isDeferred = (error: string) => /deferred for retry/i.test(error);
const tooLarge = (f: Failure) => f.status === PAYLOAD_TOO_LARGE;

// Every 5 s and on kick(): outbox -> /iap/audit/batch, up to 200 rows. Rows the backend marks
// "invalid row:" are dead-lettered; other rejected rows are retried up to 10 times first.
export function createAuditPump(deps: EvidenceDeps & { timing?: Partial<PumpTiming>; post?: typeof postAuditBatch }): AuditPump {
  const { uploads, log } = deps;
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postAuditBatch;
  const outbox = createOutbox<QueuedAuditRow>(deps.dataDir, "audit", log);
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let failures = 0;
  let blockedUntil = 0;
  let batchSize = MAX_BATCH_ROWS;

  function backoff(retryAfterMs: number | undefined): void {
    failures += 1;
    const ceiling = Math.min(timing.maxBackoffMs, timing.minBackoffMs * 2 ** (failures - 1));
    const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
    blockedUntil = Date.now() + Math.max(jittered, Math.min(retryAfterMs ?? 0, timing.maxBackoffMs));
  }

  async function sendOnce(login: Login): Promise<{ state: DrainState; failure?: Failure; size: number; deferred: number }> {
    let failure: Failure | undefined;
    let size = 0;
    let deferred = 0;
    const state = await outbox.drain(async (batch): Promise<SendResult<QueuedAuditRow>> => {
      size = batch.length;
      const result = await post(login, uploads, batch);
      if (result.ok) {
        const rejected = [];
        for (const { index, error } of result.value.failures) {
          const item = batch[index];
          if (!item) continue;
          if (isDeferred(error)) deferred += 1;
          rejected.push({ item, error, permanent: isPermanent(error) });
        }
        // Deferred rows still count an attempt in the outbox, so the next batch is cut to what
        // the backend got through instead of resending the same overload straight away.
        batchSize = deferred ? Math.max(1, batch.length - deferred) : Math.min(MAX_BATCH_ROWS, batchSize * 2);
        return { ok: true, rejected };
      }
      failure = result;
      // A lone row still too large counts an attempt and moves behind the rest of the queue.
      const [only] = batch;
      if (tooLarge(result) && batch.length === 1 && only) return { ok: true, rejected: [{ item: only, error: result.reason }] };
      return { ok: false };
    }, batchSize);
    return failure ? { state, failure, size, deferred } : { state, size, deferred };
  }

  // True when the next batch should go out right away.
  function onFailure(f: Failure, size: number): boolean {
    if (tooLarge(f) && size > 1) {
      batchSize = Math.ceil(size / 2);
      return true;
    }
    backoff(f.retryAfterMs);
    log.warn("audit send failed, backing off", { reason: f.reason, untilMs: blockedUntil - Date.now() });
    return false;
  }

  async function cycle(): Promise<void> {
    while (!stopped) {
      again = false;
      if (Date.now() < blockedUntil) return;
      const login = uploads.login();
      if (!login) return;
      const { state, failure, size, deferred } = await sendOnce(login);
      if (failure) {
        if (onFailure(failure, size)) continue;
        return;
      }
      failures = 0;
      if (deferred) return;
      if (state !== "more" && !again) return;
    }
  }

  function kick(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = cycle()
      .catch((error) => log.error("audit pump failed", { error: String(error) }))
      .finally(() => {
        running = null;
      });
  }

  return {
    name: "audit",
    // The id is fixed when the row is first queued, so every resend of it carries the same one.
    enqueue: (row) => outbox.enqueue({ ...row, client_row_id: randomUUID() }),
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      kick();
    },
    kick,
    async stop() {
      if (stopped) return;
      clearInterval(interval);
      // One last send inside the budget; whatever is left stays in the outbox for the next start.
      await Promise.race([(running ?? Promise.resolve()).then(cycle).catch(() => {}), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
      stopped = true;
      // A budget of its own: a slow last send must not leave the final write without time.
      await Promise.race([outbox.persist(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
