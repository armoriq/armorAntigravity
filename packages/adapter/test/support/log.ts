import type { Log } from "@armorantigravity/core";

export type Logged = { level: "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> };

export function memoryLog(): Log & { entries: Logged[] } {
  const entries: Logged[] = [];
  const push = (level: Logged["level"]) => (message: string, extra?: Record<string, unknown>) => {
    entries.push(extra === undefined ? { level, message } : { level, message, extra });
  };
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}
