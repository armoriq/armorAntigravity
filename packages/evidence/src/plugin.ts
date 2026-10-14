import type { AuditRow, Decision } from "@armorantigravity/core";
import type { HookPayload, Surface } from "@armorantigravity/protocol";
import { attribute } from "./attribution.ts";
import type { EvidenceDeps, Uploads } from "./context.ts";
import { createAuditPump, type AuditPump } from "./pumps/audit.ts";
import { createHistoryPump, type HistoryPump } from "./pumps/history.ts";
import { createLatencyPump, type LatencyPump } from "./pumps/latency.ts";
import { createTracePump, type ModelCall, type TracePump, type ToolSpan } from "./pumps/traces.ts";
import { createUsagePump, type UsagePump } from "./pumps/usage.ts";
import { observeConversation } from "./usage/observe.ts";
import { EMPTY_SOURCE, type ConversationRef, type UsageSource } from "./usage/source.ts";

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
  reportStatus(status: number, body: unknown, source: "mint" | "upload"): void;
};

export type DaemonContextView = {
  readonly log: EvidenceDeps["log"];
  readonly paths: { readonly dataDir: string };
  readonly auth: AuthView;
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
  decided(call: DecidedCall): void;
  audit(row: AuditRow, context: { readonly surface: Surface }): void;
}

export type EvidenceOptions = {
  readonly source?: UsageSource;
  // The root conversation a subagent belongs to; identity until the spike shows how children name it.
  readonly rootOf?: (conversationId: string) => string;
};

export type EvidencePumps = { audit: AuditPump; traces: TracePump; usage: UsagePump; history: HistoryPump; latency: LatencyPump };

const MAX_OPEN_CALLS = 10_000;
const MAX_SEEN_KEYS = 50_000;
const SETTLE_MS = 1_000;

export const callIdOf = (conversationId: string, stepIdx: number) => `${conversationId}:${stepIdx}`;

export function uploadsFrom(auth: AuthView): Uploads {
  return {
    client: auth.client,
    headers: auth.headers,
    login: () => auth.uploadLogin(),
    report: (status, body) => auth.reportStatus(status, body, "upload"),
  };
}

export function createEvidence(deps: EvidenceDeps, options: EvidenceOptions = {}) {
  const source = options.source ?? EMPTY_SOURCE;
  const rootOf = options.rootOf ?? ((id: string) => id);
  const audit = createAuditPump(deps);
  const traces = createTracePump(deps);
  const usage = createUsagePump(deps);
  const history = createHistoryPump({ ...deps, usage, source, rootOf });
  const latency = createLatencyPump({ ...deps, usage });
  const pumps: EvidencePumps = { audit, traces, usage, history, latency };

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
      ok: payload.error === undefined,
      output: payload.error ?? "",
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
      if (s.at < since || seenCalls.has(key)) continue;
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
        case "auth":
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
    decided(call) {
      const callId = callIdOf(call.conversationId, call.stepIdx);
      const span: ToolSpan = { sessionId: rootOf(call.conversationId), callId, tool: call.tool, args: call.args, mcpServer: call.mcpServer };
      if (call.decision.kind === "allow") {
        decided.set(callId, span);
        bounded(decided, MAX_OPEN_CALLS);
      }
      inOrder("decision span", () => traces.record({ kind: "decision", call: span, decision: call.decision, at: call.at }));
    },
    audit: (row, { surface }) => audit.enqueue(attribute(row, surface)),
  };

  function start(): void {
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
      const evidence = createEvidence({ dataDir: ctx.paths.dataDir, uploads: uploadsFrom(ctx.auth), log: ctx.log }, options);
      options.onRecorder?.(evidence.recorder);
      evidence.start();
      const { audit, traces, usage, history, latency } = evidence.pumps;
      const tracesAfterSettle: Pump = {
        name: traces.name,
        kick: () => traces.kick(),
        stop: async () => {
          await evidence.settle();
          await traces.stop();
        },
      };
      // Traces stop first: closing a turn can still need the usage client; audit last, it has the most to flush.
      const pumps: readonly Pump[] = [tracesAfterSettle, latency, history, usage, audit];
      return { observe: evidence.observe, pumps };
    },
  };
}
