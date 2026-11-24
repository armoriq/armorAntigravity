import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRow, Log, Login } from "../../../src/types.ts";

export type Handler = (rows: AuditRow[], req: Request) => Response | Promise<Response>;

export function stubBackend(handler: Handler) {
  const batches: AuditRow[][] = [];
  const headers: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { rows: AuditRow[] };
      batches.push(body.rows);
      headers.push(req.headers);
      return handler(body.rows, req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, batches, headers, stop: () => server.stop(true) };
}

export const accepted = (rows: AuditRow[]) => Response.json({ written: rows.length, orphan: rows.length, failures: [] });

export function login(backend: string, apiKey = "ak_live_test"): Login {
  return { backend, apiKey, userId: "user-1", orgId: "org-1", email: "dev@example.com", deviceId: "dev_1", deviceName: "host" };
}

export function memoryLog() {
  const lines: { level: string; message: string; extra?: Record<string, unknown> }[] = [];
  const log: Log = {
    info: (message, extra) => lines.push({ level: "info", message, ...(extra === undefined ? {} : { extra }) }),
    warn: (message, extra) => lines.push({ level: "warn", message, ...(extra === undefined ? {} : { extra }) }),
    error: (message, extra) => lines.push({ level: "error", message, ...(extra === undefined ? {} : { extra }) }),
  };
  return { log, lines };
}

export const scratch = (prefix = "aoc-") => mkdtempSync(join(tmpdir(), prefix));

export function row(tool: string, extra: Partial<AuditRow> = {}): AuditRow {
  return {
    client_row_id: crypto.randomUUID(),
    session_id: "ses_1",
    agent_id: "opencode",
    client_id: "armoropencode",
    step_index: -1,
    action: tool,
    tool,
    input: { command: tool },
    status: "success",
    executed_at: "2026-10-11T00:00:00.000Z",
    ...extra,
  };
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}
