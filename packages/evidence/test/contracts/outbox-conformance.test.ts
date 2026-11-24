import { afterEach, describe, it } from "bun:test";
import { rmSync } from "node:fs";
import { createOutbox } from "@armorantigravity/core";
import * as transport from "../../src/io/backend-audit.ts";
import * as pump from "../../src/pumps/audit.ts";
import { quietLog, tempDir } from "../support.ts";
// The shared suite is JavaScript so the four plugin runtimes can copy it unchanged.
// @ts-expect-error The contract template does not ship TypeScript declarations.
import { defineOutboxConformance } from "./outbox-conformance.template.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function makeAdapter(config: any, shared?: any): any {
  const store = shared ?? { dir: tempDir().dir, login: config.login, fault: null, handles: [] };
  const queue: any = (createOutbox as any)(store.dir, "audit", quietLog, {
    login: () => store.login, clock: config.clock, sizeLimits: config.sizeLimits, timing: config.timing,
    preopen: !shared,
    beforeCommit(point: string) { if (store.fault === point) { store.fault = null; throw new Error(`injected ${point} storage failure`); } },
  });
  store.handles.push(queue);
  if (!shared) cleanup.push(async () => { for (const handle of store.handles) await handle.persist(); rmSync(store.dir, { recursive: true, force: true }); });
  return {
    append: async (row: any, options: any) => { queue.prepare(); queue.enqueue(row, options); },
    readPending: async () => queue.readPending(), readDeadLetters: async () => queue.readDeadLetters(), status: async () => queue.status(),
    switchLogin: async (login: any) => { store.login = login; await queue.restoreLogin(login); queue.prepare(); },
    authenticationSucceeded: async (login: any) => queue.authenticationSucceeded(login),
    failNext: async (point: string) => { store.fault = point; },
    restart: async () => { await queue.persist(); return makeAdapter(config, store); }, secondDrainer: async () => makeAdapter(config, store),
    drain: async (send: any, { probe }: any = {}) => {
      return queue.drain(async (rows: any[], login: any) => {
        let result;
        try {
          const reply = await send({ rows, login });
          // The suite uses empty bodies for status based refusals. Expand them to the backend's actual error envelopes.
          if (reply.status === 403 && !Object.hasOwn(reply.body ?? {}, "results")) reply.body = { error: "relogin_required" };
          if ([400, 422].includes(reply.status) && reply.body && typeof reply.body === "object" && Object.keys(reply.body).length === 0) reply.body = { statusCode: reply.status, error: "Bad Request", message: "legacy row refused" };
          result = (pump as any).auditSendResult(rows, (transport as any).parseAuditReply(reply.status, reply.body, new Headers(reply.headers), rows, config.clock.now()));
        } catch { result = (pump as any).auditSendResult(rows, { ok: false, retryable: true, unreachable: true, reason: "transport failed" }); }
        return result;
      }, undefined, { probe: probe && (async (login: any) => { const response = await probe({ login }); return response.status >= 200 && response.status < 300; }) });
    },
  };
}

defineOutboxConformance({ describe, it, makeAdapter });
