import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent } from "@armorantigravity/protocol";
import { isHookEvent } from "../src/payload.ts";

const ROOT = join(import.meta.dir, "fixtures");

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

export type Capture = { file: string; event: HookEvent; stdin: unknown };

// Scrubbed agy CLI payloads from the P0 spike, stored as {event, stdin}.
export function captured(name: string): Capture {
  const raw = fixture(join("captured", `${name}.json`));
  if (typeof raw !== "object" || raw === null || !("event" in raw) || !isHookEvent(raw.event) || !("stdin" in raw)) {
    throw new Error(`malformed capture ${name}`);
  }
  return { file: name, event: raw.event, stdin: raw.stdin };
}

export function allCaptures(): Capture[] {
  return readdirSync(join(ROOT, "captured"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => captured(f.slice(0, -5)));
}
