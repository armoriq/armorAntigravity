import {
  DAEMON_UNAVAILABLE_CODE,
  DAEMON_UNAVAILABLE_REASON,
  fallbackResponse,
  HOOK_EVENTS,
  hookReplyLine,
  hookResponseLine,
  isHookEvent,
  parseHookFrame,
  parseHookPayload,
  PROTOCOL_VERSION,
  type DaemonResponse,
  type HookEvent,
  type HookResponse,
  type McpOutcomeResponse,
  type Mode,
} from "@armorantigravity/protocol";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { createAuth, type Auth } from "./auth.ts";
import { readConfig } from "./config.ts";
import { acquireInstanceLock } from "./lock.ts";
import { fileLog, type Log } from "./log.ts";
import { resolvePaths, type Env, type Paths } from "./paths.ts";
import type { DaemonEvent, DaemonPlugin, DecisionHandler, EventObserver, HookContext, McpOutcomeHandler, Pump } from "./plugin.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";
import { stubDecide } from "./stub.ts";
import { surfaceFromTranscriptPath } from "./surface.ts";
import { applyStagedUpdate, createUpdater, optedOut, readUpdateStatus, type Updater } from "./update.ts";

export const SESSION_IDLE_MS = 30 * 60 * 1000;
const IDLE_SWEEP_MS = 60_000;
const SHUTDOWN_BUDGET_MS = 10_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// Below sun_path on macOS (104) and Linux (108); libuv silently truncates a longer bind path.
const MAX_BIND_PATH_BYTES = 100;

export interface DaemonOptions {
  readonly env: Env;
  readonly plugins: readonly DaemonPlugin[];
  readonly log?: Log;
  readonly sessionIdleMs?: number;
  readonly authPollMs?: number;
  readonly updater?: Updater;
  // Called once a staged update is waiting and no session is open. The caller stops the daemon and
  // exits RESTART_EXIT_CODE, and the next start applies the update.
  readonly onRestartRequired?: (version: string) => void;
}

export interface RunningDaemon {
  readonly paths: Paths;
  readonly auth: Auth;
  stop(): Promise<void>;
}

export class AlreadyRunning extends Error {}

// A staged update was moved into place. The process must exit non-zero so launchd and systemd
// start the replaced binary; the running image is still the old one.
export class RestartRequired extends Error {
  constructor(readonly version: string) {
    super(`applied ArmorAntigravity ${version}; restarting into it`);
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.env);
  const log = opts.log ?? fileLog(paths.logFile, false);
  const lock = acquireInstanceLock(paths.lockFile);
  if (!lock) throw new AlreadyRunning(`another armoriq-agd holds ${paths.lockFile}`);

  const config = readConfig(paths.configFile, log);
  const applied = applyStagedUpdate({ log, env: opts.env, channel: config.channel, dataDir: paths.dataDir, binDir: paths.binDir });
  if (applied) {
    lock.release();
    throw new RestartRequired(applied);
  }
  const updater = opts.updater ?? createUpdater({ log, env: opts.env, channel: config.channel, dataDir: paths.dataDir, binDir: paths.binDir });
  const auth = createAuth(log, { env: opts.env, config, dataDir: paths.dataDir, ...(opts.authPollMs ? { pollMs: opts.authPollMs } : {}) });
  const sessions = createSessionStore(paths.sessionsDir);
  const idleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS;
  const pumps: Pump[] = [];
  const abort = async (error: unknown): Promise<never> => {
    await Promise.allSettled([...pumps.map((p) => p.stop()), updater.stop()]);
    auth.stop();
    lock.release();
    throw error;
  };

  let decide: DecisionHandler | null = null;
  let mcpOutcome: McpOutcomeHandler | null = null;
  const observers: EventObserver[] = [];
  const ctx = { log, paths, auth, sessions };
  try {
    for (const plugin of opts.plugins) {
      const reg = await plugin.setup(ctx);
      pumps.push(...(reg.pumps ?? []));
      if (reg.decide) {
        if (decide) throw new Error(`plugin ${plugin.name} registers a second decision handler`);
        decide = reg.decide;
      }
      if (reg.mcpOutcome) {
        if (mcpOutcome) throw new Error(`plugin ${plugin.name} registers a second MCP outcome handler`);
        mcpOutcome = reg.mcpOutcome;
      }
      if (reg.observe) observers.push(reg.observe);
      log.info("plugin registered", { plugin: plugin.name, decide: !!reg.decide, observe: !!reg.observe, pumps: (reg.pumps ?? []).map((p) => p.name) });
    }
  } catch (error) {
    return abort(error);
  }
  if (!decide) log.warn("no decision handler registered; using the allow-all stub until packages/core lands");
  const handler: DecisionHandler = decide ?? stubDecide;

  const emit = (event: DaemonEvent) => {
    for (const observe of observers) {
      try {
        observe(event);
      } catch (error) {
        log.error("observer failed", { kind: event.kind, error: String(error) });
      }
    }
  };
  const kickAll = () => pumps.forEach((p) => p.kick());

  publishMode(paths, auth.mode(), log);
  let lastUploadLogin = auth.uploadLogin();
  const unsubscribe = auth.onChange((state) => {
    publishMode(paths, auth.mode(), log);
    emit({ kind: "auth", state, at: Date.now() });
    const uploadLogin = auth.uploadLogin();
    if (uploadLogin && uploadLogin !== lastUploadLogin) kickAll();
    lastUploadLogin = uploadLogin;
  });

  const inflight = new Set<Promise<void>>();
  let restartRequested = false;
  const connections = new Set<Socket>();
  const server = await listen(paths.socket, (socket) => serve(socket)).catch(abort);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.idle(now, idleMs)) {
      emit({ kind: "session_end", session, at: now });
      sessions.close(session.key);
    }
    if (opts.onRestartRequired && !restartRequested && !optedOut(opts.env) && inflight.size === 0 && isEmpty(sessions.all())) {
      const staged = readUpdateStatus(paths.dataDir).stagedVersion;
      if (staged) {
        restartRequested = true;
        log.info("no session is open; restarting to apply the staged update", { version: staged });
        opts.onRestartRequired(staged);
      }
    }
  }, Math.min(IDLE_SWEEP_MS, idleMs));
  sweep.unref?.();

  log.info("armoriq-agd started", { pid: process.pid, socket: paths.socket, mode: auth.mode(), auth: auth.state().kind, pumps: pumps.length });
  updater.start();

  function serve(socket: Socket): void {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) return void socket.destroy();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const done = handleLine(line).then((res) => {
          if (!socket.destroyed) socket.write(res.reply);
          if (res.event) setImmediate(emit, res.event);
        });
        inflight.add(done);
        void done.finally(() => inflight.delete(done));
      }
    });
  }

  // The hook client's reply is the response on its own line, so a client with no JSON reader can print it
  // unchanged. An empty line is the null response, which it prints as nothing.
  async function handleLine(line: string): Promise<{ reply: string; event: DaemonEvent | null }> {
    const frame = parseHookFrame(line);
    if (frame) {
      const { response, event } = await handleHook(crypto.randomUUID(), frame.event, frame.receivedAt, frame.payload);
      return { reply: hookReplyLine(response), event };
    }
    const json = await handleJsonLine(line);
    return { reply: `${JSON.stringify(json.reply)}\n`, event: json.event };
  }

  async function handleJsonLine(line: string): Promise<{ reply: DaemonResponse | McpOutcomeResponse; event: DaemonEvent | null }> {
    const mode = auth.mode();
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      log.warn("unparseable request line");
      return { reply: { v: PROTOCOL_VERSION, id: "", response: null }, event: null };
    }
    const outcome = parseMcpOutcome(raw);
    if (outcome) {
      const text = mcpOutcome ? await mcpOutcome(outcome.tool, outcome.args, outcome.waitMs).catch(() => null) : null;
      return { reply: { v: PROTOCOL_VERSION, id: outcome.id, text }, event: null };
    }
    const envelope = parseEnvelope(raw);
    if (!envelope.ok) {
      log.warn("rejected request", { reason: envelope.reason, id: envelope.id });
      const response = envelope.event ? fallbackResponse(envelope.event, mode, "protocol_mismatch", envelope.reason) : null;
      return { reply: { v: PROTOCOL_VERSION, id: envelope.id, response }, event: null };
    }
    const { id, event, receivedAt } = envelope;
    const handled = await handleHook(id, event, receivedAt, envelope.payload);
    return { reply: { v: PROTOCOL_VERSION, id, response: handled.response }, event: handled.event };
  }

  async function handleHook(id: string, event: HookEvent, receivedAt: number, rawPayload: unknown): Promise<{ response: HookResponse; event: DaemonEvent | null }> {
    const mode = auth.mode();
    const payload = parseHookPayload(event, rawPayload);
    if (!payload) {
      log.warn("malformed hook payload", { id, event });
      return { response: fallbackResponse(event, mode, "malformed_payload", "the hook payload is missing required fields"), event: null };
    }

    const now = Date.now();
    const surface = surfaceFromTranscriptPath(payload.transcriptPath);
    const { session, created } = sessions.open(surface, payload.conversationId, now);
    if (created) emit({ kind: "session_start", session, at: now });
    // agy fires Pre/PostInvocation around every model call; invocationNum 0 is the first call for a
    // user message, and Stop ends the turn. A new first call also closes a turn whose Stop never came.
    const firstCall = event === "PreInvocation" && payload.event === "PreInvocation" && payload.invocationNum === 0;
    if (firstCall) {
      if (session.turnStartedAt !== null) {
        sessions.endTurn(session.key);
        emit({ kind: "turn_end", session, at: now });
      }
      sessions.beginTurn(session.key, now);
      emit({ kind: "turn_start", session, at: now });
    }

    const hook: HookContext = { id, receivedAt, event, payload, session, mode, auth: auth.state() };
    let response: HookResponse;
    try {
      response = await handler(hook);
    } catch (error) {
      log.error("decision handler failed", { id, event, error: String(error) });
      response = fallbackResponse(event, mode, "internal_error", "guard error");
    }

    if (event === "Stop") {
      sessions.endTurn(session.key);
      setImmediate(() => {
        emit({ kind: "turn_end", session, at: Date.now() });
        kickAll();
      });
    }
    return { response, event: { kind: "hook", hook, response, at: Date.now() } };
  }

  let stopping: Promise<void> | null = null;
  return {
    paths,
    auth,
    stop: () =>
      (stopping ??= (async () => {
        log.info("armoriq-agd stopping", { inflight: inflight.size });
        clearInterval(sweep);
        await updater.stop();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        await withDeadline(Promise.allSettled([...inflight]), SHUTDOWN_BUDGET_MS);
        for (const socket of connections) socket.destroy();
        await closed;
        const results = await withDeadline(Promise.allSettled(pumps.map((p) => p.stop())), SHUTDOWN_BUDGET_MS);
        results?.forEach((r, i) => r.status === "rejected" && log.error("pump stop failed", { pump: pumps[i]?.name, error: String(r.reason) }));
        if (!results) log.error("pumps did not flush within the shutdown budget");
        await sessions.flush();
        unsubscribe();
        auth.stop();
        removeQuietly(paths.socket);
        lock.release();
        log.info("armoriq-agd stopped");
      })()),
  };
}

type Envelope =
  | { ok: true; id: string; receivedAt: number; event: HookEvent; payload: unknown }
  | { ok: false; id: string; event: HookEvent | null; reason: string };

function parseEnvelope(raw: unknown): Envelope {
  if (typeof raw !== "object" || raw === null) return { ok: false, id: "", event: null, reason: "request is not an object" };
  const id = "id" in raw && typeof raw.id === "string" ? raw.id : "";
  const event = "event" in raw && isHookEvent(raw.event) ? raw.event : null;
  if (!("v" in raw) || raw.v !== PROTOCOL_VERSION) return { ok: false, id, event, reason: `unsupported protocol version, expected ${PROTOCOL_VERSION}` };
  if (!id || !event) return { ok: false, id, event, reason: "request needs an id and a known event" };
  const receivedAt = "receivedAt" in raw && typeof raw.receivedAt === "number" ? raw.receivedAt : Date.now();
  return { ok: true, id, receivedAt, event, payload: "payload" in raw ? raw.payload : undefined };
}

const MAX_OUTCOME_WAIT_MS = 10_000;

function parseMcpOutcome(raw: unknown): { id: string; tool: string; args: unknown; waitMs: number } | null {
  if (typeof raw !== "object" || raw === null || !("kind" in raw) || raw.kind !== "mcp_outcome") return null;
  if (!("v" in raw) || raw.v !== PROTOCOL_VERSION || !("id" in raw) || typeof raw.id !== "string" || !("tool" in raw) || typeof raw.tool !== "string") return null;
  const waitMs = "waitMs" in raw && typeof raw.waitMs === "number" && raw.waitMs > 0 ? Math.min(raw.waitMs, MAX_OUTCOME_WAIT_MS) : 0;
  return { id: raw.id, tool: raw.tool, args: "args" in raw ? raw.args : undefined, waitMs };
}

// The instance lock is held, so any socket file left here belongs to a dead daemon.
function listen(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  removeQuietly(socketPath);
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    server.once("error", reject);
    const ready = () => {
      try {
        chmodSync(socketPath, 0o600);
        resolve(server);
      } catch (error) {
        server.close();
        reject(error);
      }
    };
    if (Buffer.byteLength(socketPath) <= MAX_BIND_PATH_BYTES) return void server.listen(socketPath, ready);
    // A path too long for sun_path is bound from its own directory, the way agd-hook dials it
    // (dial_from_directory). Node binds a pipe synchronously inside listen(), so the cwd is restored at once.
    const cwd = process.cwd();
    process.chdir(path.dirname(socketPath));
    try {
      server.listen(path.basename(socketPath), ready);
    } finally {
      process.chdir(cwd);
    }
  });
}

// The mode, and the answer the hook prints for each event while the daemon is unreachable. Both are
// published here so they cannot drift: the hook never builds a response, it copies one of these files.
function publishMode(paths: Paths, mode: Mode, log: Log): void {
  writeAtomic(paths.modeFile, `${mode}\n`, log);
  try {
    mkdirSync(paths.fallbackDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return log.error("fallback directory create failed", { dir: paths.fallbackDir, error: String(error) });
  }
  for (const event of HOOK_EVENTS) {
    const line = hookResponseLine(fallbackResponse(event, mode, DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_REASON));
    writeAtomic(path.join(paths.fallbackDir, event), line, log);
  }
}

function writeAtomic(file: string, contents: string, log: Log): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    log.error("state file write failed", { file, error: String(error) });
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(resolve, ms, null)));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isEmpty(items: Iterable<unknown>): boolean {
  for (const _ of items) return false;
  return true;
}
