import type { Login } from "@armorantigravity/core";
import type { UsageRunReport } from "@armoriq/sdk-dev";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceDeps } from "../context.ts";
import { writeJson, type UsageClient } from "../io/backend-usage.ts";
import { authHeaders, isRecord, parseJson } from "../io/http.ts";
import { observeConversation } from "../usage/observe.ts";
import type { ConversationRef, UsageSource } from "../usage/source.ts";
import type { Outcome, RunTag, UsagePump } from "./usage.ts";

type Mode = UsageRunReport["mode"];
type Run = { mode: Mode; runId: string; requestId: string | null; sequence: number; hours: string[] };
type State = { discovered: boolean; discovery: Run | null; history: Run | null };

export interface HistoryPump {
  readonly name: "history";
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}

export type HistoryOptions = { intervalMs?: number; firstDelayMs?: number; timeoutMs?: number; stopDeadlineMs?: number };

const INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 10_000;
const TIMEOUT_MS = 8_000;
const STOP_DEADLINE_MS = 2_000;

function parseRun(v: unknown): Run | null {
  if (!isRecord(v)) return null;
  const { mode, runId, requestId, sequence, hours } = v;
  if ((mode !== "history" && mode !== "discovery") || typeof runId !== "string" || typeof sequence !== "number") return null;
  if (requestId !== null && typeof requestId !== "string") return null;
  const list = Array.isArray(hours) ? hours.filter((h): h is string => typeof h === "string") : [];
  return { mode, runId, requestId, sequence, hours: list };
}

function parseState(raw: unknown): State {
  if (!isRecord(raw)) return { discovered: false, discovery: null, history: null };
  return { discovered: raw.discovered === true, discovery: parseRun(raw.discovery), history: parseRun(raw.history) };
}

// GET /api-keys/device-history-sync: the open request for this key's device and product, or null.
export async function pendingHistoryRequest(login: Login, deps: EvidenceDeps, timeoutMs = TIMEOUT_MS): Promise<{ ok: true; requestId: string | null } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${login.backend}/api-keys/device-history-sync?deviceId=${encodeURIComponent(login.deviceId)}`, {
      headers: authHeaders(login, deps.uploads),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = parseJson(await res.text());
    deps.uploads.report(res.status, body);
    if (!res.ok) return { ok: false, reason: `device-history-sync returned ${res.status}` };
    return { ok: true, requestId: isRecord(body) && typeof body.requestId === "string" ? body.requestId : null };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

// Discovery uploads every conversation already on disk once per login; a history request from
// the console resends all of them under one run so conmap can mark the request complete.
export function createHistoryPump(deps: EvidenceDeps & { usage: UsagePump; source: UsageSource; rootOf: (conversationId: string) => string }, options: HistoryOptions = {}): HistoryPump {
  const { log, usage, source } = deps;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const statePath = (dir: string) => path.join(dir, "runs.json");
  const readState = async (dir: string) => parseState(parseJson(await readFile(statePath(dir), "utf8").catch(() => "")));

  async function report(client: UsageClient, run: Run, phase: UsageRunReport["phase"], extra: Partial<UsageRunReport> = {}) {
    run.sequence += 1;
    const res = await client.reportRun(run.runId, {
      mode: run.mode,
      ...(run.requestId ? { requestId: run.requestId } : {}),
      sequence: run.sequence,
      phase,
      discovered: run.hours.length,
      ...extra,
    });
    if (!res.ok) log.warn("history: run report refused", { mode: run.mode, phase, reason: res.reason });
    return res;
  }

  // Reads every conversation into the usage state; returns the root ids that got steps or a title.
  async function load(refs: readonly ConversationRef[]): Promise<{ ids: string[]; unread: number }> {
    const ids = new Set<string>();
    let unread = 0;
    for (const ref of refs) {
      const root = await observeConversation({ usage, source, ref, rootOf: deps.rootOf });
      if (root.problems.length) unread += 1;
      if (root.observed) ids.add(root.rootId);
    }
    return { ids: [...ids], unread };
  }

  async function runOnce(client: UsageClient, run: Run, save: () => Promise<void>): Promise<boolean> {
    if (run.sequence === 0) {
      const opened = await report(client, run, "discovering");
      if (!opened.ok) return false;
      await save();
    }
    const { ids, unread } = await load(await source.list());
    const tag: RunTag = { runId: run.runId, hours: new Set(run.hours) };
    const outcome: Outcome = await usage.runPass(ids, tag);
    run.hours = [...tag.hours];
    await save();
    if (outcome.kind === "drained" && !unread) {
      const done = await report(client, run, "complete", { total: run.hours.length });
      if (done.ok) log.info("history: run complete", { mode: run.mode, hours: run.hours.length });
      return done.ok;
    }
    const retryAt = new Date(Date.now() + intervalMs).toISOString();
    await report(client, run, outcome.kind === "drained" ? "uploading" : "retrying", {
      retryAt,
      ...(unread ? { errorCode: "source_unreadable" } : outcome.kind === "drained" ? {} : { errorCode: "upload_failed" }),
    });
    await save();
    return false;
  }

  async function pass(): Promise<void> {
    const ready = await usage.client();
    if (!ready) return;
    const { client, dir, login } = ready;
    const state = await readState(dir);
    const save = () => writeJson(statePath(dir), state);

    const request = await pendingHistoryRequest(login, deps, options.timeoutMs);
    if (request.ok && (state.history?.requestId ?? null) !== request.requestId) {
      if (state.history) await usage.dropRun(state.history.runId);
      state.history = request.requestId ? { mode: "history", runId: randomUUID(), requestId: request.requestId, sequence: 0, hours: [] } : null;
      await save();
    }
    if (state.history && (await runOnce(client, state.history, save))) {
      state.history = null;
      state.discovered = true;
      state.discovery = null;
      await save();
    }
    if (!state.discovered) {
      state.discovery ??= { mode: "discovery", runId: randomUUID(), requestId: null, sequence: 0, hours: [] };
      if (await runOnce(client, state.discovery, save)) {
        state.discovered = true;
        state.discovery = null;
        await save();
      }
    }
  }

  function run(): void {
    if (stopped || running) return;
    running = pass()
      .catch((error) => log.warn("history: pass failed", { error: String(error) }))
      .finally(() => {
        running = null;
        schedule(intervalMs);
      });
  }

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
    timer.unref?.();
  }

  return {
    name: "history",
    start: () => schedule(options.firstDelayMs ?? FIRST_DELAY_MS),
    kick: () => undefined,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // A pass can read every conversation; its run state is saved as it goes, so it is not awaited past the deadline.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([running, new Promise<void>((resolve) => (deadline = setTimeout(resolve, options.stopDeadlineMs ?? STOP_DEADLINE_MS)))]);
      clearTimeout(deadline);
    },
  };
}
