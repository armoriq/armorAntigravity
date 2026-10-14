import { redactText, sanitizeParams, type Decision, type Login, type TokenUsageEntry } from "@armorantigravity/core";
import type { ArmorIQTelemetryRuntime, OtelSession, PolicyResult, TelemetryRuntimeOptions } from "@armoriq/sdk-dev";
import { createHash } from "node:crypto";
import { AGENT_ID, PRODUCT, type EvidenceDeps } from "../context.ts";
import { createTraceSpool, type ShipRound, type TraceSpool } from "../io/trace-spool.ts";
import { canonicalModel } from "../model.ts";

export type ModelCall = TokenUsageEntry & { readonly key: string; readonly at: number };

export type ToolSpan = {
  readonly sessionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly mcpServer: string | null;
};

export type TraceEvent =
  | { readonly kind: "turn_start"; readonly sessionId: string; readonly at: number }
  | { readonly kind: "decision"; readonly call: ToolSpan; readonly decision: Decision; readonly at: number }
  | { readonly kind: "tool"; readonly call: ToolSpan; readonly ok: boolean; readonly output: string; readonly durationMs: number | null; readonly at: number }
  | { readonly kind: "model"; readonly sessionId: string; readonly calls: readonly ModelCall[] }
  | { readonly kind: "turn_end"; readonly sessionId: string; readonly at: number };

export interface TracePump {
  readonly name: "traces";
  record(event: TraceEvent): void;
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}

export type TracePumpOptions = {
  intervalMs?: number;
  stopDeadlineMs?: number;
  runtimeOptions?: Partial<TelemetryRuntimeOptions>;
  spool?: TraceSpool;
};

const INTERVAL_MS = 5_000;
const MAX_BUFFERED = 5_000;
const STOP_DEADLINE_MS = 2_000;
const SHIP_DEADLINE_MS = 15_000;

type Sdk = typeof import("@armoriq/sdk-dev");
type Turn = { session: OtelSession; lastAt: number };
type Shipper = { key: string; rt: ArmorIQTelemetryRuntime; turnRuntime: () => ArmorIQTelemetryRuntime };

const loginKey = (l: Login) => JSON.stringify([l.backend, l.apiKey]);

// If a sanitizer throws, content is withheld rather than exported raw.
function safeArgs(value: unknown): Record<string, unknown> {
  try {
    return sanitizeParams(value);
  } catch {
    return {};
  }
}

function safeText(text: string): string {
  try {
    return redactText(text);
  } catch {
    return "";
  }
}

export function policyResult(decision: Decision): PolicyResult {
  switch (decision.kind) {
    case "deny":
      return { decision: "block", policyReasonCode: decision.code, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
    case "hold":
      return { decision: "hold", policyReasonCode: "require_approval", ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
    case "allow":
      return { decision: "allow", ...(decision.paramMismatch ? { policyReasonCode: "intent_param_mismatch" } : {}) };
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function toolOperation(call: ToolSpan) {
  return call.mcpServer === null
    ? { category: "tool" as const }
    : { category: "mcp" as const, toolType: "mcp" as const, mcpServer: call.mcpServer };
}

function modelValues(call: ModelCall): Record<string, unknown> {
  // No cost: conmap prices the span itself from the model id, and treats a producer's cost as untrusted.
  return {
    "gen_ai.usage.input_tokens": call.inputTokens,
    "gen_ai.usage.output_tokens": call.outputTokens,
    "gen_ai.usage.cache_read_tokens": call.cacheReadTokens,
    "gen_ai.usage.cache_write_tokens": call.cacheWriteTokens,
  };
}

// A root span per turn, each on its own runtime because OtelSession.close() closes its runtime.
// Turn runtimes write every span to the disk spool; one long-lived runtime per login ships it, so a
// daemon exit between a turn and its upload loses nothing.
export function createTracePump(deps: EvidenceDeps, options: TracePumpOptions = {}): TracePump {
  const { uploads, log } = deps;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const stopDeadlineMs = options.stopDeadlineMs ?? STOP_DEADLINE_MS;
  const spool = options.spool ?? createTraceSpool(deps.dataDir, log);
  let buffer: TraceEvent[] = [];
  let dropped = 0;
  const turns = new Map<string, Turn>();
  let sdk: Sdk | null = null;
  let shipper: Shipper | null = null;
  let running: Promise<void> | null = null;
  let applying: Promise<Shipper | null> | null = null;
  let shipping: Promise<ShipRound> | null = null;
  let again = false;
  let started = false;
  let stopping = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function loadSdk(): Promise<Sdk> {
    sdk ??= await import("@armoriq/sdk-dev");
    return sdk;
  }

  async function shipperFor(login: Login): Promise<Shipper> {
    const key = loginKey(login);
    if (shipper?.key === key) return shipper;
    if (shipper) await closeAll();
    const s = await loadSdk();
    // Turns share the lease the shipper fetched instead of each asking the backend.
    let stored: unknown = null;
    const leaseStore = {
      read: async () => stored,
      write: async (record: unknown) => void (stored = record),
    };
    const make = () =>
      new s.ArmorIQTelemetryRuntime({
        backendEndpoint: login.backend,
        apiKey: login.apiKey,
        client: uploads.client,
        sdkVersion: typeof s.VERSION === "string" ? s.VERSION : "unknown",
        options: { serviceName: PRODUCT },
        spanSink: spool.sink,
        leaseStore,
        onReloginRequired: (event) => uploads.report(event.status, { error: "relogin_required" }),
        ...options.runtimeOptions,
      });
    shipper = { key, rt: make(), turnRuntime: make };
    return shipper;
  }

  // Local only: each open turn's spans land in the spool, nothing waits on the network.
  async function closeTurns(): Promise<void> {
    const open = [...turns.values()];
    turns.clear();
    await Promise.allSettled(open.map((t) => t.session.close({ status: "ok", taskOutcome: "unknown", endTime: new Date(t.lastAt) })));
  }

  async function closeAll(): Promise<void> {
    await closeTurns();
    const current = shipper;
    shipper = null;
    if (!current) return;
    await (shipping ?? spool.ship(current.rt, { deadlineMs: stopDeadlineMs })).catch(() => {});
    await current.rt.close().catch(() => {});
  }

  async function openTurn(sh: Shipper, login: Login, sessionId: string, at: number): Promise<Turn> {
    const s = await loadSdk();
    const session = new s.OtelSession(sh.turnRuntime(), { sessionId, agentId: AGENT_ID, userId: login.userId || null, root: { startTime: new Date(at) } });
    await session.refreshPolicy();
    await session.beginRoot({});
    const turn = { session, lastAt: at };
    turns.set(sessionId, turn);
    return turn;
  }

  // Closing the session ends the root, closes its runtime and with it writes every span to the spool.
  async function endTurn(sessionId: string, at: number): Promise<void> {
    const turn = turns.get(sessionId);
    if (!turn) return;
    turns.delete(sessionId);
    await turn.session.close({ status: "ok", endTime: new Date(Math.max(at, turn.lastAt)) });
  }

  async function turnFor(sh: Shipper, login: Login, sessionId: string, at: number): Promise<Turn> {
    const turn = turns.get(sessionId) ?? (await openTurn(sh, login, sessionId, at));
    turn.lastAt = Math.max(turn.lastAt, at);
    return turn;
  }

  async function apply(sh: Shipper, login: Login, e: TraceEvent): Promise<void> {
    switch (e.kind) {
      case "turn_start":
        await endTurn(e.sessionId, e.at);
        await openTurn(sh, login, e.sessionId, e.at);
        return;
      case "decision": {
        const turn = await turnFor(sh, login, e.call.sessionId, e.at);
        await turn.session.recordPolicy(
          { toolName: e.call.tool, toolCallId: e.call.callId, arguments: safeArgs(e.call.args), operation: toolOperation(e.call) },
          policyResult(e.decision),
          { endTime: new Date(e.at) },
        );
        return;
      }
      case "tool": {
        const turn = await turnFor(sh, login, e.call.sessionId, e.at);
        await turn.session.recordTool(
          { toolName: e.call.tool, toolCallId: e.call.callId, arguments: safeArgs(e.call.args), operation: toolOperation(e.call) },
          {
            outcome: e.ok ? "success" : "error",
            result: safeArgs({ output: safeText(e.output) }),
            ...(e.durationMs === null ? {} : { durationMs: e.durationMs }),
          },
          { endTime: new Date(e.at) },
        );
        return;
      }
      case "model": {
        const last = e.calls.reduce((n, c) => Math.max(n, c.at), 0);
        if (!last) return;
        const turn = await turnFor(sh, login, e.sessionId, last);
        // Same span id as the SDK's recordUsageCallSpans, so a resent call replaces its span.
        for (const call of e.calls) {
          const spanId = createHash("sha256").update(call.key).digest("hex").slice(0, 16);
          await turn.session.recordModel(canonicalModel(call.model), modelValues(call), { endTime: new Date(call.at) }, { spanId });
        }
        return;
      }
      case "turn_end":
        await endTurn(e.sessionId, e.at);
        return;
      default: {
        const exhaustive: never = e;
        void exhaustive;
      }
    }
  }

  async function applyBuffered(): Promise<Shipper | null> {
    const login = uploads.login();
    if (!login) {
      buffer = [];
      return null;
    }
    const sh = await shipperFor(login);
    const events = buffer;
    buffer = [];
    if (dropped) {
      log.warn("traces: buffer full, events dropped", { dropped });
      dropped = 0;
    }
    for (const e of events) {
      try {
        await apply(sh, login, e);
      } catch (err) {
        log.warn("traces: event not recorded", { kind: e.kind, error: String(err) });
      }
    }
    return sh;
  }

  async function pass(): Promise<void> {
    applying = applyBuffered();
    const sh = await applying.finally(() => (applying = null));
    if (!sh || stopping) return;
    shipping = spool.ship(sh.rt, { deadlineMs: SHIP_DEADLINE_MS });
    const round = await shipping.finally(() => (shipping = null));
    if (round.failed) log.warn("traces: spool ship incomplete", round);
    if (round.more) again = true;
  }

  function run(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (err) {
          log.warn("traces: pass failed", { error: String(err) });
        }
      } while (again && !stopping);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    name: "traces",
    start() {
      if (started) return;
      started = true;
      timer = setInterval(() => void run(), intervalMs);
      timer.unref?.();
      void run();
    },
    kick() {
      if (started) void run();
    },
    record(event) {
      if (stopped) return;
      if (buffer.length >= MAX_BUFFERED) dropped += 1;
      else buffer.push(event);
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      // Spans reach the spool before anything waits on the network, so a slow backend at
      // shutdown costs only the final upload, which the next daemon retries from disk.
      const work = (async () => {
        await applying?.catch(() => null);
        await applyBuffered().catch(() => null);
        stopped = true;
        await closeAll();
      })();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([work, new Promise<void>((resolve) => (deadline = setTimeout(resolve, stopDeadlineMs * 2)))]);
      stopped = true;
      clearTimeout(deadline);
    },
  };
}
