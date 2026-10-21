import type { Surface } from "@armorantigravity/protocol";

// App data dirs from https://antigravity.google/docs/hooks/: the transcript sits at
// <app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl.
const APP_DATA_DIRS: Readonly<Record<string, Surface>> = {
  antigravity: "app",
  "antigravity-cli": "cli",
  "antigravity-ide": "ide",
};

export function surfaceFromTranscriptPath(transcriptPath: string): Surface {
  const parts = transcriptPath.split(/[\\/]+/);
  const brain = parts.lastIndexOf("brain");
  const candidates = brain > 0 ? [parts[brain - 1]] : parts;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const surface = APP_DATA_DIRS[candidates[i] ?? ""];
    if (surface) return surface;
  }
  return "unknown";
}

export type SessionKey = string & { readonly __brand: "SessionKey" };

export function sessionKey(surface: Surface, conversationId: string): SessionKey {
  return `${surface}:${conversationId}` as SessionKey;
}
