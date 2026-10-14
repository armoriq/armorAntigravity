// From armorOpenCode dev test/io/helpers/stub.ts: only the helpers the outbox and lock tests use.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Log } from "../../src/types.ts";

export function memoryLog() {
  const lines: { level: string; message: string; extra?: Record<string, unknown> | undefined }[] = [];
  const log: Log = {
    info: (message, extra) => lines.push({ level: "info", message, extra }),
    warn: (message, extra) => lines.push({ level: "warn", message, extra }),
    error: (message, extra) => lines.push({ level: "error", message, extra }),
  };
  return { log, lines };
}

export const scratch = (prefix = "aoc-") => mkdtempSync(join(tmpdir(), prefix));
