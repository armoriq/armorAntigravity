import {
  fallbackResponse,
  isHookEvent,
  parseHookPayload,
  PROTOCOL_VERSION,
  type DaemonResponse,
  type HookEvent,
  type HookResponse,
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
import type { DaemonEvent, DaemonPlugin, DecisionHandler, EventObserver, HookContext, Pump } from "./plugin.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";
import { stubDecide } from "./stub.ts";
import { surfaceFromTranscriptPath } from "./surface.ts";

export const SESSION_IDLE_MS = 30 * 60 * 1000;
const IDLE_SWEEP_MS = 60_000;
const SHUTDOWN_BUDGET_MS = 10_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface DaemonOptions {
  readonly env: Env;
  readonly plugins: readonly DaemonPlugin[];
  readonly log?: Log;
  readonly sessionIdleMs?: number;
  readonly authPollMs?: number;
}

export interface RunningDaemon {
  readonly paths: Paths;
  readonly auth: Auth;
  stop(): Promise<void>;
}

export class AlreadyRunning extends Error {}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.env);
  const log = opts.log ?? fileLog(paths.logFile, false);
  const lock = acquireInstanceLock(paths.lockFile);
  if (!lock) throw new AlreadyRunning(`another armoriq-agd holds ${paths.lockFile}`);

  const config = readConfig(paths.configFile, log);
  const auth = createAuth(log, { env: opts.env, config, dataDir: paths.dataDir, ...(opts.authPollMs ? { pollMs: opts.authPollMs } : {}) });
  const sessions = createSessionStore(paths.sessionsDir);
  const idleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS;
  const pumps: Pump[] = [];
  const abort = async (error: unknown): Promise<never> => {
    await Promise.allSettled(pumps.map((p) => p.stop()));
    auth.stop();
    lock.release();
    throw error;
  };

  let decide: DecisionHandler | null = null;
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

  writeMode(paths.modeFile, auth.mode(), log);
  let lastUploadLogin = auth.uploadLogin();
  const unsubscribe = auth.onChange((state) => {
    writeMode(paths.modeFile, auth.mode(), log);
    emit({ kind: "auth", state, at: Date.now() });
    const uploadLogin = auth.uploadLogin();
    if (uploadLogin && uploadLogin !== lastUploadLogin) kickAll();
    lastUploadLogin = uploadLogin;
  });

  const inflight = new Set<Promise<void>>();
  const connections = new Set<Socket>();
  const server = await listen(paths.socket, (socket) => serve(socket)).catch(abort);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.idle(now, idleMs)) {
      emit({ kind: "session_end", session, at: now });
      sessions.close(session.key);
    }
  }, Math.min(IDLE_SWEEP_MS, idleMs));
  sweep.unref?.();

  log.info("armoriq-agd started", { pid: process.pid, socket: paths.socket, mode: auth.mode(), auth: auth.state().kind, pumps: pumps.length });

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
          if (!socket.destroyed) socket.write(`${JSON.stringify(res.reply)}\n`);
          if (res.event) setImmediate(emit, res.event);
        });
        inflight.add(done);
        void done.finally(() => inflight.delete(done));
      }
    });
  }

  async function handleLine(line: string): Promise<{ reply: DaemonResponse; event: DaemonEvent | null }> {
    const mode = auth.mode();
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      log.warn("unparseable request line");
      return { reply: { v: PROTOCOL_VERSION, id: "", response: {} }, event: null };
    }
    const envelope = parseEnvelope(raw);
    if (!envelope.ok) {
      log.warn("rejected request", { reason: envelope.reason, id: envelope.id });
      const response = envelope.event ? fallbackResponse(envelope.event, mode, "protocol_mismatch", envelope.reason) : {};
      return { reply: { v: PROTOCOL_VERSION, id: envelope.id, response }, event: null };
    }
    const { id, event, receivedAt } = envelope;
    const reply = (response: HookResponse): DaemonResponse => ({ v: PROTOCOL_VERSION, id, response });

    const payload = parseHookPayload(event, envelope.payload);
    if (!payload) {
      log.warn("malformed hook payload", { id, event });
      return { reply: reply(fallbackResponse(event, mode, "malformed_payload", "the hook payload is missing required fields")), event: null };
    }

    const now = Date.now();
    const surface = surfaceFromTranscriptPath(payload.transcriptPath);
    const { session, created } = sessions.open(surface, payload.conversationId, now);
    if (created) emit({ kind: "session_start", session, at: now });
    if (event === "PreInvocation") {
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

    if (event === "PostInvocation" || event === "Stop") {
      sessions.endTurn(session.key);
      setImmediate(() => {
        emit({ kind: "turn_end", session, at: Date.now() });
        kickAll();
      });
    }
    return { reply: reply(response), event: { kind: "hook", hook, response, at: Date.now() } };
  }

  let stopping: Promise<void> | null = null;
  return {
    paths,
    auth,
    stop: () =>
      (stopping ??= (async () => {
        log.info("armoriq-agd stopping", { inflight: inflight.size });
        clearInterval(sweep);
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

// The instance lock is held, so any socket file left here belongs to a dead daemon.
function listen(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  removeQuietly(socketPath);
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}

function writeMode(file: string, mode: Mode, log: Log): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${mode}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    log.error("mode file write failed", { file, error: String(error) });
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
