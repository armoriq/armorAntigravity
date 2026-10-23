import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/main.ts");

for (const source of ["environment", "argument", "installed"] as const) {
  test(`login uses the ${source} backend for one failed device request`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-login-"));
    const requests: { path: string; product: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body: unknown = await request.json();
        requests.push({ path: new URL(request.url).pathname, product: typeof body === "object" && body !== null && "product" in body ? body.product : undefined });
        return new Response("Service unavailable", { status: 503 });
      },
    });
    const backend = server.url.origin;
    const dir = path.join(home, ".armoriq/armorantigravity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ backendUrl: source === "installed" ? backend : "http://127.0.0.1:1", channel: "dev" }));
    try {
      const env = {
        HOME: home,
        PATH: process.env.PATH ?? "",
        ...(source === "environment" ? { ARMORIQ_BACKEND_URL: backend } : {}),
        ...(source === "argument" ? { ARMORIQ_BACKEND_URL: "http://127.0.0.1:1" } : {}),
      };
      const proc = Bun.spawn([process.execPath, CLI, "login", ...(source === "argument" ? ["--backend", backend] : [])], { env, stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(code).toBe(1);
      expect(output).toContain("Failed to request device code");
      expect(requests).toEqual([{ path: "/auth/device/code", product: "armorantigravity" }]);
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });
}
