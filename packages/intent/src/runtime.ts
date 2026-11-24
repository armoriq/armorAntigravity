import type { HookPayload, HookResponse, Surface, ToolDecision } from "@armorantigravity/protocol";
import { basename, dirname } from "node:path";
import { createSdkBackend, type ClientIdentity } from "./backend.ts";
import { INTENT_DIRECTIVE, planningDraftNote } from "./directive.ts";
import { createOwnTools, ownToolCall, type OwnTool } from "./own-tools.ts";
import { isPlainObject, planToolName } from "./plan.ts";
import { createTokenPump } from "./pump.ts";
import { safeRunRecorder } from "./reporting.ts";
import { intentValiditySeconds } from "./plan-request.ts";
import { createRegistry, type Conversation, type Registry } from "./registry.ts";
import { createSubagentLinker } from "./subagents.ts";
import { conversationKey, type AuditRow, type ConversationKey, type ConversationRef, type IntentBackend, type Log, type Login, type Mode, type PlanRequestHealth, type PolicyView, type RunRecorder } from "./types.ts";

type PreToolUse = Extract<HookPayload, { event: "PreToolUse" }>;

// ASSUMPTION(P0 #1, issue #30): planning mode writes these artifacts into artifactDirectoryPath through a file
// tool. The names are in the agy binary; a planning-mode capture has not confirmed how they are written.
const PLAN_ARTIFACTS: ReadonlySet<string> = new Set(["implementation_plan.md", "task.md"]);
const CHILD_MESSAGE_WINDOW_MS = 60_000;
// Each file-writing tool and the argument agy writes the path to (agy 1.4 renamed both).
const FILE_WRITE_TOOLS: ReadonlyMap<string, string> = new Map([
  ["write_to_file", "TargetFile"],
  ["replace_file_content", "TargetFile"],
  ["multi_replace_file_content", "TargetFile"],
  ["write_file", "Path"],
  ["edit_file", "Path"],
]);

export interface IntentRuntimeOptions {
  readonly client: ClientIdentity;
  login(): Login | null;
  mode(): Mode;
  policy(): PolicyView;
  // The compiled local policy for the mint body; see compileMintPolicy.
  mintPolicy(): Record<string, unknown> | undefined;
  audit(row: AuditRow): void;
  onRelogin?(reason: string): void;
  onUnauthorized?(): void;
  onAuthenticated?(login: Login): void;
  readonly log: Log;
  readonly backend?: IntentBackend;
  readonly now?: () => number;
  readonly fileExists?: (path: string) => boolean;
  readonly stateFile?: string;
  readonly health?: PlanRequestHealth;
  readonly runs?: RunRecorder;
  readonly runToolName?: (call: PreToolUse["toolCall"]) => string;
}

export interface IntentRuntime {
  readonly registry: Registry;
  // Call on every hook event before deciding: opens the conversation, links subagents, tracks turns.
  observe(surface: Surface, payload: HookPayload, receivedAt?: number): void;
  // Plan tools persist the request and start registration without waiting for the network. The MCP server
  // waits for the outcome. Other own tools finish before allowing the call. Null for every other tool.
  ownToolDecision(surface: Surface, payload: PreToolUse): Promise<ToolDecision | null>;
  // The conversation whose plan and token a check uses; a subagent resolves to its root.
  root(ref: ConversationRef): Conversation | null;
  // PreInvocation response: the plan directive while the current root prompt has no registered plan.
  preInvocation(surface: Surface, payload: HookPayload): HookResponse;
  authChanged(): void;
  beforeTool(ref: ConversationRef): Promise<void>;
  mcpOutcome(tool: OwnTool, args: unknown, waitMs: number): Promise<string | null>;
  conversationEnded(ref: ConversationRef): void;
  readonly pump: { readonly name: string; kick(): void; stop(): Promise<void> };
}

export function createIntentRuntime(opts: IntentRuntimeOptions): IntentRuntime {
  const runs = safeRunRecorder(opts.runs, opts.log);
  const now = opts.now ?? Date.now;
  const validitySeconds = intentValiditySeconds(process.env);
  const registry = createRegistry(now, opts.stateFile, opts.log);
  const syncAuth = () => registry.syncAuth(opts.login(), opts.mode());
  syncAuth();
  const backend = opts.backend ?? createSdkBackend({ client: opts.client, log: opts.log });
  const tools = createOwnTools({
    registry,
    backend,
    login: opts.login,
    mode: opts.mode,
    policy: opts.policy,
    audit: opts.audit,
    log: opts.log,
    now,
    validitySeconds,
    mintPolicy: opts.mintPolicy,
    ...(opts.health ? { health: opts.health } : {}),
    ...(opts.runs ? { runs: opts.runs } : {}),
    ...(opts.onRelogin ? { onRelogin: opts.onRelogin } : {}),
    ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
    ...(opts.onAuthenticated ? { onAuthenticated: opts.onAuthenticated } : {}),
  });
  const pump = createTokenPump({ registry, backend, login: opts.login, mode: opts.mode, log: opts.log, now, validitySeconds, mintPolicy: opts.mintPolicy, ...(opts.health ? { health: opts.health } : {}), ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}), ...(opts.onAuthenticated ? { onAuthenticated: opts.onAuthenticated } : {}) });
  const linker = createSubagentLinker(registry, now, opts.fileExists);
  const drafts = new Map<ConversationKey, string>();
  const childMessagedAt = new Map<ConversationKey, number>();
  pump.start();

  const refOf = (surface: Surface, payload: HookPayload): ConversationRef => ({ surface, conversationId: payload.conversationId });

  function notePlanArtifact(ref: ConversationRef, payload: PreToolUse): void {
    const dir = payload.artifactDirectoryPath;
    const args = payload.toolCall.args;
    const field = FILE_WRITE_TOOLS.get(payload.toolCall.name);
    if (!dir || !field || !isPlainObject(args)) return;
    const target = args[field];
    if (typeof target !== "string" || dirname(target) !== dir || !PLAN_ARTIFACTS.has(basename(target))) return;
    const root = registry.root(conversationKey(ref));
    if (root) drafts.set(root.key, target);
  }

  return {
    registry,
    pump: { name: "intent-token", kick: pump.kick, stop: async () => {
      const stopping = pump.stop();
      if (runs && runs.enabled !== false) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([tools.settled(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(timer); }
      }
      await stopping;
    } },

    observe(surface, payload, receivedAt = now()) {
      syncAuth();
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
          if (payload.invocationNum === 0 && !fromChild) {
            const previous = registry.get(key)?.promptId ?? null;
            registry.beginPrompt(key, payload.initialNumSteps);
            const current = registry.get(key);
            if (current?.parent === null && current.promptId && current.promptId !== previous) {
              runs?.end(previous, "next_prompt", now());
              runs?.begin(current.promptId, current.ref.conversationId, current.promptOpenSince ?? now(), opts.mode() === "enforce" && opts.policy().intentRequired);
              void runs?.kick();
            }
          }
          return;
        }
        case "PreToolUse": {
          const { name, args } = payload.toolCall;
          const conv = registry.get(key);
          if (conv?.parent === null && !linker.mightBeChild(ref)) {
            const canonical = opts.runToolName?.(payload.toolCall) ?? ownToolCall(name, args)?.tool ?? planToolName(name);
            runs?.attempt(conv.promptId, String(payload.stepIdx), canonical, opts.mode() === "enforce" && opts.policy().intentRequired);
          }
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
          if (registry.get(key)?.parent === null) {
            const current = registry.get(key)!;
            if (current.promptOpenSince === null || receivedAt >= current.promptOpenSince) runs?.end(current.promptId, "stop", receivedAt);
            void runs?.kick();
          }
          registry.endPrompt(key);
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
      syncAuth();
      const call = ownToolCall(payload.toolCall.name, payload.toolCall.args);
      if (!call) return null;
      const result = tools.handle(refOf(surface, payload), call.tool, call.args, payload.stepIdx);
      if (call.tool !== "register_intent_plan" && call.tool !== "trust_reanchor") await result;
      return { decision: "allow" };
    },

    root(ref) {
      syncAuth();
      return registry.root(conversationKey(ref));
    },

    authChanged: syncAuth,
    beforeTool: ref => pump.beforeTool(conversationKey(ref)),

    preInvocation(surface, payload) {
      syncAuth();
      if (opts.mode() !== "enforce") return null;
      const conv = registry.get(conversationKey(refOf(surface, payload)));
      // An unlinked subagent told to register would get a plan of its own and escape the parent's.
      if (!conv || conv.parent !== null || linker.mightBeChild(conv.ref)) return null;
      if (conv.countedPlanId !== null) return null;
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
      registry.close(key);
      drafts.delete(key);
      childMessagedAt.delete(key);
    },
  };
}
