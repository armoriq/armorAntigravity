import { stepUsage } from "../../src/core/usage.ts";
import type { StepTokens, StepUsage } from "../../src/types.ts";

// A host neutral step through the core usage mapping.
export function stepUsageFromTokens(step: Omit<StepTokens, "repo">, modelOf: (messageId: string) => string | null, repo: string, at = Date.now()): StepUsage | null {
  return stepUsage({ ...step, repo }, modelOf(step.messageId), at);
}
