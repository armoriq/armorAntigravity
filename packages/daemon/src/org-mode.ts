import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OrgMode } from "@armorantigravity/adapter";
import type { Log } from "./log.ts";
import type { Env } from "./paths.ts";

// The workspace's Tools mode, kept on disk so a Block workspace stays Block across a daemon restart.
// Until the first answer it is Monitor: an installed plugin never blocks before an admin picks Block.
export interface OrgModeStore {
  current(): OrgMode;
  set(next: OrgMode): void;
  // Signed-in calls run and are only recorded, unless ARMORIQ_ORG_MODE=enforce forces Block here.
  monitoring(): boolean;
  onChange(listener: () => void): () => void;
}

const MONITOR: OrgMode = { mode: "shadow", notices: false };

function parse(value: unknown): OrgMode | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, notices } = value as Record<string, unknown>;
  return mode === "shadow" || mode === "enforce" ? { mode, notices: notices === true } : null;
}

export function createOrgModeStore(dataDir: string, env: Env, log: Log): OrgModeStore {
  const file = path.join(dataDir, "org-mode.json");
  let cached = MONITOR;
  try {
    cached = parse(JSON.parse(readFileSync(file, "utf8"))) ?? MONITOR;
  } catch {}
  const forced = env.ARMORIQ_ORG_MODE?.trim() === "enforce";
  const listeners = new Set<() => void>();
  return {
    current: () => cached,
    set(next) {
      if (next.mode === cached.mode && next.notices === cached.notices) return;
      cached = next;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, JSON.stringify({ ...next, at: new Date().toISOString() }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch (error) {
        // Applies in memory; a daemon restart before the next pull falls back to the last saved mode.
        rmSync(tmp, { force: true });
        log.warn("org mode not saved", { error: String(error) });
      }
      for (const listener of listeners) listener();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    monitoring: () => !forced && cached.mode !== "enforce",
  };
}
