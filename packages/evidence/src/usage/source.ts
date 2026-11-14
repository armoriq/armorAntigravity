import { sessionTitle as coreSessionTitle, type SessionID, type SessionTitle, type StepUsage } from "@armorantigravity/core";
import type { Surface } from "@armorantigravity/protocol";
import { TITLE_SOURCE } from "../context.ts";

export type ConversationRef = {
  readonly conversationId: string;
  readonly transcriptPath: string;
  readonly workspacePaths: readonly string[];
  readonly surface: Surface;
};

// One model call as the source reports it. `key` is unique within the conversation.
export type SourceStep = {
  readonly key: string;
  readonly model: string;
  readonly at: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
};

export type SourceRead = {
  readonly steps: readonly SourceStep[];
  readonly title: { readonly text: string; readonly at: number } | null;
  // Set when the source itself names the conversation a subagent of another.
  readonly parentId: string | null;
  readonly problems: readonly string[];
};

// Where token counts come from. Hooks carry none (PRD U8), so this reads what Antigravity writes
// to disk; which file and schema is settled by the P0 spike (#5).
export interface UsageSource {
  read(ref: ConversationRef): Promise<SourceRead>;
  // Every conversation on this device, for discovery and history runs.
  list(): Promise<readonly ConversationRef[]>;
}

export const EMPTY_SOURCE: UsageSource = {
  read: async () => ({ steps: [], title: null, parentId: null, problems: [] }),
  list: async () => [],
};

// The working directory, as ArmorClaude sends `cwd`. Outside a workspace there is none to name,
// and "/" is what ArmorOpenCode sent there (armorOpenCode#116).
export function repoOf(workspacePaths: readonly string[]): string {
  const first = workspacePaths.find((p) => p.trim() !== "" && p !== "/");
  return first?.slice(0, 200) ?? "";
}

// A subagent's calls are filed under the root conversation, so the plan's usage is complete;
// the child id stays in the call key, which keeps each call counted once.
export function toStepUsage(rootId: string, conversationId: string, step: SourceStep, repo: string): StepUsage | null {
  const entry = {
    model: step.model || "unknown",
    inputTokens: whole(step.inputTokens),
    outputTokens: whole(step.outputTokens),
    cacheReadTokens: whole(step.cacheReadTokens),
    cacheWriteTokens: whole(step.cacheWriteTokens),
  };
  if (entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens === 0) return null;
  return {
    sessionId: brand(rootId),
    messageId: conversationId,
    partId: step.key,
    at: step.at,
    repo,
    entry,
    reasoningTokens: whole(step.reasoningTokens),
  };
}

const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// SessionID is a brand over the raw conversation id; nothing is derived from it.
function brand(id: string): SessionID {
  return id as SessionID;
}

// Antigravity's own conversation title only, never prompt text. Placeholders are skipped; the
// list grows as the spike finds the strings each surface uses before a title is generated.
const PLACEHOLDERS = new Set(["untitled", "new conversation", "new chat", "new task"]);

export function sessionTitle(sessionId: string, title: { text: string; at: number } | null): SessionTitle | null {
  if (!title) return null;
  const text = title.text.replace(/\s+/g, " ").trim();
  return PLACEHOLDERS.has(text.toLowerCase()) ? null : coreSessionTitle(sessionId, text, TITLE_SOURCE, title.at);
}
