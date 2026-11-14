import type { Surface } from "@armorantigravity/protocol";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionKey, type SessionKey } from "./surface.ts";

export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 100;
const TMP_MAX_AGE_MS = 60_000;
const SURFACES: readonly Surface[] = ["app", "cli", "ide", "unknown"];

// Plugin state is keyed by plugin name and must be JSON-serializable; it comes back from a snapshot
// as plain JSON, so each plugin validates its own slot on read.
export interface Session {
  readonly key: SessionKey;
  readonly surface: Surface;
  readonly conversationId: string;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly turnStartedAt: number | null;
  get(owner: string): unknown;
  set(owner: string, value: unknown): void;
}

interface SessionRecord {
  readonly key: SessionKey;
  readonly surface: Surface;
  readonly conversationId: string;
  readonly startedAt: number;
  lastEventAt: number;
  turnStartedAt: number | null;
  readonly state: Map<string, unknown>;
}

interface Snapshot {
  readonly v: 1;
  readonly surface: Surface;
  readonly conversationId: string;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly turnStartedAt: number | null;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface SessionStore {
  // `created` is true for a conversation the daemon has never seen, including after a restore.
  open(surface: Surface, conversationId: string, now: number): { session: Session; created: boolean };
  get(key: SessionKey): Session | undefined;
  beginTurn(key: SessionKey, now: number): void;
  endTurn(key: SessionKey): void;
  idle(now: number, idleMs: number): readonly Session[];
  close(key: SessionKey): void;
  all(): Iterable<Session>;
  flush(): Promise<void>;
}

export function createSessionStore(dir: string, now = Date.now()): SessionStore {
  const records = loadSnapshots(dir, now);
  const handles = new Map<SessionKey, Session>();
  const dirty = new Set<SessionKey>();
  const removed = new Set<SessionKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, WRITE_DELAY_MS);
    timer.unref?.();
  };

  const touch = (key: SessionKey) => {
    dirty.add(key);
    schedule();
  };

  const write = (): Promise<void> => {
    const keys = [...dirty];
    const gone = [...removed];
    dirty.clear();
    removed.clear();
    writing = writing.then(async () => {
      if (keys.length + gone.length === 0) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {}
      for (const key of keys) {
        const r = records.get(key);
        if (!r) continue;
        const file = snapshotPath(dir, r.surface, r.conversationId);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(toSnapshot(r)), { mode: 0o600 });
          await rename(tmp, file);
        } catch {
          await unlink(tmp).catch(() => {});
        }
      }
      for (const key of gone) {
        const [surface, conversationId] = splitKey(key);
        await unlink(snapshotPath(dir, surface, conversationId)).catch(() => {});
      }
    });
    return writing;
  };

  const handle = (r: SessionRecord): Session => {
    const existing = handles.get(r.key);
    if (existing) return existing;
    const h: Session = {
      key: r.key,
      surface: r.surface,
      conversationId: r.conversationId,
      startedAt: r.startedAt,
      get lastEventAt() {
        return r.lastEventAt;
      },
      get turnStartedAt() {
        return r.turnStartedAt;
      },
      get: (owner) => r.state.get(owner),
      set(owner, value) {
        r.state.set(owner, value);
        touch(r.key);
      },
    };
    handles.set(r.key, h);
    return h;
  };

  return {
    open(surface, conversationId, at) {
      const key = sessionKey(surface, conversationId);
      const existing = records.get(key);
      if (existing) {
        existing.lastEventAt = at;
        touch(key);
        return { session: handle(existing), created: false };
      }
      const r: SessionRecord = { key, surface, conversationId, startedAt: at, lastEventAt: at, turnStartedAt: null, state: new Map() };
      records.set(key, r);
      removed.delete(key);
      touch(key);
      return { session: handle(r), created: true };
    },

    get(key) {
      const r = records.get(key);
      return r && handle(r);
    },

    beginTurn(key, at) {
      const r = records.get(key);
      if (!r) return;
      r.turnStartedAt = at;
      touch(key);
    },

    endTurn(key) {
      const r = records.get(key);
      if (!r || r.turnStartedAt === null) return;
      r.turnStartedAt = null;
      touch(key);
    },

    idle(at, idleMs) {
      return [...records.values()].filter((r) => at - r.lastEventAt >= idleMs).map(handle);
    },

    close(key) {
      if (!records.delete(key)) return;
      handles.delete(key);
      dirty.delete(key);
      removed.add(key);
      schedule();
    },

    all: () => [...records.values()].map(handle),

    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return write();
    },
  };
}

function splitKey(key: SessionKey): [Surface, string] {
  const i = key.indexOf(":");
  const surface = SURFACES.find((s) => s === key.slice(0, i)) ?? "unknown";
  return [surface, key.slice(i + 1)];
}

// conversationId format is unknown, so anything outside the safe set gets a hash suffix to keep names unique.
export function snapshotPath(dir: string, surface: Surface, conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  const suffix = safe === conversationId ? "" : `-${createHash("sha256").update(conversationId).digest("hex").slice(0, 12)}`;
  return path.join(dir, `${surface}-${safe}${suffix}.json`);
}

function toSnapshot(r: SessionRecord): Snapshot {
  return {
    v: 1,
    surface: r.surface,
    conversationId: r.conversationId,
    startedAt: r.startedAt,
    lastEventAt: r.lastEventAt,
    turnStartedAt: r.turnStartedAt,
    state: Object.fromEntries(r.state),
  };
}

// Runs once at startup, so synchronous reads stay off the hook path.
function loadSnapshots(dir: string, now: number): Map<SessionKey, SessionRecord> {
  const out = new Map<SessionKey, SessionRecord>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".tmp")) removeIfOlder(file, now - TMP_MAX_AGE_MS);
    if (!name.endsWith(".json")) continue;
    try {
      const snap = parseSnapshot(JSON.parse(readFileSync(file, "utf8")));
      if (!snap || now - snap.lastEventAt > SNAPSHOT_TTL_MS) {
        unlinkSync(file);
        continue;
      }
      const key = sessionKey(snap.surface, snap.conversationId);
      out.set(key, { ...snap, key, state: new Map(Object.entries(snap.state)) });
    } catch {}
  }
  return out;
}

function removeIfOlder(file: string, cutoff: number): void {
  try {
    if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
  } catch {}
}

function parseSnapshot(raw: unknown): Snapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("v" in raw) || raw.v !== 1) return null;
  const surface = "surface" in raw ? SURFACES.find((s) => s === raw.surface) : undefined;
  const conversationId = "conversationId" in raw && typeof raw.conversationId === "string" ? raw.conversationId : "";
  const startedAt = "startedAt" in raw ? finite(raw.startedAt) : null;
  const lastEventAt = "lastEventAt" in raw ? finite(raw.lastEventAt) : null;
  if (!surface || !conversationId || startedAt === null || lastEventAt === null) return null;
  const turnStartedAt = "turnStartedAt" in raw ? finite(raw.turnStartedAt) : null;
  const state = "state" in raw && typeof raw.state === "object" && raw.state !== null && !Array.isArray(raw.state) ? { ...raw.state } : {};
  return { v: 1, surface, conversationId, startedAt, lastEventAt, turnStartedAt, state };
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
