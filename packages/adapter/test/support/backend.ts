import type { Login } from "../../src/core-contract.ts";

export type Seen = { method: string; path: string; headers: Headers; body: unknown };

// A real HTTP server on an ephemeral port, answering with conmap-auto origin/dev response shapes.
export function stubBackend(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: text ? JSON.parse(text) : undefined });
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route(req) : Response.json({ message: `Cannot ${req.method} ${url.pathname}`, statusCode: 404 }, { status: 404 });
    },
  });
  const login: Login = {
    backend: `http://127.0.0.1:${server.port}`,
    apiKey: "ak_test_0123456789",
    userId: "user-1",
    orgId: "org-1",
    email: "dev@example.com",
    deviceId: "device-1",
    deviceName: "dev-laptop",
  };
  return { server, seen, login, stop: () => server.stop(true) };
}
