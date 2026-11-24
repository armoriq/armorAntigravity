import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OrgMode } from "@armorantigravity/adapter";
import type { Env } from "./paths.ts";

export interface OrgModeStore {
  current(): OrgMode | null;
  set(next: OrgMode): void;
  // Signed-in calls run and are only recorded, unless ARMORIQ_ORG_MODE=enforce forces Block here.
  monitoring(): boolean;
  known(): boolean;
  onChange(listener: () => void): () => void;
}

type Confirmed = { readonly mode: OrgMode; readonly binding: string };

function parse(value: unknown): Confirmed | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, notices, binding } = value as Record<string, unknown>;
  if (typeof binding !== "string" || !binding) return null;
  return mode === "shadow" || mode === "enforce" ? { mode: { mode, notices: notices === true }, binding } : null;
}

export function createOrgModeStore(dataDir: string, env: Env, binding: () => string | null): OrgModeStore {
  const file = path.join(dataDir, "org-mode.json");
  let cached: Confirmed | null = null;
  try {
    cached = parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {}
  const forced = env.ARMORIQ_ORG_MODE?.trim() === "enforce";
  const listeners = new Set<() => void>();
  const current = (): OrgMode | null => (cached && cached.binding === binding() ? cached.mode : null);
  return {
    current,
    set(next) {
      const owner = binding();
      if (!owner) return;
      const before = current();
      if (cached?.binding === owner && next.mode === before?.mode && next.notices === before.notices) return;
      cached = { mode: next, binding: owner };
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...next, binding: owner, at: new Date().toISOString() }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch {}
      for (const listener of listeners) listener();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    known: () => forced || current() !== null,
    monitoring: () => !forced && current()?.mode === "shadow",
  };
}
