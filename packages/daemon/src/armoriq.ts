import {
  ANTIGRAVITY,
  compileAntigravityPolicy,
  createCoreDecide,
  createDecisionHandler,
  createMcpGate,
  createPolicySource,
  DEFAULT_OWN_MCP_SERVER,
  guardPaths,
  type AdapterDecision,
  type BackendAccess,
  type DecisionRecord,
  type HookInput,
  type SessionPair,
} from "@armorantigravity/adapter";
import { DEFAULT_POLICY_SOURCE, toAuditRow, type AuditStatus, type CompiledPolicy, type Decision, type Session as CoreSession, type SessionID, type ToolCall as CoreToolCall } from "@armorantigravity/core";
import { callIdOf, createAgySource, evidencePlugin, type EvidenceRecorder } from "@armorantigravity/evidence";
import {
  conversationKey,
  createIntentRuntime,
  intentRegistration,
  OWN_TOOLS,
  ownToolName,
  withIntent,
  type Conversation,
  type IntentRuntime,
  type PolicyView,
} from "@armorantigravity/intent";
import type { HookPayload, HookResponse, Surface } from "@armorantigravity/protocol";
import { homedir } from "node:os";
import path from "node:path";
import type { DaemonContext, DaemonPlugin, HookContext, PluginRegistration } from "./plugin.ts";

const MAX_OPEN_CALLS = 10_000;

type PostToolUse = Extract<HookPayload, { event: "PostToolUse" }>;
type OpenCall = { readonly surface: Surface; readonly call: CoreToolCall; readonly decision: Decision; readonly at: number };

// Evidence is set up first so the guard can hand it every decision; the daemon runs setups in order.
export function armoriqPlugins(): readonly DaemonPlugin[] {
  let recorder: EvidenceRecorder | null = null;
  // agy's transcript names no model; every hook payload does, and hooks arrive before the turn end
  // that reads the transcript.
  const models = new Map<string, string>();
  const source = createAgySource({ cliHome: path.join(homedir(), ".gemini", "antigravity-cli"), modelOf: (id) => models.get(id) });
  return [
    {
      name: "models",
      setup: () => ({
        observe(event) {
          if (event.kind === "hook" && event.hook.payload.modelName) models.set(event.hook.payload.conversationId, event.hook.payload.modelName);
        },
      }),
    },
    evidencePlugin({ source, onRecorder: (r) => (recorder = r) }),
    {
      name: "guard",
      setup(ctx) {
        if (!recorder) throw new Error("the evidence plugin must be set up before the guard");
        return guardRegistration(ctx, recorder);
      },
    },
  ];
}

function guardRegistration(ctx: DaemonContext, recorder: EvidenceRecorder): PluginRegistration {
  const { log, auth } = ctx;
  const home = homedir();
  const access = (): BackendAccess | null => {
    const login = auth.uploadLogin();
    return login ? { login, client: `${auth.client.product}/${auth.client.version}` } : null;
  };
  const policy = createPolicySource({
    path: path.join(ctx.paths.dataDir, "policy.json"),
    compile: compileAntigravityPolicy,
    defaultSource: DEFAULT_POLICY_SOURCE,
    access,
    log,
  });
  const mcpGate = createMcpGate({ access, log, ownServer: DEFAULT_OWN_MCP_SERVER });
  const syncOrg = () => {
    void policy.refresh();
    void mcpGate.sync();
  };

  const runtime: IntentRuntime = createIntentRuntime({
    client: auth.client,
    login: () => auth.uploadLogin(),
    mode: () => auth.mode(),
    policy: () => policyView(policy.current().policy),
    mintPolicy: () => undefined,
    audit: (row) => recorder.audit(row, { surface: surfaceOf(runtime, row.session_id) }),
    // The intent backend flags relogin only for this exact response (sdk isReloginRequired).
    onRelogin: () => auth.reportStatus(403, { error: "relogin_required" }, "mint"),
    log,
  });
  const intent = intentRegistration(runtime);

  const sessions = (surface: Surface, id: SessionID): SessionPair => {
    const ref = { surface, conversationId: id };
    const own = runtime.registry.get(conversationKey(ref)) ?? runtime.registry.open(ref);
    const root = runtime.root(ref) ?? own;
    const rootSession = toCoreSession(root, null);
    return { session: root === own ? rootSession : toCoreSession(own, rootSession.id), root: rootSession };
  };

  const open = new Map<string, OpenCall>();
  const auditRow = (surface: Surface, call: CoreToolCall, decision: Decision, status: AuditStatus, extra: { at: number; durationMs: number | null; error: string | null }) => {
    const { session, root } = sessions(surface, call.sessionId);
    const login = auth.uploadLogin();
    const row = toAuditRow({ call, session, root, status, decision, output: null, ...extra, userId: login?.userId || undefined, userEmail: login?.email || undefined }, ANTIGRAVITY);
    recorder.audit(row, { surface });
  };

  const onDecision = (surface: Surface, record: DecisionRecord) => {
    const call: CoreToolCall = { sessionId: toSessionId(record.conversationId), callId: callIdOf(record.conversationId, record.stepIdx), tool: record.call.tool, args: record.call.args };
    const decision = toCoreDecision(record.decision);
    recorder.decided({
      conversationId: record.conversationId,
      stepIdx: record.stepIdx,
      tool: record.call.name,
      args: record.call.args,
      mcpServer: record.call.category === "mcp" ? record.call.mcp.server : null,
      decision,
      at: record.at,
    });
    if (record.status !== "allowed") auditRow(surface, call, decision, record.status, { at: record.at, durationMs: null, error: null });
    // A held call the user approves still runs; its result row comes from PostToolUse.
    if (record.status !== "blocked") {
      open.set(call.callId, { surface, call, decision, at: record.at });
      if (open.size > MAX_OPEN_CALLS) open.delete(open.keys().next().value ?? call.callId);
    }
  };

  const onResult = (payload: PostToolUse, at: number) => {
    const callId = callIdOf(payload.conversationId, payload.stepIdx);
    const opened = open.get(callId);
    if (!opened) return;
    open.delete(callId);
    const status: AuditStatus = payload.error === "" ? "success" : "failed";
    auditRow(opened.surface, opened.call, opened.decision, status, { at, durationMs: Math.max(0, at - opened.at), error: payload.error || null });
  };

  const builtin = { armoriqDir: ctx.paths.armoriqDir, ownTools: new Set<string>(OWN_TOOLS), shadowedTools: new Set<string>() };
  const guard = { home, protectedPaths: guardPaths(home) };
  // createCoreDecide resolves a session from the conversationId alone, but intent keys plans by surface too,
  // so each surface gets its own handler.
  const handlers = new Map<Surface, (hook: HookInput) => HookResponse>();
  const handlerFor = (surface: Surface) => {
    let handler = handlers.get(surface);
    if (!handler) {
      handler = createDecisionHandler({
        decide: createCoreDecide({ sessions: (id) => sessions(surface, id), builtin }),
        policy,
        mcpGate,
        guard,
        log,
        onDecision: (record) => onDecision(surface, record),
      });
      handlers.set(surface, handler);
    }
    return handler;
  };

  const unsubscribe = auth.onChange(syncOrg);
  syncOrg();

  return {
    decide: withIntent(runtime, (hook: HookContext) => handlerFor(hook.session.surface)(hook)),
    observe(event) {
      intent.observe(event);
      if (event.kind === "session_start") syncOrg();
      if (event.kind === "hook" && event.hook.payload.event === "PostToolUse") onResult(event.hook.payload, event.hook.receivedAt);
    },
    pumps: [
      ...intent.pumps,
      {
        name: "policy",
        kick() {},
        async stop() {
          unsubscribe();
          policy.stop();
        },
      },
    ],
    mcpOutcome: async (tool, args, waitMs) => {
      const own = ownToolName(tool);
      return own ? runtime.mcpOutcome(own, args, waitMs) : null;
    },
  };
}

function isSessionId(id: string): id is SessionID {
  return id.length > 0;
}

function toSessionId(id: string): SessionID {
  if (!isSessionId(id)) throw new Error("empty conversationId");
  return id;
}

function toCoreSession(c: Conversation, parentId: SessionID | null): CoreSession {
  return {
    id: toSessionId(c.ref.conversationId),
    parentId,
    mode: "enforce",
    plan: c.plan,
    token: c.token,
    stepCursor: c.stepCursor,
    revisionsThisMessage: c.revisionsThisTurn,
    currentMessageId: `turn-${c.turn}`,
  };
}

const POLICY_VIEW_SESSION = toSessionId("armoriq-policy-view");

function policyView(compiled: CompiledPolicy): PolicyView {
  return {
    hash: compiled.hash,
    intentRequired: compiled.intentRequired,
    evaluate: (tool, args) => compiled.evaluate({ sessionId: POLICY_VIEW_SESSION, callId: "", tool, args }),
  };
}

// Core's Decision has no MCP gate verdicts: an unapproved server is a hold and a denied one a forbid.
function toCoreDecision(decision: AdapterDecision): Decision {
  if (decision.kind === "ask") return { kind: "hold", ruleId: null, reason: decision.reason };
  if (decision.kind === "deny" && decision.code === "mcp_server_denied") return { kind: "deny", code: "policy_forbid", reason: decision.reason, ruleId: decision.ruleId };
  return decision;
}

function surfaceOf(runtime: IntentRuntime, conversationId: string): Surface {
  for (const c of runtime.registry.all()) if (c.ref.conversationId === conversationId) return c.ref.surface;
  return "unknown";
}
