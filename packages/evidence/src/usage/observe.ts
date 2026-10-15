import type { StepUsage } from "@armorantigravity/core";
import type { UsagePump } from "../pumps/usage.ts";
import { repoOf, sessionTitle, toStepUsage, type ConversationRef, type SourceRead, type UsageSource } from "./source.ts";

export type Observed = {
  readonly rootId: string;
  readonly observed: boolean;
  readonly steps: readonly StepUsage[];
  readonly problems: readonly string[];
};

// Reads one conversation and hands its calls and title to the usage pump under the root session.
// The title is the conversation's own; a subagent's title never replaces its root's.
export async function observeConversation(deps: {
  usage: Pick<UsagePump, "observe" | "observeTitle">;
  source: UsageSource;
  ref: ConversationRef;
  rootOf: (conversationId: string) => string;
}): Promise<Observed> {
  const { ref } = deps;
  let read: SourceRead;
  try {
    read = await deps.source.read(ref);
  } catch (error) {
    return { rootId: deps.rootOf(ref.conversationId), observed: false, steps: [], problems: [String(error)] };
  }
  const rootId = deps.rootOf(read.parentId ?? ref.conversationId);
  const repo = repoOf(ref.workspacePaths);
  const steps: StepUsage[] = [];
  for (const s of read.steps) {
    const step = toStepUsage(rootId, ref.conversationId, s, repo);
    if (step) steps.push(step);
  }
  for (const step of steps) deps.usage.observe(step);
  const title = rootId === ref.conversationId ? sessionTitle(rootId, read.title) : null;
  if (title) deps.usage.observeTitle(title);
  return { rootId, observed: steps.length > 0 || title !== null, steps, problems: read.problems };
}
