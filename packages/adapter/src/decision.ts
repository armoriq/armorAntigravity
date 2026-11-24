import type { HookPayload, HookResponse, ToolDecision } from "@armorantigravity/protocol";
import path from "node:path";
import type { CompiledPolicy, CoreToolCall, Decision, DenyCode, Log, Mode, SessionID } from "./core-contract.ts";
import { checkGuard } from "./guard.ts";
import type { McpGate } from "./mcp-gate.ts";
import type { PolicyOrigin, PolicySource } from "./policy-source.ts";
import { decideV2, type PolicyBundle, type V2Call, type V2Outcome, type V2Verdict } from "./policy-v2.ts";
import { segmentedPolicy } from "./shell-policy.ts";
import { BUILTIN_MCP_SERVERS, mapToolCall, mcpPart, mcpToolName, nameReadings, type MapOptions, type MappedCall } from "./tools.ts";

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
  | { kind: "deny"; code: "login_rejected" | "org_mode_unknown" | "policy_bundle_unusable"; reason: string; ruleId: null }
  | { kind: "deny"; code: "mcp_server_unapproved"; reason: string; ruleId: null };

export type AuditStatus = "blocked" | "held" | "allowed";

export type PolicySourceKind = "v2" | "v1_org" | "local" | "default" | "builtin";

type V2Ref = { readonly policyId: string; readonly policyName: string; readonly policyHash: string | null; readonly rule: string };

// Which layer decided, for audit rows: a v2 policy, the org's v1 profile, the local
// policy.json, the built-in default, or one of the guard's own rules.
export type PolicyAttribution = {
  readonly source: PolicySourceKind;
  readonly v2: V2Ref | null;
  readonly ruleId: string | null;
  readonly shadow: readonly (V2Ref & { readonly verdict: V2Verdict["verdict"] })[];
};

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
  readonly attribution: PolicyAttribution;
};

// A call a v2 policy holds for approval, as the hold resolver sees it.
export type HeldCall = {
  readonly conversationId: string;
  readonly stepIdx: number;
  readonly call: MappedCall;
  // Antigravity's own arguments, before the adapter adds canonical fields.
  readonly rawArgs: Readonly<Record<string, unknown>>;
  readonly policyName: string;
  readonly ruleId: string | null;
  readonly reason: string;
};

// Settles a v2 hold with the backend: allow once an approval is spent, deny when the backend blocks,
// otherwise a hold whose reason names the approval request.
export type HoldResolver = (held: HeldCall) => Promise<AdapterDecision>;

export type DecisionHandlerOptions = {
  readonly decide: DecideFn;
  readonly policy: PolicySource;
  // Policy v2: when it holds an active document for this agent, its verdict applies on top of
  // v1 and the local file, and the stricter of the two wins.
  readonly bundle?: PolicyBundle;
  readonly userEmail?: () => string | undefined;
  readonly mcpGate: McpGate;
  readonly guard: { readonly home: string; readonly protectedPaths: readonly string[] };
  readonly map?: MapOptions;
  readonly log: Log;
  // Must not throw or block; it runs before the response is returned.
  readonly onDecision?: (record: DecisionRecord) => void;
  readonly resolveHold?: HoldResolver;
  // Workspace Monitor, signed in: every check runs and is recorded, and the call goes ahead.
  readonly orgMonitor?: () => boolean;
};

const NO_OPINION: HookResponse = null;
const ALLOW: AdapterDecision = { kind: "allow", stepIndex: null, paramMismatch: false };
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
      // ft-forceask), so a hold would run. A hold blocks; for a v2 hold the reason names the approval
      // request, and the retry after approval is allowed by the hold resolver.
      return { decision: "deny", reason: `ArmorIQ blocked this call until it is approved [approval_required]: ${decision.reason}` } satisfies ToolDecision;
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

const ALWAYS_ENFORCED: ReadonlySet<string> = new Set(["builtin_protected", "mcp_server_denied", "mcp_server_unapproved", "internal_error"]);
const RANK: Record<AdapterDecision["kind"], number> = { allow: 0, hold: 1, deny: 2 };
const BUILTIN = (ruleId: string | null): PolicyAttribution => ({ source: "builtin", v2: null, ruleId, shadow: [] });
const ORIGIN_SOURCE: Record<PolicyOrigin, PolicySourceKind> = { backend: "v1_org", file: "local", default: "default", fail_closed: "local" };

function v2Ref(v: V2Verdict): V2Ref | null {
  return v.policy ? { policyId: v.policy.policyId, policyName: v.policy.name, policyHash: v.policy.policyHash, rule: v.rule } : null;
}

function v2Decision(v: V2Verdict): AdapterDecision {
  const named = v.policy ? `ArmorIQ policy "${v.policy.name}"` : "ArmorIQ";
  const ruleId = v.policy ? `v2:${v.policy.policyId}:${v.rule}` : `v2:${v.rule}`;
  if (v.verdict === "block") {
    const reason = v.policy ? `${named} blocks this call (rule ${v.rule})` : "this agent is deactivated in the ArmorIQ console";
    return { kind: "deny", code: "policy_forbid", reason, ruleId };
  }
  if (v.verdict === "hold") return { kind: "hold", ruleId, reason: `${named} requires approval for this call (rule ${v.rule})` };
  return { kind: "allow", stepIndex: null, paramMismatch: false };
}

// policy-ir CAPABILITY_KEYS; `files` and `network` are what spec.files and spec.network rules match on.
const CAPABILITIES: Partial<Record<MappedCall["category"], readonly string[]>> = { shell: ["shell"], write: ["file.write", "files"], read: ["file.read", "files"], subagent: ["subagent"] };

function homeRelative(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

export function v2CallOf(call: MappedCall, home: string, at: number, userEmail: string | undefined, workspace: string | null = null): V2Call {
  const text = (k: string) => (typeof call.args[k] === "string" ? (call.args[k] as string) : undefined);
  const names = call.category === "mcp" ? [call.mcp.tool, call.tool, call.name] : [...nameReadings(call.tool), call.name];
  const capabilities = call.category === "web" ? (call.tool === "search_web" ? ["web.search"] : ["web.fetch", "network"]) : [...(CAPABILITIES[call.category] ?? [])];
  const derived: Record<string, unknown> = {};
  const command = text("command");
  const file = text("filePath") ?? text("path");
  const url = text("url");
  if (call.category === "shell" && command !== undefined) derived.command = command;
  if (file !== undefined) {
    derived.path = homeRelative(file, home);
    if (workspace !== null && path.isAbsolute(file)) {
      const rel = path.relative(workspace, path.resolve(file));
      derived.withinWorkspace = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    }
  }
  if (url !== undefined) {
    derived.url = url;
    // A browser navigation reaches a host too, so network rules apply to it.
    if (!capabilities.includes("network")) capabilities.push("network");
    try {
      derived.host = new URL(url).hostname;
    } catch {}
  }
  return {
    names: [...new Set(names)],
    ...(call.category === "mcp" ? { mcpServer: call.mcp.server } : {}),
    args: call.args,
    capabilities,
    derived,
    ...(userEmail ? { userEmail } : {}),
    at,
  };
}

export function createDecisionHandler(options: DecisionHandlerOptions & { resolveHold: HoldResolver }): (hook: HookInput) => HookResponse | Promise<HookResponse>;
export function createDecisionHandler(options: DecisionHandlerOptions): (hook: HookInput) => HookResponse;
export function createDecisionHandler(options: DecisionHandlerOptions): (hook: HookInput) => HookResponse | Promise<HookResponse> {
  const { log } = options;

  type Judged = { decision: AdapterDecision; attribution: PolicyAttribution };

  const judge = (call: MappedCall, conversationId: string, stepIdx: number, workspace: string | null, mode: Mode, now: number): Judged => {
    if (!isSessionId(conversationId)) throw new Error("conversationId is empty");
    const guard = checkGuard(call, { ...options.guard, workspace });
    if (guard) return { decision: { kind: "deny", code: "builtin_protected", reason: guard.reason, ruleId: "builtin:guard_files" }, attribution: BUILTIN("builtin:guard_files") };

    const local = judgeLocal(call, conversationId, stepIdx, mode, now);
    // Monitor still enforces v1 policy (it only skips intent checks), so v2 applies in both modes;
    // signed out, the bundle is empty.
    const v2 = decideV2(options.bundle?.current() ?? null, v2CallOf(call, options.guard.home, now, options.userEmail?.(), workspace));
    return combine(local, v2);
  };

  const combine = (local: Judged, v2: V2Outcome | null): Judged => {
    const shadow = (v2?.shadow ?? []).flatMap((s) => {
      const ref = v2Ref(s);
      return ref ? [{ ...ref, verdict: s.verdict }] : [];
    });
    for (const s of shadow) if (s.verdict !== "allow") log.info("shadow v2 policy would not allow this call", { policy: s.policyName, verdict: s.verdict, rule: s.rule });
    const enforced = v2?.enforced;
    if (!enforced) return { decision: local.decision, attribution: { ...local.attribution, shadow } };
    const attribution: PolicyAttribution =
      enforced.verdict === "allow" && enforced.rule === "tools.default"
        ? { source: "default", v2: null, ruleId: enforced.rule, shadow }
        : { source: "v2", v2: v2Ref(enforced), ruleId: null, shadow };
    const decision = v2Decision(enforced);
    // Ties go to v2 so a block names its policy; two allows keep the local one, which carries the plan step.
    if (RANK[decision.kind] < RANK[local.decision.kind]) return { decision: local.decision, attribution: { ...local.attribution, shadow } };
    return { decision: decision.kind === "allow" ? local.decision : decision, attribution };
  };

  const judgeLocal = (call: MappedCall, conversationId: SessionID, stepIdx: number, mode: Mode, now: number): Judged => {
    const active = options.policy.current();
    const policy = segmentedPolicy(active.policy, { isShell: (c) => c.tool === "run_command", home: options.guard.home });
    const core: CoreToolCall = {
      sessionId: conversationId,
      callId: `${conversationId}:${stepIdx}`,
      tool: call.tool,
      args: call.args,
    };
    const decision = options.decide({ call: core, policy, mode, now });
    const fromPolicy = (d: AdapterDecision): Judged => {
      const ruleId = d.kind === "deny" || d.kind === "hold" ? d.ruleId : null;
      const builtin = d.kind === "deny" && d.code !== "policy_forbid";
      return { decision: d, attribution: builtin ? BUILTIN(ruleId) : { source: ORIGIN_SOURCE[active.origin], v2: null, ruleId, shadow: [] } };
    };
    if (decision.kind !== "allow" || call.category !== "mcp") return fromPolicy(decision);

    const server = call.mcp.server;
    const verdict = options.mcpGate.check(server);
    if (verdict.kind === "approved") return fromPolicy(decision);
    if (verdict.kind === "denied") {
      return { decision: { kind: "deny", code: "mcp_server_denied", reason: `MCP server "${server}" is denied on this device`, ruleId: null }, attribution: BUILTIN("builtin:mcp_server_denied") };
    }
    // A policy statement that names this server or tool approves it. A wildcard
    // permit, the built-in allow-all included, also matches the probe and does not.
    const named = policy.evaluate(core);
    if (named.effect === "permit" && named.ruleId !== null && !foldsAmbiguously(server, options.map?.knownMcpServers)) {
      const probe = policy.evaluate({ ...core, tool: mcpToolName(PROBE) });
      if (probe.ruleId !== named.ruleId) return fromPolicy(decision);
    }
    return {
      decision: {
        kind: "deny",
        code: "mcp_server_unapproved",
        ruleId: null,
        reason: `MCP server "${server}" is not approved. Have an admin register "${server}" in the ArmorIQ console, or name it in the local policy file.`,
      },
      attribution: BUILTIN("builtin:mcp_server_unapproved"),
    };
  };

  return (hook) => {
    const { payload, mode } = hook;
    if (payload.event !== "PreToolUse") return NO_OPINION;
    const call = mapToolCall(payload.toolCall, options.map);
    let judged: Judged;
    try {
      judged = judge(call, payload.conversationId, payload.stepIdx, payload.workspacePaths[0] ?? null, mode, hook.receivedAt);
    } catch (error) {
      log.error("decision failed", { tool: call.name, error: String(error) });
      judged = { decision: internalError(error), attribution: BUILTIN("builtin:internal_error") };
    }
    const orgMonitor = options.orgMonitor?.() === true;
    const finish = (decision: AdapterDecision): HookResponse => {
      // In Monitor the stop decision is kept for the audit row (would_be) and the call runs.
      const monitoring = orgMonitor && !ALWAYS_ENFORCED.has(decision.kind === "deny" ? decision.code : "");
      const response = monitoring ? toHookResponse(ALLOW) : toHookResponse(decision);
      try {
        options.onDecision?.({
          conversationId: payload.conversationId,
          stepIdx: payload.stepIdx,
          at: hook.receivedAt,
          call,
          decision,
          status: monitoring ? "allowed" : statusOf(decision),
          response,
          attribution: judged.attribution,
        });
      } catch (error) {
        log.error("decision observer failed", { error: String(error) });
      }
      return response;
    };
    const { decision, attribution } = judged;
    const resolveHold = options.resolveHold;
    // A Monitor call has already run by the time anyone could approve it, and an enforce spends approvals.
    if (orgMonitor || decision.kind !== "hold" || attribution.source !== "v2" || !attribution.v2 || !resolveHold) return finish(decision);
    const held: HeldCall = {
      conversationId: payload.conversationId,
      stepIdx: payload.stepIdx,
      call,
      rawArgs: isRecord(payload.toolCall.args) ? payload.toolCall.args : {},
      policyName: attribution.v2.policyName,
      ruleId: decision.ruleId,
      reason: decision.reason,
    };
    return resolveHold(held)
      .catch((error: unknown): AdapterDecision => {
        log.error("hold resolution failed", { tool: call.name, error: String(error) });
        return { ...decision, reason: `${decision.reason}; the approval request could not be filed: ${String(error)}` };
      })
      .then(finish);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
