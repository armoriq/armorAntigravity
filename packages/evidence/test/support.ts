import type { Log, Login } from "@armorantigravity/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Uploads } from "../src/context.ts";

export type Recorded = { method: string; path: string; body: unknown; headers: Headers };
export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
export type Handler = (req: Recorded) => Reply | Promise<Reply>;

// A local HTTP server standing in for conmap's routes, recording every request it receives.
export function stubBackend(routes: Record<string, Handler>) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const rec: Recorded = { method: request.method, path: url.pathname, body, headers: request.headers };
      requests.push(rec);
      const key = Object.keys(routes).find((k) => {
        const [method, p] = k.split(" ");
        return method === request.method && (p === url.pathname || (p?.endsWith("*") && url.pathname.startsWith(p.slice(0, -1))));
      });
      const handler = key ? routes[key] : undefined;
      if (!handler) return new Response("not found", { status: 404 });
      const reply = await handler(rec);
      return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers ?? {} });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    hits: (method: string, p: string) => requests.filter((r) => r.method === method && r.path === p),
    stop: () => server.stop(true),
  };
}

export function login(backend: string, overrides: Partial<Login> = {}): Login {
  return {
    backend,
    apiKey: "ak_test_key_for_stub_backend",
    userId: "user-1",
    orgId: "org-1",
    email: "dev@example.com",
    deviceId: "dev_0123456789abcdef",
    deviceName: "test-host",
    ...overrides,
  };
}

export function uploads(current: () => Login | null): Uploads & { reports: { status: number; body: unknown }[] } {
  const reports: { status: number; body: unknown }[] = [];
  return {
    client: { product: "armorantigravity", version: "0.1.0" },
    headers: { "X-ArmorIQ-Client": "armorantigravity/0.1.0" },
    login: current,
    report: (status, body) => void reports.push({ status, body }),
    reports,
  };
}

export const quietLog: Log & { lines: { level: string; message: string; extra?: Record<string, unknown> }[] } = {
  lines: [],
  info(message, extra) {
    this.lines.push({ level: "info", message, ...(extra ? { extra } : {}) });
  },
  warn(message, extra) {
    this.lines.push({ level: "warn", message, ...(extra ? { extra } : {}) });
  },
  error(message, extra) {
    this.lines.push({ level: "error", message, ...(extra ? { extra } : {}) });
  },
};

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-evidence-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}
