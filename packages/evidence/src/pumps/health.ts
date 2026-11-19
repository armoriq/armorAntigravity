import { setTimeout as sleep } from "node:timers/promises";
import { clientEvent, clientRowId, createOutbox, type ClientEvent, type Login, type Outbox, type PlanFailureReason, type Pump } from "@armorantigravity/core";
import type { EvidenceDeps } from "../context.ts";
import { postClientEvents } from "../io/backend-client-events.ts";
import { auditLogin, DEFAULT_TIMING, type PumpTiming } from "./audit.ts";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { reportingDelivery } from "../io/reporting-delivery.ts";
import type { OutboxStatus } from "@armorantigravity/core";
import type { QueueLogin } from "@armorantigravity/core";

type EventLogin = Pick<Login, "backend" | "apiKey">;
export type HealthPump = Omit<Pump, "kick"> & {
  readonly name: "health";
  readonly outbox: Outbox<ClientEvent>;
  kick(): Promise<void>;
  status(): OutboxStatus;
  loginChanged(revalidated?: boolean): Promise<void>;
  planRequestFailed(login: EventLogin, key: string, reason: PlanFailureReason, notBefore?: number): Promise<void>;
  planRequestSucceeded(login: EventLogin, key: string): Promise<void>;
};

export function createHealthPump(deps: EvidenceDeps & {
  post?: typeof postClientEvents;
  clock?: { now: () => number; random: () => number };
  timing?: Partial<PumpTiming>;
  probe?: (binding: QueueLogin) => Promise<boolean>;
}): HealthPump {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  let initialized = false;
  const outbox = createOutbox<ClientEvent>(deps.dataDir, "health", deps.log, {
    login: () => initialized ? auditLogin(deps.uploads.login()) : null,
    probeLogin: () => auditLogin(deps.uploads.probeLogin ? deps.uploads.probeLogin() : deps.uploads.login()),
    ...(deps.clock ? { clock: deps.clock } : {}),
    timing: { baseMs: timing.minBackoffMs, maxMs: timing.maxBackoffMs, lockTtlMs: 60_000, authProbeMs: timing.authProbeMs },
  });
  initialized = true;
  const delivery = reportingDelivery(deps);
  const requestMarker = (auth: EventLogin, key: string) => join(deps.dataDir, "health-plan-requests", createHash("sha256").update(JSON.stringify([auditLogin(auth), key])).digest("hex"));
  const previousFailures = new Set(outbox.readPending().filter(entry => entry.notBefore !== undefined).map(entry => entry.row.event_id));
  const post = deps.post ?? postClientEvents;
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;

  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    if (!outbox.readPending().length) return Promise.resolve();
    running = outbox.drain(async (events, binding) => {
      const auth = deps.uploads.login();
      const identity = auditLogin(auth);
      if (!auth || !identity || identity.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
      return post(auth, deps.uploads, events);
    }, undefined, { probe: deps.probe ?? delivery.probe }).then(() => {}).catch(() => deps.log.error("health pump failed")).finally(() => { running = null; });
    return running;
  }

  return {
    name: "health", outbox, kick, status: () => outbox.status(),
    async planRequestFailed(auth, key, reason, notBefore) {
      const markerDir = join(deps.dataDir, "health-plan-requests");
      mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      const marker = requestMarker(auth, key);
      if (!existsSync(marker)) {
        const fd = openSync(marker, "a", 0o600);
        try { writeFileSync(fd, "failed\n"); fsyncSync(fd); } finally { closeSync(fd); }
        const directory = openSync(markerDir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      const binding = auditLogin(auth);
      outbox.prepare(binding);
      const event = clientEvent("plan_request_failed", "health", 1, reason, notBefore ?? deps.clock?.now() ?? Date.now(), clientRowId("plan_request_failed", key, "decision"));
      if (!await outbox.updateScheduled(event, binding, notBefore)) outbox.enqueue(event, { binding, ...(notBefore === undefined ? {} : { notBefore }) });
    },
    planRequestSucceeded: async (auth, key) => {
      const id = clientRowId("plan_request_failed", key, "decision");
      if (previousFailures.has(id) || existsSync(requestMarker(auth, key))) await outbox.cancelScheduled(id, auditLogin(auth));
    },
    async loginChanged(revalidated = true) {
      if (revalidated) await outbox.restoreLogin(auditLogin(deps.uploads.login()));
      await kick();
    },
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      void kick();
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      await Promise.race([outbox.persist(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
