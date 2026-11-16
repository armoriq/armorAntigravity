import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireInstanceLock } from "../src/lock.ts";
import { sandboxHome } from "./sandbox.ts";

let sandbox: ReturnType<typeof sandboxHome>;
const lockFile = () => path.join(sandbox.home, ".armoriq", "armorantigravity", "agd.sock.lock");
const seedLock = (contents: string) => {
  mkdirSync(path.dirname(lockFile()), { recursive: true });
  writeFileSync(lockFile(), contents);
};

beforeEach(() => {
  sandbox = sandboxHome();
});
afterEach(() => {
  sandbox.cleanup();
});

test("the first holder gets the lock and writes its pid; a second is refused", () => {
  const first = acquireInstanceLock(lockFile());
  expect(first).not.toBeNull();
  expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
  expect(acquireInstanceLock(lockFile())).toBeNull();
  first?.release();
  expect(existsSync(lockFile())).toBe(false);
});

test("the lock is free again once the holder releases it", () => {
  acquireInstanceLock(lockFile())?.release();
  const next = acquireInstanceLock(lockFile());
  expect(next).not.toBeNull();
  next?.release();
});

// node has no flock(2), so a daemon killed outright leaves its lock file behind. The owner is checked
// for liveness instead, which is the one behaviour this gave up when the daemon left the Bun runtime.
test("a lock left by a dead owner is taken over", () => {
  const dead = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]);
  const pid = Number.parseInt(dead.stdout.toString().trim(), 10);
  expect(Number.isInteger(pid)).toBe(true);
  seedLock(`${pid}\n`);
  const taken = acquireInstanceLock(lockFile());
  expect(taken).not.toBeNull();
  expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
  taken?.release();
});

test("a lock held by a live owner is refused, and an unreadable pid is not trusted as live", () => {
  seedLock(`${process.pid}\n`);
  expect(acquireInstanceLock(lockFile())).toBeNull();
  seedLock("not a pid\n");
  const taken = acquireInstanceLock(lockFile());
  expect(taken).not.toBeNull();
  taken?.release();
});
