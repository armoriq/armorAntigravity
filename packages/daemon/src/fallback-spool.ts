import { clientRowId, createOutbox, fallbackAuditRow, type QueueLogin } from "@armorantigravity/core";
import { parseHookFrame } from "@armorantigravity/protocol";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Log } from "./log.ts";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const names = (dir: string): string[] => {
  try { return readdirSync(dir).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};
const sync = (file: string) => { const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function fallbackSpoolStatus(socket: string): { pending: number; quarantined: number } {
  const root = join(dirname(socket), "fallback-spool");
  return { pending: names(root).filter(name => /\.(spool|tmp)$/.test(name)).length, quarantined: names(join(root, "quarantine")).length };
}

// The hook copies a nonsecret login snapshot, so an outage followed by a login change cannot rebind it.
export function createFallbackSpool(deps: { dataDir: string; socket: string; log: Log }) {
  const root = join(dirname(deps.socket), "fallback-spool");
  const outbox = createOutbox<ReturnType<typeof fallbackAuditRow>>(deps.dataDir, "audit", deps.log, { login: () => null });
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  function move(file: string, folder: "archive" | "quarantine", name: string): void {
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, name);
    renameSync(file, folder === "quarantine" && existsSync(target) ? `${target}.${randomUUID()}` : target);
    sync(dir);
    sync(root);
  }

  async function ingest(): Promise<void> {
    const known = new Set([...outbox.readPending().map(row => row.id), ...outbox.readDeadLetters().map(({ row }) => row.client_row_id)]);
    for (const name of names(root).filter(name => /\.(spool|tmp)$/.test(name))) {
      const file = join(root, name);
      if (name.endsWith(".tmp")) {
        const pid = Number(/^record-(\d+)-/.exec(name)?.[1]);
        if (pid > 0) { try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; } }
        move(file, "quarantine", name);
        deps.log.error("incomplete fallback spool record retained");
        continue;
      }
      let bytes: Buffer;
      let frame: NonNullable<ReturnType<typeof parseHookFrame>>;
      let printed: string;
      let context: { binding: QueueLogin | null; loggedOut: boolean };
      try {
        if (statSync(file).size > MAX_RECORD_BYTES) throw new Error("oversize fallback spool record");
        bytes = readFileSync(file);
        const nl = bytes.indexOf(10);
        const header = /^agds1 (dial_failed|no_answer|untagged_reply) (\d+) (\d+) (\d+)$/.exec(bytes.subarray(0, nl).toString());
        if (!header || nl < 0) throw new Error("invalid fallback spool header");
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
      if (existsSync(join(root, "archive", `${hash}.spool`))) { move(file, "archive", `${hash}.spool`); continue; }
      if (frame.event === "PreToolUse") {
        let response: { decision?: string };
        try { response = JSON.parse(printed); }
        catch { move(file, "quarantine", name); deps.log.error("invalid fallback response retained"); continue; }
        if (response?.decision === "deny" && !context.loggedOut) {
          if (!context.binding || typeof context.binding.backend !== "string" || !/^[a-f0-9]{64}$/.test(context.binding.keyId)) {
            move(file, "quarantine", name);
            deps.log.error("fallback spool has no captured login binding");
            continue;
          }
          const id = clientRowId("fallback-spool", hash, "decision");
          const payload = frame.payload as { conversationId?: unknown } | null;
          const session = typeof payload?.conversationId === "string" ? payload.conversationId : undefined;
          if (!known.has(id)) {
            outbox.prepare(context.binding);
            outbox.enqueue(fallbackAuditRow(id, session, frame.receivedAt), { fallback: true, binding: context.binding });
            await outbox.flush();
            known.add(id);
          }
        }
      }
      sync(file);
      move(file, "archive", `${hash}.spool`);
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
