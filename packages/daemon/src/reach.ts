import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { onPlanSuccess } from "@armorantigravity/intent";
import pkg from "../package.json" with { type: "json" };
import { loginCommand, resolveBackend } from "./auth.ts";
import { desktopNotifier } from "./notify.ts";
import type { Env } from "./paths.ts";
import type { DaemonPlugin } from "./plugin.ts";
import { REACH_NOTICE, pingDisabled, reminderDisabled, reachEnvironment } from "./reach-settings.ts";

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/;
const COUNT_FILE = /^counts-(\d{4}-\d{2}-\d{2})\.ndjson(\.sending)?$/;
const MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86400000;
type Metric = "plan" | "blocked" | "held";
type Counts = { day: string; plans: number; blocked: number; held: number };
const METRICS = { plan: "plans", blocked: "blocked", held: "held" } as const;

export interface ReachOptions {
  readonly env?: Env;
  readonly now?: () => number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly notifier?: (message: string) => void;
}

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST";

// Bounded reads of ordinary files only, including when a planted file is a FIFO or a symlink.
async function readText(file: string, limit: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !(stat.mode & 0o444) || stat.size > limit) throw new Error("unreadable reach file");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error("reach file too large");
    return buffer.toString("utf8", 0, size);
  } finally { await handle.close(); }
}

async function readObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readText(file, 65536));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch (error) { return missing(error) ? {} : null; }
}

async function eligibility(root: string, configFile: string, env: Env) {
  if (pingDisabled(env)) return null;
  const config = await readObject(configFile);
  if (!config || config.usagePing === false) return null;
  const settings = await readObject(path.join(root, "settings.json"));
  if (!settings || (Object.hasOwn(settings, "usagePing") && settings.usagePing !== true)) return null;
  const origin = resolveBackend(env, typeof config.backendUrl === "string" && config.backendUrl.trim() ? config.backendUrl.trim() : null);
  const environment = reachEnvironment(origin);
  return environment ? { origin, environment } : null;
}

async function readInstallId(file: string): Promise<string | null> {
  try {
    const text = await readText(file, 37);
    return text.length === 37 && INSTALL_ID.test(text) ? text.slice(0, -1) : null;
  } catch { return null; }
}

// Publish a complete candidate with a hard link. Racing plugins read the same winner.
export async function ensureInstallId(root: string): Promise<string | null> {
  const file = path.join(root, "install-id");
  let temp: string | undefined;
  try {
    try { await fs.lstat(file); return readInstallId(file); }
    catch (error) { if (!missing(error)) return null; }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const candidate = path.join(root, `install-id.${process.pid}.${randomUUID()}.tmp`);
    const handle = await fs.open(candidate, "wx", 0o600);
    temp = candidate;
    try { await handle.writeFile(`${id}\n`); }
    finally { await handle.close(); }
    try { await fs.link(candidate, file); return id; }
    catch (error) { if (exists(error)) return readInstallId(file); }
    // Some filesystems cannot hard link. Match the other plugins' exclusive, single write fallback.
    let fallback;
    try { fallback = await fs.open(file, "wx", 0o600); }
    catch (error) { return exists(error) ? readInstallId(file) : null; }
    try { return (await fallback.write(Buffer.from(`${id}\n`))).bytesWritten === 37 ? id : null; }
    finally { await fallback.close(); }
  } catch { return null; }
  finally { if (temp) await fs.unlink(temp).catch(() => {}); }
}

function dayTime(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : NaN;
}

async function claimDay(dir: string, day: string, prefix = "ping-"): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fs.open(path.join(dir, `${prefix}${day}`), "wx", 0o600);
    await handle.close();
    try {
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(prefix) || !(dayTime(day) - dayTime(name.slice(prefix.length)) > 30 * DAY_MS)) continue;
        const file = path.join(dir, name);
        try { if ((await fs.lstat(file)).isFile()) await fs.unlink(file); } catch {}
      }
    } catch { /* Cleanup cannot cancel a claim that was already made. */ }
    return true;
  } catch { return false; }
}

async function appendCount(dir: string, day: string, metric: Metric): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await fs.open(path.join(dir, `counts-${day}.ndjson`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify({ t: metric })}\n`);
    const stat = await handle.stat();
    if (stat.isFile() && stat.size + line.length <= MAX_BYTES) await handle.write(line);
  } finally { await handle.close(); }
}

async function settleCounts(files: readonly string[], acknowledged = false): Promise<void> {
  for (const file of files) {
    try {
      if (!acknowledged) {
        const target = file.slice(0, -8);
        // A rollback can restore an oversized or unreadable file without reading it.
        const source = await fs.lstat(file);
        if (!source.isFile()) continue;
        try { await fs.link(file, target); }
        catch (error) {
          if (!exists(error)) continue;
          const contents = await readText(file, MAX_BYTES);
          const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            const buffer = Buffer.from(contents);
            // A crash between link and unlink may leave both names pointing at one file.
            if (stat.ino !== source.ino || stat.dev !== source.dev) {
              if (!stat.isFile() || stat.size + buffer.length > MAX_BYTES) continue;
              if ((await handle.write(buffer)).bytesWritten !== buffer.length) continue;
            }
          } finally { await handle.close(); }
        }
      }
      await fs.unlink(file);
    } catch { /* Leave an unacknowledged file for the next daily attempt. */ }
  }
}

async function collectCounts(dir: string, day: string, files: string[], signal: AbortSignal): Promise<Counts[]> {
  const time = dayTime(day);
  for (const name of await fs.readdir(dir)) {
    const match = COUNT_FILE.exec(name);
    if (match?.[2] && Number.isFinite(dayTime(match[1]!))) await settleCounts([path.join(dir, name)]);
    signal.throwIfAborted();
  }
  const days: string[] = [];
  for (const name of await fs.readdir(dir)) {
    const match = COUNT_FILE.exec(name);
    if (!match) continue;
    const age = time - dayTime(match[1]!);
    const file = path.join(dir, name);
    try {
      if (!(await fs.lstat(file)).isFile()) continue;
      if (age > 7 * DAY_MS) await fs.unlink(file);
      else if (age > 0 && !match[2]) days.push(match[1]!);
    } catch {}
    signal.throwIfAborted();
  }
  const localCounts: Counts[] = [];
  for (const countDay of days.sort().reverse().slice(0, 7)) {
    signal.throwIfAborted();
    const file = path.join(dir, `counts-${countDay}.ndjson`);
    const sending = `${file}.sending`;
    try {
      try { await fs.lstat(sending); continue; }
      catch (error) { if (!missing(error)) continue; }
      await fs.rename(file, sending);
      files.push(sending);
      signal.throwIfAborted();
      const text = await readText(sending, MAX_BYTES);
      signal.throwIfAborted();
      const counts: Counts = { day: countDay, plans: 0, blocked: 0, held: 0 };
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        // Keep large counter files from occupying the daemon's event loop for a whole read.
        if (index % 2048 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
        }
        try {
          const entry = JSON.parse(line);
          if (!entry || Object.keys(entry).length !== 1 || typeof entry.t !== "string" || !Object.hasOwn(METRICS, entry.t)) continue;
          const metric = METRICS[entry.t as Metric];
          counts[metric] = Math.min(100000, counts[metric] + 1);
        } catch { /* Partial and unknown lines carry no metric. */ }
      }
      if (counts.plans || counts.blocked || counts.held) localCounts.push(counts);
    } catch {
      // A file we could not read is not part of this request and must not be acknowledged.
      const index = files.indexOf(sending);
      if (index >= 0) {
        files.splice(index, 1);
        await settleCounts([sending]);
      }
      if (signal.aborted) throw signal.reason;
    }
  }
  return localCounts;
}

export function reachPlugin(opts: ReachOptions = {}): DaemonPlugin {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const send = opts.fetch ?? globalThis.fetch;
  return {
    name: "reach",
    setup(ctx) {
      const notify = opts.notifier
        ? (message: string) => { ctx.log.info(message); opts.notifier!(message); }
        : desktopNotifier(ctx.log, { env });
      let stopped = false;
      let queued = Promise.resolve();

      async function messages(day: string, signedIn: boolean, active: () => boolean) {
        const root = path.join(ctx.paths.armoriqDir, "reach/v1/armorantigravity");
        // Each message owns its claim. Neither ping consent nor a failed claim hides the other.
        try {
          if (await eligibility(ctx.paths.armoriqDir, ctx.paths.configFile, env) && active()) {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            const handle = await fs.open(path.join(root, "notice-shown"), "wx", 0o600);
            await handle.close();
            if (active()) notify(REACH_NOTICE);
          }
        } catch { /* A notice failure does not suppress the reminder. */ }
        try {
          if (signedIn || reminderDisabled(env) || !active()) return;
          const config = await readObject(ctx.paths.configFile);
          const settings = await readObject(path.join(ctx.paths.armoriqDir, "settings.json"));
          if (!config || config.signInReminder === false || !settings ||
              (Object.hasOwn(settings, "signInReminder") && settings.signInReminder !== true)) return;
          const origin = resolveBackend(env, typeof config.backendUrl === "string" && config.backendUrl.trim() ? config.backendUrl.trim() : null);
          const environment = reachEnvironment(origin);
          if (!environment || !active()) return;
          const command = loginCommand(ctx.paths.dataDir, origin);
          if (await claimDay(path.join(root, environment), day, "reminder-") && active()) {
            notify(`ArmorAntigravity is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${command} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`);
          }
        } catch { /* Notification work never changes a hook result. */ }
      }

      async function work(day: string, signedIn: boolean, trigger: boolean, metric: Metric | null, sessionStart: boolean) {
        const controller = new AbortController();
        let active = true;
        let acknowledged = false;
        const files: string[] = [];
        let settlement = Promise.resolve();
        const settle = () => {
          const batch = files.splice(0);
          settlement = settlement.then(() => settleCounts(batch, acknowledged));
          return settlement;
        };
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => { active = false; controller.abort(); resolve(); }, 5000);
        });
        const perform = async () => {
          try {
            if (sessionStart) await messages(day, signedIn, () => active);
            const eligible = await eligibility(ctx.paths.armoriqDir, ctx.paths.configFile, env);
            if (!eligible || !active) return;
            const dir = path.join(ctx.paths.armoriqDir, "reach/v1/armorantigravity", eligible.environment);
            if (metric && !signedIn) await appendCount(dir, day, metric);
            if (!trigger || !active) return;
            const installId = await ensureInstallId(ctx.paths.armoriqDir);
            if (!installId || !active || !await claimDay(dir, day) || !active) return;
            const localCounts = await collectCounts(dir, day, files, controller.signal);
            // The CLI's plist reader is private to the CLI. No CLI import or agy invocation here.
            const hostVersion = null;
            const current = await eligibility(ctx.paths.armoriqDir, ctx.paths.configFile, env);
            if (!active || !current || current.origin !== eligible.origin) return;
            const body = {
              schemaVersion: 1, installId, plugin: "armorantigravity", pluginVersion: pkg.version,
              hostAgent: "antigravity", hostVersion,
              os: ({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform] ?? "other",
              signedIn, environment: eligible.environment, localCounts,
            };
            const response = await send(`${eligible.origin}/install-pings`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
              redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
            });
            acknowledged = active && response.status >= 200 && response.status < 300;
          } catch { /* Best effort reporting never changes a hook result. */ }
          finally { if (!active) await settle(); }
        };
        try { await Promise.race([perform(), deadline]); }
        finally {
          active = false;
          clearTimeout(timer!);
          controller.abort();
          await settle();
        }
      }

      function enqueue(trigger: boolean, metric: Metric | null, sessionStart = false) {
        if (stopped) return;
        // Only memory and scheduling on the caller's path. Capture one clock and auth observation.
        const day = new Date(now()).toISOString().slice(0, 10);
        const signedIn = ctx.auth.uploadLogin() !== null;
        queued = queued.then(() => new Promise<void>((resolve) => {
          setImmediate(() => { void work(day, signedIn, trigger, metric, sessionStart).catch(() => {}).finally(resolve); });
        }));
      }

      const unsubscribe = onPlanSuccess(() => enqueue(false, "plan"));
      return {
        observe(event) {
          if (event.kind === "session_start") enqueue(true, null, true);
          else if (event.kind === "hook") {
            let metric: Metric | null = null;
            if (event.hook.event === "PreToolUse" && event.response && "decision" in event.response) {
              const response = event.response;
              if (response.decision === "deny") metric = response.reason.includes("[approval_required]") ? "held" : "blocked";
              else if (response.decision === "ask" || response.decision === "force_ask") metric = "held";
            }
            enqueue(true, metric);
          }
        },
        pumps: [{ name: "reach", kick() {}, async stop() { stopped = true; unsubscribe(); await queued; } }],
      };
    },
  };
}
