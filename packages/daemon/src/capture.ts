import { clientRowId, createOutbox, fallbackAuditRow, type OutboxStatus, type QueueLogin } from "@armorantigravity/core";
import type { AuditIdentity, DaemonRequest } from "@armorantigravity/protocol";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readLogin, type Login } from "./auth.ts";
import { readConfig } from "./config.ts";
import { resolvePaths, type Env } from "./paths.ts";
import { surfaceFromTranscriptPath } from "./surface.ts";

const quiet = { info() {}, warn() {}, error() {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const queueLogin = (login: Login | null): QueueLogin | null => login ? { backend: login.backend, keyId: createHash("sha256").update(login.apiKey).digest("hex") } : null;

// Read only the conversation relationship. Tokens and tool arguments never enter the fallback row.
export function auditIdentity(request: Pick<DaemonRequest, "id" | "payload">, dataDir: string): AuditIdentity {
  const payload = request.payload && typeof request.payload === "object" ? request.payload as Record<string, unknown> : {};
  let sessionId = typeof payload.conversationId === "string" && payload.conversationId ? payload.conversationId : undefined;
  if (sessionId && typeof payload.transcriptPath === "string") {
    try {
      const state = JSON.parse(readFileSync(path.join(dataDir, "intent-state.json"), "utf8"));
      const conversations = new Map<string, { parent: string | null; ref: { conversationId: string } }>(state.conversations.map((entry: any) => [entry.conversation.key, entry.conversation]));
      let key = `${surfaceFromTranscriptPath(payload.transcriptPath)}:${sessionId}`;
      const seen = new Set<string>();
      while (!seen.has(key)) {
        seen.add(key);
        const conversation = conversations.get(key);
        if (!conversation) break;
        sessionId = conversation.ref.conversationId;
        if (!conversation.parent) break;
        key = conversation.parent;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot read fallback conversation identity");
    }
  }
  const hasStep = typeof payload.stepIdx === "number" && Number.isInteger(payload.stepIdx);
  const rowId = sessionId && hasStep ? clientRowId(sessionId, String(payload.stepIdx), "decision")
    : UUID.test(request.id) ? request.id : clientRowId(sessionId ?? "unknown", request.id, "decision");
  return { rowId, ...(sessionId ? { sessionId } : {}) };
}

// A separate process can replay this queue immediately. Closing also flushes the coalesced sync
// before the short lived hook exits. Only the binding captured on entry may own these rows.
export async function captureFallback(dataDir: string, identity: AuditIdentity, at: number, binding: QueueLogin | null, loggedOut = false): Promise<void> {
  if (loggedOut) return;
  const outbox = createOutbox(dataDir, "audit", quiet, { login: () => binding });
  try {
    if (!binding) outbox.captureFailure();
    else outbox.enqueue(fallbackAuditRow(identity.rowId, identity.sessionId, at), { fallback: true, binding });
  } finally { await outbox.persist(); }
}

export function prepareHookCapture(request: Pick<DaemonRequest, "id" | "payload" | "receivedAt">, env: Env) {
  const paths = resolvePaths(env);
  const config = readConfig(paths.configFile, quiet);
  let binding = queueLogin(readLogin(env, config.backendUrl));
  let identity: AuditIdentity;
  try { identity = auditIdentity(request, paths.dataDir); }
  catch {
    // An unreadable relationship cannot be repaired by guessing a root or a future login.
    identity = { rowId: request.id };
    binding = null;
  }
  const at = request.receivedAt;
  return { identity: { ...identity, binding }, stop: () => captureFallback(paths.dataDir, identity, at, binding) };
}

export async function auditStatus(env: Env): Promise<OutboxStatus> {
  const paths = resolvePaths(env);
  const config = readConfig(paths.configFile, quiet);
  const binding = queueLogin(readLogin(env, config.backendUrl));
  const outbox = createOutbox(paths.dataDir, "audit", quiet, { login: () => binding });
  await outbox.persist();
  return outbox.status();
}
