import { clientRowId, createOutbox, fallbackAuditRow, redactText, sanitizeParams, type QueueLogin } from "@armorantigravity/core";
import { parseHookFrame } from "@armorantigravity/protocol";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Log } from "./log.ts";
import { auditIdentity } from "./capture.ts";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const STALE_TEMP_MS = 45_000;
const names = (dir: string): string[] => {
  try { return readdirSync(dir).sort(); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
};
const sync = (file: string) => { const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function fallbackSpoolStatus(socket: string): { pending: number; quarantined: number; failures: number } {
  const root = join(dirname(socket), "fallback-spool");
  let failures = 0;
  try { failures = statSync(join(dirname(socket), "fallback-spool-failures")).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { pending: names(root).filter(name => /\.(spool|tmp)$/.test(name)).length, quarantined: names(join(root, "quarantine")).length, failures };
}

// The hook copies a nonsecret login snapshot, so an outage followed by a login change cannot rebind it.
export function createFallbackSpool(deps: { dataDir: string; socket: string; log: Log }) {
  const root = join(dirname(deps.socket), "fallback-spool");
  const outbox = createOutbox<ReturnType<typeof fallbackAuditRow>>(deps.dataDir, "audit", deps.log, { login: () => null });
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let storageFailed = false;
  const failedAppends = new Set<string>();

  function move(file: string, folder: "archive" | "quarantine", name: string): void {
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, name);
    chmodSync(file, 0o600);
    sync(file);
    renameSync(file, folder === "quarantine" && existsSync(target) ? `${target}.${randomUUID()}` : target);
    sync(dir);
    sync(root);
  }

  function archive(file: string, hash: string, record: unknown): void {
    const dir = join(root, "archive");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${hash}.spool`);
    if (!existsSync(target)) {
      const temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, target);
      sync(dir);
    }
    // The sanitized copy must be durable before removing the raw source, including after a crash.
    sync(dir);
    sync(root);
    unlinkSync(file);
    sync(root);
  }

  async function ingest(): Promise<void> {
    const records = names(root).filter(name => /\.(spool|tmp)$/.test(name));
    if (!records.length) return;
    let known: Set<string | undefined> | undefined;
    for (const name of records) {
      await new Promise<void>(resolve => setImmediate(resolve));
      const file = join(root, name);
      let bytes: Buffer;
      try {
        const info = statSync(file);
        if (name.endsWith(".tmp") && Date.now() - info.mtimeMs < STALE_TEMP_MS) {
          const pid = Number(/^record-(\d+)-/.exec(name)?.[1]);
          if (pid > 0) { try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; } }
        }
        if (info.size > MAX_RECORD_BYTES) {
          move(file, "quarantine", name);
          deps.log.error("oversize fallback spool record retained");
          continue;
        }
        bytes = readFileSync(file);
      } catch {
        deps.log.error("fallback spool read failed; record retained for retry");
        continue;
      }
      let frame: NonNullable<ReturnType<typeof parseHookFrame>>;
      let printed: string;
      let context: { binding: QueueLogin | null; loggedOut: boolean };
      let reason: string;
      try {
        const nl = bytes.indexOf(10);
        const header = /^agds1 (dial_failed|no_answer|untagged_reply) (\d+) (\d+) (\d+)$/.exec(bytes.subarray(0, nl).toString());
        if (!header || nl < 0) throw new Error("invalid fallback spool header");
        reason = header[1]!;
        const lengths = header.slice(2).map(Number);
        if (nl + 1 + lengths.reduce((a, b) => a + b, 0) !== bytes.length) throw new Error("incomplete fallback spool record");
        const start = nl + 1;
        const raw = bytes.subarray(start, start + lengths[0]! ).toString();
        if (!/^agd1 \w+ [1-9]\d* /.test(raw) || !raw.endsWith("\n")) throw new Error("invalid fallback frame");
        const parsed = parseHookFrame(raw.trimEnd());
        if (!parsed || !Number.isFinite(new Date(parsed.receivedAt).getTime())) throw new Error("invalid fallback frame");
        frame = parsed;
        printed = bytes.subarray(start + lengths[0]!, start + lengths[0]! + lengths[1]!).toString();
        const rawContext = bytes.subarray(start + lengths[0]! + lengths[1]!).toString();
        context = rawContext ? JSON.parse(rawContext) : { binding: null, loggedOut: false };
        if (!context || typeof context !== "object" || Array.isArray(context) || typeof context.loggedOut !== "boolean") throw new Error("invalid fallback login snapshot");
      } catch {
        move(file, "quarantine", name);
        deps.log.error("unreadable fallback spool record retained");
        continue;
      }
      const hash = digest(Buffer.concat([Buffer.from(`${name}\n`), bytes]));
      if (failedAppends.has(hash)) continue;
      const archived = existsSync(join(root, "archive", `${hash}.spool`));
      if (!archived && frame.event === "PreToolUse") {
        let response: { decision?: string };
        try { response = JSON.parse(printed); }
        catch { move(file, "quarantine", name); deps.log.error("invalid fallback response retained"); continue; }
        if (response?.decision === "deny" && !context.loggedOut) {
          if (!context.binding || typeof context.binding.backend !== "string" || !/^[a-f0-9]{64}$/.test(context.binding.keyId)) {
            move(file, "quarantine", name);
            deps.log.error("fallback spool has no captured login binding");
            continue;
          }
          let identity;
          try { identity = auditIdentity({ id: clientRowId("fallback-spool", hash, "decision"), payload: frame.payload }, deps.dataDir); }
          catch { move(file, "quarantine", name); deps.log.error("fallback spool conversation identity could not be read"); continue; }
          const { rowId: id, sessionId: session } = identity;
          known ??= new Set([...outbox.readPending().map(row => row.id), ...outbox.readDeadLetters().map(({ row }) => row.client_row_id)]);
          if (!known.has(id)) {
            let prepared = false;
            let appended = false;
            try {
              outbox.prepare(context.binding);
              prepared = true;
              outbox.enqueue(fallbackAuditRow(id, session, frame.receivedAt), { fallback: true, binding: context.binding });
              appended = true;
              await outbox.flush();
              known.add(id);
              storageFailed = false;
            } catch {
              if (prepared && !appended) failedAppends.add(hash);
              else if (!storageFailed) outbox.captureFailure();
              storageFailed = true;
              deps.log.error(prepared && !appended ? "fallback spool append failed; record retained for the next daemon" : "fallback spool storage failed; record retained for retry");
              continue;
            }
          }
        }
      }
      archive(file, hash, { version: 1, original_sha256: digest(bytes), reason, event: frame.event, receivedAt: frame.receivedAt,
        payload: sanitizeParams(frame.payload), printed: redactText(printed), context: sanitizeParams(context) });
    }
  }

  const kick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return running ??= ingest().catch(() => deps.log.error("fallback spool ingestion failed; records retained")).finally(() => { running = null; });
  };
  return {
    name: "fallback-spool", kick,
    start() { timer = setInterval(() => { void kick(); }, 5000); timer.unref?.(); },
    async stop() { clearInterval(timer); await kick(); stopped = true; await outbox.persist(); },
  };
}
