import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../src/io/shared-lock.ts";
import { scratch } from "./helpers/stub.ts";

test("holders run one at a time", async () => {
  const lock = join(scratch(), "x.lock");
  const events: string[] = [];
  const holder = (name: string) =>
    withLock(lock, async () => {
      events.push(`${name}:in`);
      await Bun.sleep(30);
      events.push(`${name}:out`);
    });
  await Promise.all([holder("a"), holder("b")]);
  const first = events[0]!.split(":")[0];
  const second = first === "a" ? "b" : "a";
  expect(events).toEqual([`${first}:in`, `${first}:out`, `${second}:in`, `${second}:out`]);
});

test("a lock left by a dead process is taken over", async () => {
  const lock = join(scratch(), "x.lock");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  writeFileSync(lock, String(dead.pid));
  expect(await withLock(lock, async () => "ran", 200)).toBe("ran");
});

test("a lock held by a live process times out", async () => {
  const lock = join(scratch(), "x.lock");
  writeFileSync(lock, String(process.pid));
  await expect(withLock(lock, async () => "ran", 100)).rejects.toThrow("is held by another process");
});

test("a lockfile whose pid is not written yet is treated as held, not stale", async () => {
  const lock = join(scratch(), "x.lock");
  writeFileSync(lock, "");
  await expect(withLock(lock, async () => "ran", 200)).rejects.toThrow("is held by another process");
});

test("a stale lock another live process is already evicting is left to that process", async () => {
  const lock = join(scratch(), "x.lock");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  writeFileSync(lock, String(dead.pid));
  writeFileSync(`${lock}.evict`, String(process.pid));
  await expect(withLock(lock, async () => "ran", 200)).rejects.toThrow("is held by another process");
});

test("an eviction abandoned by a dead process does not block the takeover", async () => {
  const lock = join(scratch(), "x.lock");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  writeFileSync(lock, String(dead.pid));
  writeFileSync(`${lock}.evict`, String(dead.pid));
  expect(await withLock(lock, async () => "ran", 200)).toBe("ran");
});
