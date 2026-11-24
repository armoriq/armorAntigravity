import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutboxStatus, QueueLogin, SendResult } from "@armorantigravity/core";
import type { EvidenceDeps } from "../context.ts";
import { auditLogin } from "../pumps/audit.ts";
import { authHeaders } from "./http.ts";

export type ReportingResult<T> = SendResult<T>;
export type ReportingStatus = OutboxStatus & { held: string[] };
const sync = (dir: string) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const holdDir = (dir: string, stream: string) => join(dir, "outbox", `${stream}-holds-v1`);
const holdName = (binding: QueueLogin) => `${createHash("sha256").update(JSON.stringify([binding.backend, binding.keyId])).digest("hex")}.json`;

export function reportingHolds(dir: string, stream: string, binding?: QueueLogin): string[] {
  const root = holdDir(dir, stream);
  try {
    return [...new Set(readdirSync(root).filter(file => file.endsWith(".json") && (!binding || file === holdName(binding))).flatMap(file => {
      try { return JSON.parse(readFileSync(join(root, file), "utf8")).reason ? ["org_required"] : []; }
      catch { return ["unreadable_hold"]; }
    }))];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function reportingStatus(dir: string, stream: string, status: OutboxStatus, binding: QueueLogin | null): ReportingStatus {
  const held = reportingHolds(dir, stream);
  return { ...status, held, undeliverable: binding && reportingHolds(dir, stream, binding).length ? status.pending : status.undeliverable };
}

export function reportingDelivery(deps: EvidenceDeps, stream: string, now = Date.now) {
  const root = holdDir(deps.dataDir, stream);
  const fileOf = (binding: QueueLogin) => join(root, holdName(binding));
  const read = (binding: QueueLogin): { reason: string | null; nextAttemptAt: number; failures?: number } | null => {
    try { return JSON.parse(readFileSync(fileOf(binding), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const write = (binding: QueueLogin, reason: string | null, previousFailures = 0) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = fileOf(binding);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    const failures = reason ? previousFailures + 1 : 0;
    const nextAttemptAt = reason ? now() + Math.min(3_600_000, 300_000 * 2 ** Math.min(failures - 1, 8)) : 0;
    try { writeFileSync(fd, JSON.stringify({ reason, failures, nextAttemptAt })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, target);
    sync(root);
    sync(dirname(root));
  };
  return {
    async send<T>(binding: QueueLogin, send: () => Promise<ReportingResult<T>>): Promise<SendResult<T>> {
      const hold = read(binding);
      if (hold?.reason && now() < hold.nextAttemptAt) return { ok: false, deferred: true };
      let result: ReportingResult<T>;
      try { result = await send(); }
      catch (error) {
        if (!hold?.reason) throw error;
        write(binding, hold.reason, hold.failures);
        return { ok: false, deferred: true };
      }
      if (!result.ok && (result.hold || hold?.reason)) {
        write(binding, result.hold ?? hold!.reason, hold?.failures);
        return { ok: false, deferred: true };
      }
      if (hold?.reason && result.ok) write(binding, null);
      return result;
    },
    status(status: OutboxStatus): ReportingStatus { return reportingStatus(deps.dataDir, stream, status, auditLogin(deps.uploads.login())); },
    async probe(binding: QueueLogin): Promise<boolean> {
      const login = deps.uploads.probeLogin ? deps.uploads.probeLogin() : deps.uploads.login();
      const identity = auditLogin(login);
      if (!login || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return false;
      const response = await fetch(`${login.backend}/iap/validate-key`, { method: "POST", headers: authHeaders(login, deps.uploads), body: "{}", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      const valid = response.status >= 200 && response.status < 300;
      if (valid) deps.uploads.authenticationSucceeded?.(login);
      return valid;
    },
  };
}
