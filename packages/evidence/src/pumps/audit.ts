import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { postAuditBatch } from "../io/backend-audit.ts";
import type { CallResult } from "../io/http.ts";
import type { EvidenceDeps } from "../context.ts";
import { createOutbox, type OutboxStatus, type QueueLogin, type SendResult, type AuditRow, type BatchAck, type Login, type Pump } from "@armorantigravity/core";

export type AuditPump = Omit<Pump, "kick"> & {
  readonly name: "audit";
  kick(): Promise<void>;
  enqueue(row: AuditRow, login?: Login | null): void;
  captureFailure(): void;
  status(): OutboxStatus;
  loginChanged(revalidated?: boolean): Promise<void>;
  // Wakes delivery when the backend is back. Persisted retry deadlines still apply.
  retryNow(): Promise<void>;
};

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 2_000 };

export function auditLogin(login: Login | null): QueueLogin | null {
  return login?.apiKey && login.backend ? { backend: login.backend, keyId: createHash("sha256").update(login.apiKey).digest("hex") } : null;
}

// Preserve the distinction between a row refusal, a retry and a legacy batch refusal.
export function auditSendResult(rows: readonly AuditRow[], result: CallResult<BatchAck>): SendResult<AuditRow> {
  if (!result.ok) return { ok: false, relogin: !!(result.relogin || result.unauthorized), legacyRefusal: !!result.legacyRefusal, reason: result.reason, ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
  if (result.value.results) {
    const outcomes = new Map(result.value.results.map(outcome => [outcome.client_row_id, outcome]));
    return { ok: true, ...(result.value.retryAfterMs === undefined ? {} : { retryAfterMs: result.value.retryAfterMs }), rejected: rows.flatMap(item => {
      const outcome = outcomes.get(item.client_row_id!);
      return outcome?.outcome === "accepted" || outcome?.outcome === "duplicate" ? [] : [{ item, error: outcome?.error ?? (outcome ? outcome.outcome : "missing row outcome"), permanent: outcome?.outcome === "rejected" }];
    }) };
  }
  // The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
  return { ok: true, ...(result.value.retryAfterMs === undefined ? {} : { retryAfterMs: result.value.retryAfterMs }), rejected: result.value.failures.map(({ index, error }) => ({ item: rows[index]!, error, permanent: error.startsWith("invalid row:") })) };
}

// Every 5 s and on kick(): the bound queue sends stored rows. Outcomes are settled per row,
// and transient failures use the queue's persisted schedule and ten delivery attempt limit.
export function createAuditPump(deps: EvidenceDeps & {
  timing?: Partial<PumpTiming>;
  clock?: { now: () => number; random: () => number };
  post?: typeof postAuditBatch;
}): AuditPump {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postAuditBatch;
  const outbox = createOutbox<AuditRow>(deps.dataDir, "audit", deps.log, {
    login: () => auditLogin(deps.uploads.login()),
    ...(deps.clock ? { clock: deps.clock } : {}),
    timing: { baseMs: timing.minBackoffMs, maxMs: timing.maxBackoffMs, lockTtlMs: 60_000 },
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  async function cycle(): Promise<void> {
    do {
      again = false;
      outbox.prepare();
      await outbox.drain(async (rows, binding) => {
        const current = deps.uploads.login();
        const identity = auditLogin(current);
        if (!current || !identity || identity.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
        const result = await post(current, deps.uploads, rows);
        return auditSendResult(rows, result);
      });
    } while (again && !stopped);
  }

  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = cycle().catch(() => deps.log.error("audit pump failed")).finally(() => { running = null; });
    return running;
  }

  return {
    name: "audit",
    enqueue: (row, login = deps.uploads.login()) => outbox.enqueue({ ...row, client_row_id: row.client_row_id ?? randomUUID() }, { binding: auditLogin(login), loggedOut: login === null }),
    captureFailure: () => outbox.captureFailure(),
    status: () => outbox.status(),
    async loginChanged(revalidated = true) {
      outbox.prepare();
      if (revalidated) await outbox.restoreLogin(auditLogin(deps.uploads.login())).then(kick).catch(() => deps.log.error("audit login restore failed"));
      else await kick();
    },
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      kick();
    },
    kick,
    retryNow: kick,
    async stop() {
      clearInterval(interval);
      await Promise.race([kick(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
      stopped = true;
      await Promise.race([outbox.persist(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
