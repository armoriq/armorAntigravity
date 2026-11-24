import { readFileSync } from "node:fs";
import type { Log } from "./log.ts";

// Written by the installer. Read once at startup; the installer restarts the daemon after changing it.
export interface Config {
  readonly backendUrl: string | null;
  readonly channel: "stable" | "dev";
}

export const DEFAULT_CONFIG: Config = { backendUrl: null, channel: "stable" };

export function readConfig(file: string, log: Log): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) log.warn("config unreadable, using defaults", { file, error: String(error) });
    return DEFAULT_CONFIG;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_CONFIG;
  const backendUrl = "backendUrl" in raw && typeof raw.backendUrl === "string" && raw.backendUrl.trim() ? raw.backendUrl.trim() : null;
  const channel = "channel" in raw && raw.channel === "dev" ? "dev" : "stable";
  if ("mode" in raw && raw.mode === "monitor") log.warn("config drift: mode monitor in the daemon config is ignored; the workspace mode decides", { file });
  return { backendUrl, channel };
}
