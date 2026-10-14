import type { HookEvent, HookPayload } from "@armorantigravity/protocol";
import { z } from "zod";

// Field names follow https://antigravity.google/docs/hooks/. Unknown fields are
// ignored so a newer Antigravity build that adds fields keeps working.
const base = z.object({
  conversationId: z.string().min(1),
  workspacePaths: z.array(z.string()).readonly(),
  transcriptPath: z.string(),
  artifactDirectoryPath: z.string(),
  modelName: z.string(),
});

const toolCall = z.object({ name: z.string().min(1), args: z.unknown() });

const preToolUse = base.extend({ toolCall, stepIdx: z.number().int() });
const postToolUse = preToolUse.extend({ error: z.string() });
const invocation = base.extend({ invocationNum: z.number().int(), initialNumSteps: z.number().int() });
const stop = base.extend({ executionNum: z.number().int(), fullyIdle: z.boolean(), terminationReason: z.string(), error: z.string() });

export type ParseResult = { ok: true; payload: HookPayload } | { ok: false; error: string };

const HOOK_EVENTS: ReadonlySet<string> = new Set<HookEvent>([
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
]);

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && HOOK_EVENTS.has(value);
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function baseFields(d: z.infer<typeof base>) {
  return {
    conversationId: d.conversationId,
    workspacePaths: d.workspacePaths,
    transcriptPath: d.transcriptPath,
    artifactDirectoryPath: d.artifactDirectoryPath,
    modelName: d.modelName,
  };
}

// Antigravity's stdin carries no event name; the hook client knows it from the
// hooks.json entry that ran it, so the event is passed in separately.
export function parseHookPayload(event: HookEvent, raw: unknown): ParseResult {
  switch (event) {
    case "PreToolUse": {
      const r = preToolUse.safeParse(raw);
      if (!r.success) return { ok: false, error: describe(r.error) };
      const { toolCall: t, stepIdx } = r.data;
      return { ok: true, payload: { event, ...baseFields(r.data), toolCall: { name: t.name, args: t.args }, stepIdx } };
    }
    case "PostToolUse": {
      const r = postToolUse.safeParse(raw);
      if (!r.success) return { ok: false, error: describe(r.error) };
      const { toolCall: t, stepIdx, error } = r.data;
      return {
        ok: true,
        payload: {
          event,
          ...baseFields(r.data),
          toolCall: { name: t.name, args: t.args },
          stepIdx,
          error,
        },
      };
    }
    case "PreInvocation":
    case "PostInvocation": {
      const r = invocation.safeParse(raw);
      if (!r.success) return { ok: false, error: describe(r.error) };
      const { invocationNum, initialNumSteps } = r.data;
      return { ok: true, payload: { event, ...baseFields(r.data), invocationNum, initialNumSteps } };
    }
    case "Stop": {
      const r = stop.safeParse(raw);
      if (!r.success) return { ok: false, error: describe(r.error) };
      const { executionNum, fullyIdle, terminationReason, error } = r.data;
      return { ok: true, payload: { event, ...baseFields(r.data), executionNum, fullyIdle, terminationReason, error } };
    }
  }
}
