import {
  bucketByHour,
  callKey,
  changedBuckets,
  entriesDigest,
  hourKey,
  packBatches,
  splitParts,
  toParts,
  toSnapshots,
  tryLock,
  type Login,
  type SessionTitle,
  type StepUsage,
  type UsageSnapshot,
} from "@armorantigravity/core";
import type { EvidenceDeps } from "../context.ts";
import {
  acknowledge,
  acknowledgedIn,
  allocateRevision,
  clearQueue,
  createUsageClient,
  enqueueBatches,
  isFenced,
  mergeSteps,
  newBatchId,
  noteTitle,
  queuedBatches,
  queueLockPath,
  refuse,
  scopeDir,
  sentCallsIn,
  sentTitleIn,
  setAside,
  setGeneration,
  settle,
  storedGeneration,
  storedSessionIds,
  updateSession,
  type QueuedBatch,
  type SessionState,
  type UsageBatch,
  type UsageClient,
  type UsageResult,
} from "../io/backend-usage.ts";

// A capture tagged with a run resends every hour it finds, because conmap completes a run only
// once each of its hours arrived in a batch carrying that runId.
export type RunTag = { readonly runId: string; readonly hours: Set<string> };

export interface UsagePump {
  readonly name: "usage";
  observe(step: StepUsage): void;
  observeTitle(title: SessionTitle): void;
  // Saves what was observed, captures the given sessions into batches tagged with the run, and drains.
  runPass(sessionIds: readonly string[], run: RunTag): Promise<Outcome>;
  // A run the backend says is no longer current: its queued batches are dropped.
  dropRun(runId: string): Promise<void>;
  client(): Promise<{ client: UsageClient; dir: string; login: Login } | null>;
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}

export type UsagePumpOptions = {
  intervalMs?: number;
  persistDelayMs?: number;
  client?: (login: Login) => Promise<UsageClient>;
};

const INTERVAL_MS = 60_000;
const PERSIST_DELAY_MS = 1_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const SESSION_MAX_AGE_MS = 30 * 24 * 3600_000;
const STOP_WAIT_MS = 2_000;

const loginKey = (l: Login) => JSON.stringify([l.backend, l.apiKey, l.userId, l.deviceId]);
const runHour = (s: UsageSnapshot) => `${s.sessionId}|${hourKey(s)}`;

export type Outcome =
  | { kind: "drained" }
  | { kind: "busy" }
  | { kind: "fenced" }
  | { kind: "kept"; retryAfterMs?: number; reason: string }
  | { kind: "relogin"; reason: string };

type Pending = { login: Login; bySession: Map<string, StepUsage[]>; titles: Map<string, SessionTitle> };

function unsentTitle(state: SessionState, generation: string, queued: ReadonlySet<string>): SessionTitle | null {
  const title = state.title;
  if (!title || queued.has(title.title)) return null;
  return title.title === sentTitleIn(state, generation) || title.title === state.refusedTitle ? null : title;
}

async function queuedFor(dir: string, generation: string, sessionId: string) {
  const known: Record<string, string> = {};
  const calls = new Set<string>();
  const titles = new Set<string>();
  for (const { batch } of await queuedBatches(dir)) {
    if (batch.generation !== generation) continue;
    for (const s of batch.snapshots) if (s.sessionId === sessionId) known[hourKey(s)] = entriesDigest(s.entries);
    for (const c of batch.calls) if (c.sessionId === sessionId) for (const r of c.records) calls.add(r.key);
    for (const t of batch.sessions) if (t.sessionId === sessionId) titles.add(t.title);
  }
  return { known, calls, titles };
}

function failureOutcome(r: Extract<UsageResult<unknown>, { ok: false }>): Outcome {
  if (r.relogin) return { kind: "relogin", reason: r.reason };
  return { kind: "kept", reason: r.reason, ...(r.retryAfterMs === undefined ? {} : { retryAfterMs: r.retryAfterMs }) };
}

export const isRunCancelled = (r: UsageResult<unknown>) => !r.ok && r.status === 409 && /no longer current|unknown usage sync run|is complete/i.test(r.reason);

// Every 60 s and on kick() (turn end): changed session-hours and new calls -> batches.
// 409 generation -> reinitialize and capture again.
export function createUsagePump(deps: EvidenceDeps, options: UsagePumpOptions = {}): UsagePump {
  const { uploads, log } = deps;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const persistDelayMs = options.persistDelayMs ?? PERSIST_DELAY_MS;
  const makeClient = options.client ?? ((login: Login) => createUsageClient(login, uploads));

  let pending = new Map<string, Pending>();
  const dirty = new Map<string, Set<string>>();
  const restored = new Set<string>();
  let clientCache: { key: string; value: UsageClient } | null = null;
  let failures = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let started = false;
  let stopped = false;
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelledRuns = new Set<string>();

  const markDirty = (dir: string, sessionId: string) => {
    let set = dirty.get(dir);
    if (!set) dirty.set(dir, (set = new Set()));
    set.add(sessionId);
  };

  const scopeFor = (dir: string, login: Login) => {
    let scope = pending.get(dir);
    if (!scope) pending.set(dir, (scope = { login, bySession: new Map(), titles: new Map() }));
    return scope;
  };

  // Serialized so stop() can wait for a save that already took the pending steps.
  let persisting: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    persisting = persisting.then(persistNow, persistNow);
    return persisting;
  }

  async function persistNow(): Promise<void> {
    const taken = pending;
    pending = new Map();
    for (const [dir, { login, bySession, titles }] of taken) {
      for (const sessionId of new Set([...bySession.keys(), ...titles.keys()])) {
        const steps = bySession.get(sessionId) ?? [];
        const title = titles.get(sessionId);
        try {
          await updateSession(dir, sessionId, async (state) => {
            const merged = mergeSteps(state, steps);
            return [title ? noteTitle(merged, title) : merged, undefined];
          });
          markDirty(dir, sessionId);
        } catch (e) {
          log.warn("usage: could not save steps", { error: String(e) });
          const back = scopeFor(dir, login);
          back.bySession.set(sessionId, [...steps, ...(back.bySession.get(sessionId) ?? [])]);
          if (title && !back.titles.has(sessionId)) back.titles.set(sessionId, title);
        }
      }
    }
  }

  function schedulePersist(): void {
    if (persistTimer || stopped) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch(() => {});
    }, persistDelayMs);
    persistTimer.unref?.();
  }

  async function generationFor(dir: string, c: UsageClient, refresh: boolean): Promise<UsageResult<string>> {
    const stored = refresh ? null : await storedGeneration(dir);
    if (stored) return { ok: true, value: stored };
    const res = await c.initialize();
    if (!res.ok) return res;
    await setGeneration(dir, res.value.generation);
    return { ok: true, value: res.value.generation };
  }

  async function capture(dir: string, sessionId: string, generation: string, deviceName: string, run: RunTag | null, titles: boolean): Promise<void> {
    await updateSession(dir, sessionId, async (state) => {
      const queued = await queuedFor(dir, generation, sessionId);
      const known: Record<string, string> = run ? {} : { ...state.refused, ...acknowledgedIn(state, generation), ...queued.known };
      const knownCalls = new Set([...(state.refusedCalls ?? []), ...sentCallsIn(state, generation), ...queued.calls]);
      const changed = changedBuckets(bucketByHour(state.steps), known);
      const fresh = state.steps.filter((s) => !knownCalls.has(callKey(s)));
      const title = titles ? unsentTitle(state, generation, queued.titles) : null;
      if (changed.length || fresh.length || title) {
        const snapshots = changed.length ? toSnapshots(changed, await allocateRevision(dir)) : [];
        if (run) for (const s of snapshots) run.hours.add(runHour(s));
        const batches: UsageBatch[] = packBatches(toParts(snapshots, fresh, title ? [title] : [])).map((parts) => ({
          generation,
          batchId: newBatchId(),
          ...(run && parts.snapshots.length ? { runId: run.runId } : {}),
          ...(deviceName ? { deviceName } : {}),
          ...parts,
        }));
        await enqueueBatches(dir, batches);
      }
      return [state, undefined];
    });
  }

  async function recordAcks(dir: string, batch: UsageBatch, change: "ack" | "refuse"): Promise<void> {
    const bySession = new Map<string, { snapshots: UsageSnapshot[]; callKeys: string[]; title?: string }>();
    const own = (id: string) => {
      let entry = bySession.get(id);
      if (!entry) bySession.set(id, (entry = { snapshots: [], callKeys: [] }));
      return entry;
    };
    for (const s of batch.snapshots) own(s.sessionId).snapshots.push(s);
    for (const c of batch.calls) own(c.sessionId).callKeys.push(...c.records.map((r) => r.key));
    for (const t of batch.sessions) own(t.sessionId).title = t.title;
    for (const [sessionId, sent] of bySession)
      await updateSession(dir, sessionId, async (state) => [change === "refuse" ? refuse(state, sent) : acknowledge(state, batch.generation, sent), undefined]);
  }

  async function drain(dir: string, c: UsageClient): Promise<Outcome> {
    const release = await tryLock(queueLockPath(dir));
    if (!release) return { kind: "busy" };
    try {
      let items: QueuedBatch[];
      while ((items = await queuedBatches(dir)).length) {
        for (const item of items) {
          if (abandoned) return { kind: "kept", reason: "stopping" };
          if (item.batch.runId && cancelledRuns.has(item.batch.runId)) {
            await settle(item.file);
            continue;
          }
          const res = await c.send(item.batch);
          if (isFenced(res)) return { kind: "fenced" };
          if (res.ok) {
            await recordAcks(dir, item.batch, "ack");
            await settle(item.file);
            continue;
          }
          if (item.batch.runId && isRunCancelled(res)) {
            // The run's hours were also captured live, so dropping the tag keeps the usage itself.
            cancelledRuns.add(item.batch.runId);
            const { runId: _dropped, ...untagged } = item.batch;
            await enqueueBatches(dir, [{ ...untagged, batchId: newBatchId() }]);
            await settle(item.file);
            break;
          }
          if (res.relogin || res.retryable) return failureOutcome(res);
          const parts = splitParts(item.batch);
          if (parts.length > 1) {
            // Split so one bad session-hour does not hold back the rest; the outer loop re-reads the queue.
            await enqueueBatches(dir, parts.map((p) => ({ ...item.batch, batchId: newBatchId(), ...p })));
            await settle(item.file);
            break;
          }
          log.warn("usage: backend refused a snapshot", { reason: res.reason, status: res.status });
          await recordAcks(dir, item.batch, "refuse");
          await setAside(dir, item, res.reason);
        }
      }
      return { kind: "drained" };
    } finally {
      await release();
    }
  }

  async function prepare(): Promise<{ login: Login; dir: string; client: UsageClient } | null> {
    const login = uploads.login();
    if (!login) return null;
    await persist();
    const dir = scopeDir(deps.dataDir, login);
    if (!restored.has(dir)) {
      for (const id of await storedSessionIds(dir, SESSION_MAX_AGE_MS)) markDirty(dir, id);
      restored.add(dir);
    }
    const key = loginKey(login);
    if (clientCache?.key !== key) clientCache = { key, value: await makeClient(login) };
    return { login, dir, client: clientCache.value };
  }

  async function pass(only: { ids: readonly string[]; run: RunTag } | null): Promise<Outcome> {
    const ready = await prepare();
    if (!ready) return { kind: "drained" };
    const { login, dir, client: c } = ready;
    if (!only && !dirty.get(dir)?.size && !(await queuedBatches(dir)).length) return { kind: "drained" };

    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = await generationFor(dir, c, attempt > 0);
      if (!gen.ok) return failureOutcome(gen);
      const todo = only ? [...only.ids] : [...(dirty.get(dir) ?? [])];
      if (!only) dirty.set(dir, new Set());
      for (const [i, id] of todo.entries()) {
        try {
          await capture(dir, id, gen.value, login.deviceName, only?.run ?? null, c.titles);
          if (only) dirty.get(dir)?.delete(id);
        } catch (e) {
          if (!only) for (const left of todo.slice(i)) markDirty(dir, left);
          throw e;
        }
      }
      const outcome = await drain(dir, c);
      if (outcome.kind !== "fenced") return outcome;
      log.info("usage: the stream has a new generation, capturing again");
      await clearQueue(dir);
      only?.run.hours.clear();
      for (const id of await storedSessionIds(dir, SESSION_MAX_AGE_MS)) markDirty(dir, id);
    }
    return { kind: "kept", reason: "the stream generation kept changing" };
  }

  function delayAfter(outcome: Outcome): number {
    if (outcome.kind === "kept") log.warn("usage: upload kept for later", { reason: outcome.reason });
    if (outcome.kind === "relogin") log.warn("usage: relogin required", { reason: outcome.reason });
    if (outcome.kind === "drained" || outcome.kind === "busy" || outcome.kind === "relogin") {
      failures = 0;
      return intervalMs;
    }
    failures += 1;
    if (outcome.kind === "kept" && outcome.retryAfterMs !== undefined) return outcome.retryAfterMs;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    return Math.round(base * (0.5 + Math.random() / 2));
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref?.();
  }

  // Passes are serialized: a run pass waits for a live pass and the reverse.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  }

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let delay = intervalMs;
      do {
        again = false;
        try {
          delay = delayAfter(await serial(() => pass(null)));
        } catch (e) {
          log.warn("usage: pass failed", { error: String(e) });
          delay = delayAfter({ kind: "kept", reason: String(e) });
        }
      } while (again && !stopped && failures === 0);
      schedule(delay);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    name: "usage",
    start() {
      if (started) return;
      started = true;
      schedule(0);
    },
    kick() {
      if (started && !stopped && failures === 0) void run();
    },
    observeTitle(title) {
      const login = uploads.login();
      if (!login || stopped) return;
      const scope = scopeFor(scopeDir(deps.dataDir, login), login);
      if (scope.titles.get(title.sessionId)?.title !== title.title) scope.titles.set(title.sessionId, title);
      schedulePersist();
    },
    observe(step) {
      const login = uploads.login();
      if (!login || stopped) return;
      const scope = scopeFor(scopeDir(deps.dataDir, login), login);
      const list = scope.bySession.get(step.sessionId);
      if (list) list.push(step);
      else scope.bySession.set(step.sessionId, [step]);
      schedulePersist();
    },
    runPass(sessionIds, tag) {
      if (stopped) return Promise.resolve({ kind: "kept", reason: "stopping" });
      return serial(() => pass({ ids: sessionIds, run: tag }));
    },
    async dropRun(runId) {
      cancelledRuns.add(runId);
    },
    async client() {
      const ready = await prepare();
      return ready && { client: ready.client, dir: ready.dir, login: ready.login };
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (persistTimer) clearTimeout(persistTimer);
      timer = persistTimer = null;
      if (running) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([running, new Promise<void>((resolve) => (deadline = setTimeout(resolve, STOP_WAIT_MS)))]);
        clearTimeout(deadline);
      }
      abandoned = true;
      await persist();
    },
  };
}
