import type { HookPayload, HookResponse, ToolDecision } from "@armorantigravity/protocol";
import type { CompiledPolicy, CoreToolCall, Decision, DenyCode, Log, Mode, SessionID } from "./core-contract.ts";
import { checkGuard } from "./guard.ts";
import type { McpGate } from "./mcp-gate.ts";
import type { PolicySource } from "./policy-source.ts";
import { segmentedPolicy } from "./shell-policy.ts";
import { BUILTIN_MCP_SERVERS, mapToolCall, mcpPart, mcpToolName, type MapOptions, type MappedCall } from "./tools.ts";

// The part of the daemon's HookContext (packages/daemon/src/plugin.ts) the
// adapter reads; the daemon's own type is assignable to it.
export type HookInput = {
  readonly payload: HookPayload;
  readonly mode: Mode;
  readonly receivedAt: number;
};

// Wraps the core's decide() with the session store: the daemon resolves the
// conversation's session and root (plan, token, step cursor) and the builtin context.
export type DecideFn = (input: { call: CoreToolCall; policy: CompiledPolicy; mode: Mode; now: number }) => Decision;

export type AdapterDecision =
  | Decision
  | { kind: "deny"; code: "mcp_server_denied"; reason: string; ruleId: string | null }
  | { kind: "ask"; code: "mcp_server_unapproved"; reason: string; server: string };

export type AuditStatus = "blocked" | "held" | "allowed";

// Everything the audit and trace pumps need for a PreToolUse verdict: a
// `held` row for ask and force_ask, `blocked` for deny.
export type DecisionRecord = {
  readonly conversationId: string;
  readonly stepIdx: number;
  readonly at: number;
  readonly call: MappedCall;
  readonly decision: AdapterDecision;
  readonly status: AuditStatus;
  readonly response: HookResponse;
};

export type DecisionHandlerOptions = {
  readonly decide: DecideFn;
  readonly policy: PolicySource;
  readonly mcpGate: McpGate;
  readonly guard: { readonly home: string; readonly protectedPaths: readonly string[] };
  readonly map?: MapOptions;
  readonly log: Log;
  // Must not throw or block; it runs before the response is returned.
  readonly onDecision?: (record: DecisionRecord) => void;
};

const NO_OPINION: HookResponse = null;
// A server and tool no policy can name, to tell a rule about this server from a wildcard.
const PROBE = { server: "armoriq-unnamed-probe-server", tool: "armoriq_unnamed_probe_tool" };

// agy treats an empty PreToolUse response as a deny, and a hook allow only
// narrows its own permission checks, never widens them (P0 spike, spike/p0-hooks).
export function toHookResponse(decision: AdapterDecision): HookResponse {
  switch (decision.kind) {
    case "allow":
      return { decision: "allow" } satisfies ToolDecision;
    case "deny":
      return { decision: "deny", reason: `ArmorIQ blocked this call [${decision.code}]: ${decision.reason}` } satisfies ToolDecision;
    case "hold":
      // Not force_ask: agy auto-approves force_ask under --dangerously-skip-permissions (spike
      // ft-forceask), so a hold would run. Until approvals exist, a hold blocks, as in ArmorOpenCode v1.
      return { decision: "deny", reason: `ArmorIQ blocked this call until it is approved [approval_required]: ${decision.reason}` } satisfies ToolDecision;
    case "ask":
      return { decision: "ask", reason: decision.reason } satisfies ToolDecision;
  }
}

function statusOf(decision: AdapterDecision): AuditStatus {
  if (decision.kind === "deny") return "blocked";
  if (decision.kind === "allow") return "allowed";
  return "held";
}

function internalError(error: unknown): Decision {
  return { kind: "deny", code: "internal_error" satisfies DenyCode, reason: `ArmorIQ could not check this call: ${String(error)}`, ruleId: null };
}

export function createDecisionHandler(options: DecisionHandlerOptions): (hook: HookInput) => HookResponse {
  const { log } = options;

  const judge = (call: MappedCall, conversationId: string, stepIdx: number, workspace: string | null, mode: Mode, now: number): AdapterDecision => {
    if (!isSessionId(conversationId)) throw new Error("conversationId is empty");
    const guard = checkGuard(call, { ...options.guard, workspace });
    if (guard) return { kind: "deny", code: "builtin_protected", reason: guard.reason, ruleId: "builtin:guard_files" };

    const active = options.policy.current();
    const policy = segmentedPolicy(active.policy, { isShell: (c) => c.tool === "run_command", home: options.guard.home });
    const core: CoreToolCall = {
      sessionId: conversationId,
      callId: `${conversationId}:${stepIdx}`,
      tool: call.tool,
      args: call.args,
    };
    const decision = options.decide({ call: core, policy, mode, now });
    if (decision.kind !== "allow" || call.category !== "mcp" || mode === "monitor") return decision;

    const server = call.mcp.server;
    const verdict = options.mcpGate.check(server);
    if (verdict.kind === "approved") return decision;
    if (verdict.kind === "denied") {
      return { kind: "deny", code: "mcp_server_denied", reason: `MCP server "${server}" is denied on this device`, ruleId: null };
    }
    // A policy statement that names this server or tool approves it. A wildcard
    // permit, the built-in allow-all included, also matches the probe and does not.
    const named = policy.evaluate(core);
    if (named.effect === "permit" && named.ruleId !== null && !foldsAmbiguously(server, options.map?.knownMcpServers)) {
      const probe = policy.evaluate({ ...core, tool: mcpToolName(PROBE) });
      if (probe.ruleId !== named.ruleId) return decision;
    }
    return {
      kind: "ask",
      code: "mcp_server_unapproved",
      server,
      reason: `ArmorIQ: MCP server "${server}" is not approved. Approve this call, or have an admin register "${server}" in the ArmorIQ console.`,
    };
  };

  return (hook) => {
    const { payload, mode } = hook;
    if (payload.event !== "PreToolUse") return NO_OPINION;
    const call = mapToolCall(payload.toolCall, options.map);
    let decision: AdapterDecision;
    try {
      decision = judge(call, payload.conversationId, payload.stepIdx, payload.workspacePaths[0] ?? null, mode, hook.receivedAt);
    } catch (error) {
      log.error("decision failed", { tool: call.name, error: String(error) });
      decision = mode === "enforce" ? internalError(error) : { kind: "allow", stepIndex: null, paramMismatch: false };
    }
    const response = toHookResponse(decision);
    try {
      options.onDecision?.({
        conversationId: payload.conversationId,
        stepIdx: payload.stepIdx,
        at: hook.receivedAt,
        call,
        decision,
        status: statusOf(decision),
        response,
      });
    } catch (error) {
      log.error("decision observer failed", { error: String(error) });
    }
    return response;
  };
}

// mcp_<server>_<tool> folds `_` and `-` together, so `github_create`/`issue`
// and `github`/`create_issue` share a name. A rule naming one must not approve
// the other, so policy approval is off while another known server overlaps.
function foldsAmbiguously(server: string, known: ReadonlySet<string> = new Set()): boolean {
  const own = mcpPart(server);
  for (const other of [...known, ...BUILTIN_MCP_SERVERS]) {
    const k = mcpPart(other);
    if (k !== own && (own.startsWith(`${k}_`) || k.startsWith(`${own}_`))) return true;
  }
  return false;
}

// Antigravity's conversationId is the session id, used raw (PRD 4a session
// flow); parseHookPayload already refused an empty one.
function isSessionId(id: string): id is SessionID {
  return id.length > 0;
}
