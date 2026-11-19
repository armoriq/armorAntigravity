import type { AuditRow, Decision, Login } from "@armorantigravity/core";
import type { HookPayload, Surface } from "@armorantigravity/protocol";
import { attribute } from "./attribution.ts";
import type { EvidenceDeps, Uploads } from "./context.ts";
import { createAuditPump, type AuditPump } from "./pumps/audit.ts";
import { createHistoryPump, type HistoryPump } from "./pumps/history.ts";
import { createHealthPump, type HealthPump } from "./pumps/health.ts";
import { createRunsPump, runReportingEnabled, type RunsPump } from "./pumps/runs.ts";
import { createLatencyPump, type LatencyPump } from "./pumps/latency.ts";
import { createTracePump, type ModelCall, type TracePump, type ToolSpan } from "./pumps/traces.ts";
import { createUsagePump, type UsagePump } from "./pumps/usage.ts";
import { observeConversation } from "./usage/observe.ts";
import { EMPTY_SOURCE, type ConversationRef, type UsageSource } from "./usage/source.ts";
import { auditLogin } from "./pumps/audit.ts";

// Structural slices of the daemon's plugin types (packages/daemon/src/plugin.ts), so the daemon
// can import this package without a cycle.
type SessionView = { readonly surface: Surface; readonly conversationId: string };
type HookView = { readonly receivedAt: number; readonly payload: HookPayload; readonly session: SessionView };
export type ObservedEvent =
  | { readonly kind: "session_start" | "turn_start" | "turn_end" | "session_end"; readonly session: SessionView; readonly at: number }
  | { readonly kind: "hook"; readonly hook: HookView; readonly at: number }
  | { readonly kind: "auth"; readonly at: number };

export type Pump = { readonly name: string; kick(): void; stop(): Promise<void> };

export type AuthView = {
  readonly client: Uploads["client"];
  readonly headers: Uploads["headers"];
  uploadLogin(): ReturnType<Uploads["login"]>;
  authenticationLogin?(): ReturnType<Uploads["login"]>;
  reportStatus(status: number, body: unknown, source: "mint" | "upload"): void;
  authenticationSucceeded?(login: Login): void;
  onAuthenticated?(listener: (login: Login) => void): () => void;
};

export type DaemonContextView = {
  readonly log: EvidenceDeps["log"];
  readonly paths: { readonly dataDir: string };
  readonly auth: AuthView;
  readonly runReportingEnabled?: boolean;
};

// What the decision plugin hands over: core's Decision for the trace and, when the call is
// audited, the row built by core's toAuditRow.
export type DecidedCall = {
  readonly conversationId: string;
  readonly stepIdx: number;
  readonly tool: string;
  readonly args: unknown;
  readonly mcpServer: string | null;
  readonly decision: Decision;
  readonly at: number;
};

export interface EvidenceRecorder {
  readonly health: Pick<HealthPump, "planRequestFailed" | "planRequestSucceeded">;
  readonly runs: RunsPump;
  decided(call: DecidedCall): void;
  audit(row: AuditRow, context: { readonly surface: Surface; readonly login?: Login }): void;
}

export type EvidenceOptions = {
  readonly runReportingEnabled?: boolean;
  readonly source?: UsageSource;
  // The root conversation a subagent belongs to; identity until the spike shows how children name it.
  readonly rootOf?: (conversationId: string) => string;
};

export type EvidencePumps = { audit: AuditPump; health: HealthPump; runs: RunsPump; traces: TracePump; usage: UsagePump; history: HistoryPump; latency: LatencyPump };

const MAX_OPEN_CALLS = 10_000;
const MAX_SEEN_KEYS = 50_000;
const SETTLE_MS = 1_000;

export const callIdOf = (conversationId: string, stepIdx: number) => `${conversationId}:${stepIdx}`;

export function uploadsFrom(auth: AuthView): Uploads {
  return {
    client: auth.client,
    headers: auth.headers,
    login: () => auth.uploadLogin(),
    probeLogin: () => auth.authenticationLogin ? auth.authenticationLogin() : auth.uploadLogin(),
    report: (status, body) => auth.reportStatus(status, body, "upload"),
    authenticationSucceeded: login => auth.authenticationSucceeded?.(login),
  };
}

export function createEvidence(deps: EvidenceDeps, options: EvidenceOptions = {}) {
  const source = options.source ?? EMPTY_SOURCE;
  const rootOf = options.rootOf ?? ((id: string) => id);
  const health = createHealthPump(deps);
  const audit = createAuditPump({ ...deps, health });
  let runs: RunsPump;
  try { runs = createRunsPump({ ...deps, health, enabled: options.runReportingEnabled ?? runReportingEnabled(process.env) }); }
  catch {
    deps.log.error("runs storage initialization failed; reporting disabled for this daemon");
    try { health.outbox.captureFailure(); } catch { deps.log.error("run capture failure count could not be saved"); }
    runs = createRunsPump({ ...deps, enabled: false });
  }
  const traces = createTracePump(deps);
  const usage = createUsagePump(deps);
  const history = createHistoryPump({ ...deps, usage, source, rootOf });
  const latency = createLatencyPump({ ...deps, usage });
  const pumps: EvidencePumps = { audit, health, runs, traces, usage, history, latency };

  const started = new Map<string, number>();
  const decided = new Map<string, ToolSpan>();
  const refs = new Map<string, ConversationRef>();
  const turnStarts = new Map<string, number>();
  const seenCalls = new Set<string>();
  const bootAt = Date.now();
  // Turn end reads the source before it closes the turn, so every trace record after it waits
  // in this chain; otherwise the next turn's start could overtake the previous turn's end.
  let tail: Promise<void> = Promise.resolve();
  const inOrder = (what: string, work: () => void | Promise<void>) => {
    tail = tail.then(work).catch((error) => deps.log.warn(`evidence: ${what} failed`, { error: String(error) }));
  };

  const bounded = <K, V>(map: Map<K, V>, max: number) => {
    if (map.size <= max) return;
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  };

  function rememberRef(session: SessionView, payload: HookPayload): void {
    refs.set(session.conversationId, {
      conversationId: session.conversationId,
      transcriptPath: payload.transcriptPath,
      workspacePaths: payload.workspacePaths,
      surface: session.surface,
    });
  }

  function onHook(hook: HookView): void {
    const { payload, session } = hook;
    rememberRef(session, payload);
    if (payload.event === "PreToolUse") {
      started.set(callIdOf(payload.conversationId, payload.stepIdx), hook.receivedAt);
      bounded(started, MAX_OPEN_CALLS);
      return;
    }
    if (payload.event !== "PostToolUse") return;
    const callId = callIdOf(payload.conversationId, payload.stepIdx);
    const begun = started.get(callId);
    started.delete(callId);
    const call = decided.get(callId) ?? {
      sessionId: rootOf(payload.conversationId),
      callId,
      tool: payload.toolCall.name,
      args: payload.toolCall.args,
      mcpServer: null,
    };
    decided.delete(callId);
    const span = {
      kind: "tool" as const,
      call,
      ok: payload.error === "",
      output: payload.error,
      durationMs: begun === undefined ? null : Math.max(0, hook.receivedAt - begun),
      at: hook.receivedAt,
    };
    inOrder("tool span", () => traces.record(span));
  }

  // Only this turn's steps become spans: every turn end re-reads the whole conversation, and
  // steps from before this daemon started were reported by the one that saw them.
  function freshCalls(since: number, steps: Awaited<ReturnType<typeof observeConversation>>["steps"]): ModelCall[] {
    const fresh: ModelCall[] = [];
    for (const s of steps) {
      const key = `${s.messageId}:${s.partId}`;
      // agy stamps transcript steps to the whole second; the turn start has milliseconds.
      if (s.at < Math.floor(since / 1000) * 1000 || seenCalls.has(key)) continue;
      seenCalls.add(key);
      fresh.push({ key, at: s.at, ...s.entry });
    }
    for (const key of seenCalls) {
      if (seenCalls.size <= MAX_SEEN_KEYS) break;
      seenCalls.delete(key);
    }
    return fresh;
  }

  // A subagent's turn belongs to its root's turn: its calls and model steps join the root's
  // trace, but only the root's own turn end closes that trace and its latency sample.
  async function endTurn(session: SessionView, at: number, since: number): Promise<void> {
    const rootId = rootOf(session.conversationId);
    const ref = refs.get(session.conversationId);
    if (ref) {
      const read = await observeConversation({ usage, source, ref, rootOf });
      for (const p of read.problems) deps.log.warn("usage: source not read", { problem: p });
      const fresh = freshCalls(since, read.steps);
      if (fresh.length) traces.record({ kind: "model", sessionId: rootId, calls: fresh });
    }
    if (rootId === session.conversationId) {
      traces.record({ kind: "turn_end", sessionId: rootId, at });
      latency.turnEnded(rootId, at);
    }
    for (const p of [audit, usage, traces, latency]) p.kick();
  }

  function observe(event: ObservedEvent): void {
    try {
      switch (event.kind) {
        case "hook":
          onHook(event.hook);
          return;
        case "turn_start": {
          const id = event.session.conversationId;
          const rootId = rootOf(id);
          turnStarts.set(id, event.at);
          bounded(turnStarts, MAX_OPEN_CALLS);
          if (rootId !== id) return;
          inOrder("turn start", () => traces.record({ kind: "turn_start", sessionId: rootId, at: event.at }));
          latency.turnStarted(rootId, event.at);
          return;
        }
        case "turn_end": {
          // Read now: the next turn's start may arrive before this end is processed.
          const since = turnStarts.get(event.session.conversationId) ?? bootAt;
          inOrder("turn end", () => endTurn(event.session, event.at, since));
          return;
        }
        case "session_end": {
          const id = event.session.conversationId;
          refs.delete(id);
          turnStarts.delete(id);
          // A session can end without a turn end; its open trace would otherwise stay open until shutdown.
          if (rootOf(id) === id) inOrder("session end", () => traces.record({ kind: "turn_end", sessionId: id, at: event.at }));
          audit.kick();
          return;
        }
        case "session_start":
          void audit.loginChanged(false);
          void health.loginChanged(false);
          void runs.loginChanged(false);
          return;
        case "auth":
          void audit.loginChanged();
          void health.loginChanged();
          void runs.loginChanged();
          return;
        default: {
          const exhaustive: never = event;
          void exhaustive;
        }
      }
    } catch (error) {
      deps.log.error("evidence: observe failed", { error: String(error) });
    }
  }

  const recorder: EvidenceRecorder = {
    health,
    runs,
    decided(call) {
      const callId = callIdOf(call.conversationId, call.stepIdx);
      const span: ToolSpan = { sessionId: rootOf(call.conversationId), callId, tool: call.tool, args: call.args, mcpServer: call.mcpServer };
      if (call.decision.kind === "allow") {
        decided.set(callId, span);
        bounded(decided, MAX_OPEN_CALLS);
      }
      inOrder("decision span", () => traces.record({ kind: "decision", call: span, decision: call.decision, at: call.at }));
    },
    audit: (row, { surface, login }) => audit.enqueue(attribute(row, surface), login),
  };

  function start(): void {
    health.start();
    runs.start();
    audit.start();
    traces.start();
    usage.start();
    history.start();
    latency.start();
  }

  // Trace records still waiting behind a turn end, bounded so a stuck source read cannot hold shutdown.
  async function settle(deadlineMs = SETTLE_MS): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([tail, new Promise<void>((resolve) => (deadline = setTimeout(resolve, deadlineMs)))]);
    clearTimeout(deadline);
  }

  return { observe, recorder, pumps, start, settle };
}

// The daemon plugin: registers the observer and the pumps; the recorder goes to the decision plugin.
export function evidencePlugin(options: EvidenceOptions & { onRecorder?: (recorder: EvidenceRecorder) => void } = {}) {
  return {
    name: "evidence",
    setup(ctx: DaemonContextView) {
      const evidence = createEvidence({ dataDir: ctx.paths.dataDir, uploads: uploadsFrom(ctx.auth), log: ctx.log }, { ...options, ...(ctx.runReportingEnabled === undefined ? {} : { runReportingEnabled: ctx.runReportingEnabled }) });
      options.onRecorder?.(evidence.recorder);
      evidence.start();
      const { audit, health, runs, traces, usage, history, latency } = evidence.pumps;
      const unsubscribe = ctx.auth.onAuthenticated?.(async login => {
        const binding = auditLogin(login);
        const restoring = [audit.authenticationSucceeded(login), health.outbox.authenticationSucceeded(binding).then(() => health.kick())];
        if (runs.enabled) restoring.push(runs.outbox.authenticationSucceeded(binding).then(() => runs.kick()));
        const results = await Promise.allSettled(restoring);
        if (results.some(result => result.status === "rejected")) ctx.log.error("reporting authentication restore failed");
      });
      const tracesAfterSettle: Pump = {
        name: traces.name,
        kick: () => traces.kick(),
        stop: async () => {
          await evidence.settle();
          await traces.stop();
        },
      };
      // Traces stop first: closing a turn can still need the usage client; audit follows, it has the most to flush.
      // Health stops after audit so its final loss reports remain durable.
      let auditStopping: Promise<void> | null = null;
      const stopAudit = () => (auditStopping ??= audit.stop());
      let runsStopping: Promise<void> | null = null;
      const stopRuns = () => (runsStopping ??= runs.stop());
      const auditBeforeHealth: Pump = { name: audit.name, kick: () => { void audit.kick(); }, stop: async () => { unsubscribe?.(); await stopAudit(); } };
      const healthAfterAudit: Pump = { name: health.name, kick: () => { void health.kick(); }, stop: async () => { await Promise.allSettled([stopAudit(), stopRuns()]); await health.stop(); } };
      const runsBeforeHealth: Pump = { name: runs.name, kick: () => { void runs.kick(); }, stop: stopRuns };
      const pumps: readonly Pump[] = [tracesAfterSettle, latency, history, usage, auditBeforeHealth, healthAfterAudit, runsBeforeHealth];
      return { observe: evidence.observe, pumps };
    },
  };
}
