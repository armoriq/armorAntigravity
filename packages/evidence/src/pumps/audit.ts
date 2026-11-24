import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { postAuditBatch } from "../io/backend-audit.ts";
import { authHeaders } from "../io/http.ts";
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
  authenticationSucceeded(login: Login): Promise<void>;
  // Wakes delivery when the backend is back. Persisted retry deadlines still apply.
  retryNow(): Promise<void>;
};

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number; authProbeMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 2_000, authProbeMs: 120_000 };
type AuthProbe = (request: { login: QueueLogin }) => Promise<{ status: number }>;

export function auditLogin(login: Pick<Login, "backend" | "apiKey"> | null): QueueLogin | null {
  return login?.apiKey && login.backend ? { backend: login.backend, keyId: createHash("sha256").update(login.apiKey).digest("hex") } : null;
}

// Preserve the distinction between a row refusal, a retry and a legacy batch refusal.
export function auditSendResult(rows: readonly AuditRow[], result: CallResult<BatchAck>): SendResult<AuditRow> {
  if (!result.ok) return { ok: false, relogin: !!(result.relogin || result.unauthorized), legacyRefusal: !!result.legacyRefusal, nonTransient: !!result.nonTransient, tooLarge: !!result.tooLarge, reason: result.reason, ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
  if (result.value.results) {
    const outcomes = new Map(result.value.results.map(outcome => [outcome.client_row_id, outcome]));
    return { ok: true, ...(result.value.retryAfterMs === undefined ? {} : { retryAfterMs: result.value.retryAfterMs }), rejected: rows.flatMap(item => {
      const outcome = outcomes.get(item.client_row_id!);
      return outcome?.outcome === "accepted" || outcome?.outcome === "duplicate" ? [] : [{ item, error: outcome?.error ?? (outcome ? outcome.outcome : "missing row outcome"), permanent: outcome?.outcome === "rejected", transient: outcome?.outcome !== "rejected" }];
    }) };
  }
  // The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
  return { ok: true, ...(result.value.retryAfterMs === undefined ? {} : { retryAfterMs: result.value.retryAfterMs }), rejected: result.value.failures.map(({ index, error }) => ({ item: rows[index]!, error, permanent: error.startsWith("invalid row:"), transient: !error.startsWith("invalid row:") })) };
}

// Every 5 s and on kick(): the bound queue sends stored rows. Outcomes are settled per row,
// and transient failures use the core's persisted schedule without spending refusal attempts.
export function createAuditPump(deps: EvidenceDeps & {
  timing?: Partial<PumpTiming>;
  clock?: { now: () => number; random: () => number };
  post?: typeof postAuditBatch;
  probe?: AuthProbe;
}): AuditPump {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postAuditBatch;
  const probeLogin = () => deps.uploads.probeLogin ? deps.uploads.probeLogin() : deps.uploads.login();
  const outbox = createOutbox<AuditRow>(deps.dataDir, "audit", deps.log, {
    login: () => auditLogin(deps.uploads.login()),
    probeLogin: () => auditLogin(probeLogin()),
    ...(deps.clock ? { clock: deps.clock } : {}),
    timing: { baseMs: timing.minBackoffMs, maxMs: timing.maxBackoffMs, lockTtlMs: 60_000, authProbeMs: timing.authProbeMs },
  });
  const probe: AuthProbe = deps.probe ?? (async ({ login: binding }) => {
    const login = probeLogin();
    const current = auditLogin(login);
    if (!login || !current || current.backend !== binding.backend || current.keyId !== binding.keyId) return { status: 401 };
    const response = await fetch(`${login.backend}/iap/validate-key`, { method: "POST", headers: authHeaders(login, deps.uploads), body: "{}", signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) deps.uploads.authenticationSucceeded?.(login);
    return { status: response.status };
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
        let result: CallResult<BatchAck>;
        try { result = await post(current, deps.uploads, rows); }
        catch { result = { ok: false, retryable: true, unreachable: true, reason: "audit transport failed" }; }
        return auditSendResult(rows, result);
      }, undefined, { probe: async login => {
        const response = await probe({ login });
        return response.status >= 200 && response.status < 300;
      } });
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
    authenticationSucceeded: async login => { await outbox.authenticationSucceeded(auditLogin(login)); await kick(); },
    async loginChanged(revalidated = true) {
      outbox.prepare();
      if (revalidated) await outbox.authenticationSucceeded(auditLogin(deps.uploads.login())).then(kick).catch(() => deps.log.error("audit login restore failed"));
      else await kick();
    },
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, Math.min(timing.intervalMs, timing.authProbeMs));
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
