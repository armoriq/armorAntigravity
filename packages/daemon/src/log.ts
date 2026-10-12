import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export interface Log {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

// One JSON line per entry. The daemon is usually spawned detached by agd-hook, so stderr is gone.
const ROTATE_BYTES = 10 * 1024 * 1024;

export function fileLog(file: string, echo: boolean): Log {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {}
  const write = (level: string, message: string, extra?: Record<string, unknown>) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, message, ...extra })}\n`;
    try {
      appendFileSync(file, line, { mode: 0o600 });
    } catch {}
    if (echo) process.stderr.write(line);
  };
  return {
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}
