import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_WAIT_MS = 5_000;
const UNREADABLE_GRACE_MS = 10_000;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(path: string, raw: string): Promise<boolean> {
  const owner = Number(raw.trim());
  if (owner > 0) return !isAlive(owner);
  const info = await stat(path).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > UNREADABLE_GRACE_MS;
}

type Evict = (path: string, raw: string) => Promise<void>;

// Only for the eviction guard below: a guard is held for a few milliseconds, so one left by a
// dead process is rare and the brief vacancy this rename opens is acceptable there.
async function evictByRename(path: string, raw: string): Promise<void> {
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, aside);
  } catch {
    return;
  }
  const moved = await readFile(aside, "utf8").catch(() => "");
  if (moved !== raw) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}

// Evictions of one lock are serialized by a guard file, and the stale lock is removed only if it
// still holds what was judged stale. A lock is never vacated and re-created around a third
// process's fresh lock.
async function evictUnderGuard(path: string, raw: string): Promise<void> {
  const release = await tryLock(`${path}.evict`, evictByRename);
  if (!release) return;
  try {
    if ((await readFile(path, "utf8").catch(() => null)) === raw) await unlink(path).catch(() => {});
  } finally {
    await release();
  }
}

export async function tryLock(path: string, evict: Evict = evictUnderGuard): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // link() publishes the lock with its pid already written, so no reader ever sees it empty.
  const draft = `${path}.${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(draft, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(draft, path);
        return () => unlink(path).catch(() => {});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raw = await readFile(path, "utf8").catch(() => null);
        if (raw === null) continue;
        if (!(await isStale(path, raw))) return null;
        await evict(path, raw);
      }
    }
    return null;
  } finally {
    await unlink(draft).catch(() => {});
  }
}

// O_EXCL-style lockfile with stale-owner recovery, as ArmorClaude dev scripts/lib/live-usage.mjs.
export async function withLock<T>(path: string, fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
  const until = Date.now() + waitMs;
  let release = await tryLock(path);
  while (!release) {
    if (Date.now() > until) throw new Error(`${path} is held by another process`);
    await sleep(25);
    release = await tryLock(path);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}
