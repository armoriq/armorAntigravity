import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;

// flock(2) is released by the kernel when the process dies, so a crashed daemon never leaves a
// stale lock behind, and concurrent hooks that each spawn a daemon race safely.
const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export interface InstanceLock {
  release(): void;
}

export function acquireInstanceLock(file: string): InstanceLock | null {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "a+", 0o600);
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return null;
  }
  writeFileSync(file, `${process.pid}\n`);
  return { release: () => closeSync(fd) };
}
