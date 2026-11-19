import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/main.ts");

let home: string;
let server: Server | null;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "agy-status-")));
  server = null;
});

afterEach(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

async function daemonAt(socketPath: string): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const peer = createServer((socket) => socket.end());
  server = peer;
  await new Promise<void>((resolve) => peer.listen(socketPath, resolve));
}

async function status(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, "status"], { env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  return output;
}

test("status finds the daemon on the ARMORANTIGRAVITY_SOCKET override", async () => {
  const socketPath = path.join(home, "elsewhere", "agd.sock");
  await daemonAt(socketPath);
  expect(await status({ ARMORANTIGRAVITY_SOCKET: socketPath })).toContain(`daemon: listening on ${socketPath}\n`);
});

test("status finds the daemon under ARMORIQ_HOME", async () => {
  const armoriqHome = path.join(home, "aiq");
  const socketPath = path.join(armoriqHome, "armorantigravity", "agd.sock");
  await daemonAt(socketPath);
  expect(await status({ ARMORIQ_HOME: armoriqHome })).toContain(`daemon: listening on ${socketPath}\n`);
});

test("status reaches a daemon on a socket path too long for sun_path", async () => {
  const socketPath = path.join(home, "d".repeat(40), "e".repeat(40), "f".repeat(30), "agd.sock");
  expect(Buffer.byteLength(socketPath)).toBeGreaterThan(104);
  await daemonAt(socketPath);
  expect(await status({ ARMORANTIGRAVITY_SOCKET: socketPath })).toContain(`daemon: listening on ${socketPath}\n`);
});

test("status reports not running when nothing listens on the override", async () => {
  await daemonAt(path.join(home, ".armoriq", "armorantigravity", "agd.sock"));
  expect(await status({ ARMORANTIGRAVITY_SOCKET: path.join(home, "elsewhere", "agd.sock") })).toContain("daemon: not running\n");
});
