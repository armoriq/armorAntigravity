import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// SPIKE: node has no flock(2), so the kernel no longer releases the lock when the daemon dies.
// A dead owner's lock is stolen after a liveness check instead.
export interface InstanceLock {
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export function acquireInstanceLock(file: string): InstanceLock | null {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      return {
        release: () => {
          closeSync(fd);
          try {
            unlinkSync(file);
          } catch {}
        },
      };
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const owner = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isInteger(owner) && owner > 1 && alive(owner)) return null;
    try {
      unlinkSync(file);
    } catch {}
  }
  return null;
}
