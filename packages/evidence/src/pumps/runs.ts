import { RUNS, runReport, settleRunRequest, type RunBinding, type RunEndReason, type RunReport, type RunRequestOutcome, type RunState } from "@armorantigravity/core";
import { postRunsBatch } from "../io/backend-runs.ts";
import { createOutbox, type JournalCheckpoint, type Outbox } from "@armorantigravity/core";
import type { EvidenceDeps } from "../context.ts";
import { auditLogin, DEFAULT_TIMING } from "./audit.ts";
import { randomUUID } from "node:crypto";
import type { HealthPump } from "./health.ts";
import { reportingDelivery } from "../io/reporting-delivery.ts";
import type { QueueLogin } from "@armorantigravity/core";

export const runReportingEnabled = (env: Readonly<Record<string, string | undefined>>, configured = false): boolean => env.ARMORIQ_RUN_REPORTING_ENABLED === undefined ? configured : env.ARMORIQ_RUN_REPORTING_ENABLED === "true";
// The Antigravity rules from runs-v1.json. The contract test keeps this table in sync.
const capabilities = [
  { matches: /^(?:register_intent_plan|trust_reanchor|trust_revoke|trust_delegate|policy_read)$/, counted: false, gated: false },
  { matches: /^(?:view_file|list_dir|find_by_name|grep_search)$/, counted: true, gated: false },
  { matches: /^.*$/, counted: true, gated: true },
];
export function runCapability(tool: string, trustedOwnTool = true): { counted: boolean; gated: boolean } {
  const rule = capabilities.find(rule => (trustedOwnTool || rule.counted) && rule.matches.test(tool));
  return rule ? { counted: rule.counted, gated: rule.gated } : { counted: true, gated: true };
}
const LOCAL: RunBinding = { backend: "local:logged-out", keyId: "unreported" };
const owners = new Set<string>();

function ownerIsLive(owner: RunState["owner"]): boolean {
  if (owner.pid === process.pid) return owners.has(owner.id);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
type Capture = (checkpoint: JournalCheckpoint) => void;
export type RunsPump = ReturnType<typeof createRunsPump>;

// State changes and reports share the outbox journal. A closure and its final report are one append.
export function createRunsPump(deps: EvidenceDeps & {
  enabled: boolean;
  health?: HealthPump;
  checkpoints?: () => JournalCheckpoint[];
  post?: typeof postRunsBatch;
  clock?: { now: () => number; random: () => number };
  probe?: (binding: QueueLogin) => Promise<boolean>;
}) {
  if (!deps.enabled) return disabledRunsPump();
  const outbox: Outbox<RunReport> = deps.enabled ? createOutbox(deps.dataDir, "runs", deps.log, { preopen: false, login: () => auditLogin(deps.uploads.login()), probeLogin: () => auditLogin(deps.uploads.probeLogin ? deps.uploads.probeLogin() : deps.uploads.login()), ...(deps.clock ? { clock: deps.clock } : {}) }) : inertOutbox();
  const runs = new Map<string, RunState>();
  const saved = new Map<string, RunState>();
  const activity = new Map<string, number>();
  const recovering = new Set<string>();
  const active = new Map<string, number>();
  const idle = new Set<() => void>();
  const now = deps.clock?.now ?? Date.now;
  const delivery = reportingDelivery(deps);
  const post = deps.post ?? postRunsBatch;
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const owner = { id: randomUUID(), pid: process.pid };
  if (deps.enabled) {
    try { outbox.prepare(LOCAL); outbox.prepare(); }
    catch (error) { void outbox.persist().catch(() => deps.log.error("runs initialization cleanup failed")); throw error; }
  }

  function save(run: RunState, report?: RunReport, capture?: Capture, activityAt = now()): JournalCheckpoint {
    const previous = saved.get(run.runId);
    const patch = Object.fromEntries(Object.entries(run).filter(([key, value]) => key !== "callIds" && (!previous || JSON.stringify(previous[key as keyof RunState]) !== JSON.stringify(value))));
    const checkpoint = { id: `${run.runId}:v${run.version}`, sequence: run.version, value: { format: 2, runId: run.runId, version: run.version, patch, calls: run.callIds.slice(previous?.callIds.length ?? 0), activityAt } };
    if (capture) capture(checkpoint);
    else outbox.checkpoint(checkpoint, run.binding ?? LOCAL, report);
    saved.set(run.runId, structuredClone(run));
    activity.set(run.runId, activityAt);
    recovering.delete(run.runId);
    return checkpoint;
  }

  function finalize(run: RunState): void {
    if (!run.end || run.closed || active.get(run.runId)) return;
    const next = { ...run, requests: { ...run.requests }, closed: true, version: run.version + 1, reportSeq: run.reportSeq + 1 };
    for (const key of Object.keys(next.requests)) if (next.requests[key] === "pending") next.requests[key] = "failed";
    save(next, next.binding ? runReport(next) : undefined);
    runs.delete(run.runId);
  }

  function end(runId: string | null, reason: RunEndReason, at: number): void {
    if (!deps.enabled || !runId) return;
    const run = runs.get(runId);
    if (!run || run.closed || run.end) return;
    if (reason === "stop" && at < run.startedAt) return;
    run.end = { reason, at: Math.max(at, run.startedAt) };
    run.version++;
    if (active.get(runId)) save(run);
    else finalize(run);
  }

  if (deps.enabled) {
    const restored = new Map<string, RunState>();
    const checkpoints = [...outbox.readCheckpoints(), ...deps.checkpoints?.() ?? []].sort((a, b) => (a.sequence ?? (a.value as RunState)?.version ?? 0) - (b.sequence ?? (b.value as RunState)?.version ?? 0));
    for (const checkpoint of checkpoints) {
      try {
        const value = checkpoint.value as { format?: number; runId: string; version: number; patch: Partial<RunState>; calls: string[]; activityAt: number };
        const version = checkpoint.sequence ?? value.version;
        if ((restored.get(value.runId)?.version ?? -1) >= version) continue;
        const previous = restored.get(value.runId);
        const state = value.format === 2 ? { ...previous, ...value.patch, callIds: [...previous?.callIds ?? [], ...value.calls] }
          : checkpoint.delta ? { ...previous, ...checkpoint.value as object } : checkpoint.value;
        const run = { ...state as RunState, version };
        if (!run || !Number.isSafeInteger(run.version) || typeof run.sessionId !== "string" || !run.owner) throw new Error("invalid run checkpoint");
        restored.set(run.runId, run);
        activity.set(run.runId, value.activityAt ?? run.updatedAt ?? now());
      } catch { deps.log.error("invalid run checkpoint retained"); }
    }
    for (const run of restored.values()) {
      if (run.closed || ownerIsLive(run.owner)) continue;
      outbox.prepare(run.binding ?? LOCAL);
      saved.set(run.runId, structuredClone(run));
      const adopted = { ...run, owner, version: run.version + 1 };
      save(adopted, undefined, undefined, activity.get(run.runId) ?? now());
      runs.set(run.runId, adopted);
      recovering.add(run.runId);
      if (adopted.end) finalize(adopted);
    }
  }
  owners.add(owner.id);

  function commit(checkpoint: JournalCheckpoint | undefined, capture?: Capture, unreachable = false): void {
    if (!checkpoint) return;
    const run = runs.get((checkpoint.value as RunState).runId ?? checkpoint.id);
    if (!run || run.closed) return;
    if (unreachable && !run.unreachable) { run.unreachable = true; run.version++; }
    save(run, undefined, capture);
  }

  async function cycle(): Promise<void> {
    do {
      again = false;
      for (const run of runs.values()) {
        try {
          if (run.end) finalize(run);
          else if (recovering.has(run.runId) && now() - (activity.get(run.runId) ?? now()) >= 30 * 60_000) end(run.runId, "recovered", now());
        } catch { deps.log.error("run finalization failed; checkpoint retained"); }
      }
      await outbox.drain(async (reports, binding) => {
        const login = deps.uploads.login();
        const identity = auditLogin(login);
        if (!login || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
        return post(login, deps.uploads, reports);
      }, undefined, { probe: deps.probe ?? delivery.probe });
      if (deps.health) {
        await outbox.reportHealth(deps.health.outbox);
        await deps.health.kick();
      }
    } while (again && !stopped);
  }

  async function kick(): Promise<void> {
    if (stopped || !deps.enabled) return;
    if (running) { again = true; return running; }
    running = cycle().catch(() => deps.log.error("runs pump failed")).finally(() => { running = null; });
    return running;
  }

  return {
    name: "runs", enabled: deps.enabled, outbox, commit, end, kick,
    status: () => outbox.status(),
    begin(runId: string, sessionId: string, at: number, enforcing: boolean): void {
      if (!deps.enabled || runs.has(runId)) return;
      const binding = auditLogin(deps.uploads.login());
      outbox.prepare(binding ?? LOCAL);
      const run: RunState = {
        runId, sessionId, startedAt: at, binding, owner, version: 1, reportSeq: 1,
        enforcing, enforcementNeeded: false, toolCalls: 0, gatedToolCalls: 0, callIds: [], planIds: [], requests: {},
        rejected: false, unreachable: false, end: null, closed: false,
      };
      save(run, binding ? runReport(run) : undefined);
      runs.set(runId, run);
    },
    attempt(runId: string | null, callId: string, tool: string, enforcing: boolean, options: { trusted?: boolean; persist?: boolean } = {}): JournalCheckpoint | undefined {
      const run = runId ? runs.get(runId) : undefined;
      if (!run) return;
      const capability = runCapability(tool, options.trusted ?? true);
      if (run.closed || run.end || !capability.counted || run.callIds.includes(callId)) return;
      const next: RunState = {
        ...run, version: run.version + 1, callIds: [...run.callIds, callId],
        toolCalls: Math.min(RUNS.limits.maxInteger, run.toolCalls + 1),
        gatedToolCalls: Math.min(RUNS.limits.maxInteger, run.gatedToolCalls + Number(capability.gated)),
        enforcementNeeded: run.enforcementNeeded || capability.gated && enforcing,
      };
      runs.set(next.runId, next);
      if (options.persist !== false) return save(next);
      return { id: next.runId, value: { runId: next.runId } };
    },
    registration(runId: string | null): () => void {
      if (!runId || !runs.has(runId)) return () => {};
      recovering.delete(runId);
      active.set(runId, (active.get(runId) ?? 0) + 1);
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        const count = (active.get(runId) ?? 1) - 1;
        if (count) active.set(runId, count); else active.delete(runId);
        const run = runs.get(runId);
        if (run) finalize(run);
        if (!active.size) { for (const resolve of idle) resolve(); idle.clear(); }
      };
    },
    request(runId: string | null, key: string, outcome: RunRequestOutcome, planId?: string, unreachable = false): void {
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.closed) return;
      const next = settleRunRequest(run, key, outcome, planId, unreachable);
      save(next);
      runs.set(next.runId, next);
    },
    reject(runId: string | null): void {
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.closed || run.rejected) return;
      run.rejected = true;
      run.version++;
      save(run);
    },
    unreachable(runId: string | null): void {
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.closed || run.unreachable) return;
      const next = { ...run, unreachable: true, version: run.version + 1 };
      save(next);
      runs.set(next.runId, next);
    },
    async loginChanged(revalidated = true): Promise<void> {
      if (!deps.enabled) return;
      outbox.prepare();
      if (revalidated) await outbox.restoreLogin(auditLogin(deps.uploads.login()));
      await kick();
    },
    start(): void {
      if (interval || stopped || !deps.enabled) return;
      interval = setInterval(() => { void kick(); }, DEFAULT_TIMING.intervalMs);
      interval.unref?.();
      void kick();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      if (active.size) {
        try { await Promise.race([new Promise<void>(resolve => idle.add(resolve)), new Promise<void>(resolve => { deadline = setTimeout(resolve, DEFAULT_TIMING.stopBudgetMs); })]); }
        finally { clearTimeout(deadline); }
      }
      await running;
      await outbox.persist();
      owners.delete(owner.id);
    },
  };
}

function inertOutbox(): Outbox<RunReport> {
  const noop = () => {};
  const done = async () => {};
  return {
    enqueue: noop, checkpoint: noop, prepare: noop, captureFailure: noop,
    readCheckpoints: () => [], readPending: () => [], readDeadLetters: () => [],
    closedCheckpoints: () => [], retireCheckpoints: done,
    drain: async () => "empty", flush: done, persist: done, reportHealth: done,
    cancelScheduled: done, updateScheduled: async () => false, restoreLogin: done, authenticationSucceeded: done,
    status: () => ({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 0 }), diagnostics: () => ({ replays: 0, leases: 0 }),
  };
}

function disabledRunsPump() {
  const outbox = inertOutbox();
  const noop = (..._args: unknown[]): void => {};
  const done = async (..._args: unknown[]): Promise<void> => {};
  return {
    name: "runs", enabled: false, outbox, commit: noop, end: noop, kick: done,
    status: () => outbox.status(), begin: noop,
    attempt: (..._args: unknown[]): JournalCheckpoint | undefined => undefined,
    registration: (..._args: unknown[]) => noop, request: noop, reject: noop, unreachable: noop,
    loginChanged: done, start: noop, stop: done,
  };
}
