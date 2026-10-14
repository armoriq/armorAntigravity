import type { HookPayload, HookResponse, Surface, ToolDecision } from "@armorantigravity/protocol";
import { basename, dirname } from "node:path";
import { createSdkBackend, type ClientIdentity } from "./backend.ts";
import { INTENT_DIRECTIVE, planningDraftNote } from "./directive.ts";
import { createOwnTools, ownToolCall, type OwnTool } from "./own-tools.ts";
import { isPlainObject } from "./plan.ts";
import { createTokenPump } from "./pump.ts";
import { createRegistry, type Conversation, type Registry } from "./registry.ts";
import { createSubagentLinker } from "./subagents.ts";
import { conversationKey, type AuditRow, type ConversationKey, type ConversationRef, type IntentBackend, type Log, type Login, type Mode, type PolicyView } from "./types.ts";

type PreToolUse = Extract<HookPayload, { event: "PreToolUse" }>;

// ASSUMPTION(P0 #1, issue #30): planning mode writes these artifacts into artifactDirectoryPath through a file
// tool. The names are in the agy binary; a planning-mode capture has not confirmed how they are written.
const PLAN_ARTIFACTS: ReadonlySet<string> = new Set(["implementation_plan.md", "task.md"]);
const CHILD_MESSAGE_WINDOW_MS = 60_000;
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

export interface IntentRuntimeOptions {
  readonly client: ClientIdentity;
  login(): Login | null;
  mode(): Mode;
  policy(): PolicyView;
  // The compiled local policy for the mint body; see compileMintPolicy.
  mintPolicy(): Record<string, unknown> | undefined;
  audit(row: AuditRow): void;
  onRelogin?(reason: string): void;
  readonly log: Log;
  readonly backend?: IntentBackend;
  readonly now?: () => number;
  readonly fileExists?: (path: string) => boolean;
}

export interface IntentRuntime {
  readonly registry: Registry;
  // Call on every hook event before deciding: opens the conversation, links subagents, tracks turns.
  observe(surface: Surface, payload: HookPayload): void;
  // For register_intent_plan and the trust tools: performs the state change, then allows the call so the
  // MCP server can answer with the outcome. Null for every other tool.
  ownToolDecision(surface: Surface, payload: PreToolUse): Promise<ToolDecision | null>;
  // The conversation whose plan and token a check uses; a subagent resolves to its root.
  root(ref: ConversationRef): Conversation | null;
  // PreInvocation response: the plan directive, only in enforce mode and only while no plan is registered.
  preInvocation(surface: Surface, payload: HookPayload): HookResponse;
  mcpOutcome(tool: OwnTool, args: unknown, waitMs: number): Promise<string | null>;
  conversationEnded(ref: ConversationRef): void;
  readonly pump: { readonly name: string; kick(): void; stop(): Promise<void> };
}

export function createIntentRuntime(opts: IntentRuntimeOptions): IntentRuntime {
  const now = opts.now ?? Date.now;
  const registry = createRegistry(now);
  const backend = opts.backend ?? createSdkBackend({ client: opts.client, mintPolicy: () => opts.mintPolicy() });
  const tools = createOwnTools({
    registry,
    backend,
    login: opts.login,
    mode: opts.mode,
    policy: opts.policy,
    audit: opts.audit,
    log: opts.log,
    now,
    ...(opts.onRelogin ? { onRelogin: opts.onRelogin } : {}),
  });
  const pump = createTokenPump({ registry, backend, login: opts.login, log: opts.log, now });
  const linker = createSubagentLinker(registry, now, opts.fileExists);
  const drafts = new Map<ConversationKey, string>();
  const childMessagedAt = new Map<ConversationKey, number>();
  pump.start();

  const refOf = (surface: Surface, payload: HookPayload): ConversationRef => ({ surface, conversationId: payload.conversationId });

  function notePlanArtifact(ref: ConversationRef, payload: PreToolUse): void {
    const dir = payload.artifactDirectoryPath;
    const args = payload.toolCall.args;
    if (!dir || !FILE_WRITE_TOOLS.has(payload.toolCall.name) || !isPlainObject(args) || typeof args.TargetFile !== "string") return;
    const target = args.TargetFile;
    if (dirname(target) !== dir || !PLAN_ARTIFACTS.has(basename(target))) return;
    const root = registry.root(conversationKey(ref));
    if (root) drafts.set(root.key, target);
  }

  return {
    registry,
    pump: { name: "intent-token", kick: pump.kick, stop: pump.stop },

    observe(surface, payload) {
      const ref = refOf(surface, payload);
      const key = registry.open(ref).key;
      linker.noteEvent(ref, payload.artifactDirectoryPath);
      linker.resolve(ref);
      switch (payload.event) {
        case "PreInvocation": {
          // A subagent's send_message also starts the parent at invocationNum 0 (spike capture); that is not a
          // user message, so it must not reset the revision counter.
          const messaged = childMessagedAt.get(key);
          const fromChild = messaged !== undefined && now() - messaged < CHILD_MESSAGE_WINDOW_MS;
          if ((payload.invocationNum === undefined || payload.invocationNum === 0) && !fromChild) registry.beginTurn(key);
          return;
        }
        case "PreToolUse": {
          const { name, args } = payload.toolCall;
          if (name === "invoke_subagent") linker.noteSpawn(ref, now());
          if (name === "send_message" && isPlainObject(args) && typeof args.Recipient === "string") {
            linker.noteMessage(ref, args.Recipient);
            const parent = registry.get(key)?.parent;
            if (parent) childMessagedAt.set(parent, now());
          }
          notePlanArtifact(ref, payload);
          return;
        }
        case "Stop":
          pump.noteStop(key);
          pump.kick();
          return;
        case "PostToolUse":
        case "PostInvocation":
          return;
        default: {
          const _exhaustive: never = payload;
          return _exhaustive;
        }
      }
    },

    async ownToolDecision(surface, payload) {
      const call = ownToolCall(payload.toolCall.name, payload.toolCall.args);
      if (!call) return null;
      await tools.handle(refOf(surface, payload), call.tool, call.args, payload.stepIdx);
      return { decision: "allow" };
    },

    root: (ref) => registry.root(conversationKey(ref)),

    preInvocation(surface, payload) {
      if (opts.mode() !== "enforce") return {};
      const conv = registry.get(conversationKey(refOf(surface, payload)));
      // An unlinked subagent told to register would get a plan of its own and escape the parent's.
      if (!conv || conv.parent !== null || linker.mightBeChild(conv.ref)) return {};
      const root = registry.root(conv.key);
      if (root?.plan && root.plan.id !== "") return {};
      const draft = drafts.get(conv.key);
      const text = draft ? `${INTENT_DIRECTIVE}\n\n${planningDraftNote(draft)}` : INTENT_DIRECTIVE;
      // ASSUMPTION(P0): an ephemeralMessage reaches the model for this invocation only; the rules file stays the
      // standing instruction.
      return { injectSteps: [{ type: "ephemeralMessage", text }] };
    },

    mcpOutcome: (tool, args, waitMs) => tools.outcome(tool, args, waitMs),

    conversationEnded(ref) {
      const key = conversationKey(ref);
      pump.revoke(key, "antigravity conversation ended");
      drafts.delete(key);
    },
  };
}
