import {
  ANTIGRAVITY,
  capabilityOf,
  compileAntigravityPolicy,
  createCoreDecide,
  createDecisionHandler,
  createMcpGate,
  createPolicyBundle,
  createPolicySource,
  DEFAULT_OWN_MCP_SERVER,
  guardPaths,
  mapToolCall,
  toHookResponse,
  type AdapterDecision,
  type BackendAccess,
  type DecisionRecord,
  type HookInput,
  type MappedCall,
  type PolicyAttribution,
  type SessionPair,
  V2_AGENT,
} from "@armorantigravity/adapter";
import { DEFAULT_POLICY_SOURCE, toAuditRow, type AuditStatus, type Capability, type CompiledPolicy, type Decision, type Session as CoreSession, type SessionID, type ToolCall as CoreToolCall } from "@armorantigravity/core";
import { callIdOf, createAgySource, evidencePlugin, type EvidenceRecorder } from "@armorantigravity/evidence";
import {
  AGENT_ID,
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
import { loginBinding, type AuthState, type FailClosed } from "./auth.ts";
import { createHoldResolver, type SignedPlan } from "./hold.ts";
import { createReachability, type Reachability } from "./reachability.ts";
import { APP_DATA_DIRS } from "./surface.ts";

const MAX_OPEN_CALLS = 10_000;
const ORG_MODE_WAIT_MS = 3_000;

type PostToolUse = Extract<HookPayload, { event: "PostToolUse" }>;
type PreToolUse = Extract<HookPayload, { event: "PreToolUse" }>;
type OpenCall = {
  readonly surface: Surface;
  readonly call: CoreToolCall;
  readonly decision: Decision;
  readonly attribution: PolicyAttribution;
  readonly capability: Capability;
  readonly at: number;
};

const BUILTIN_ATTRIBUTION: PolicyAttribution = { source: "builtin", v2: null, ruleId: null, shadow: [] };

// conmap's audit DTO rejects unknown top-level fields, so the deciding source rides in `input`
// under a key every ArmorIQ plugin shares. A blocked v2 row also carries `output.matchedPolicy`,
// the shape the console reads to name the policy (conmap iap.service matchedPolicy()).
function withAttribution<T extends { input: Record<string, unknown>; output?: Record<string, unknown>; status: AuditStatus }>(row: T, a: PolicyAttribution): T {
  const ruleId = a.v2?.rule ?? a.ruleId;
  row.input = {
    ...row.input,
    armoriq_policy: {
      source: a.source,
      ...(a.v2 ? { policy_id: a.v2.policyId, policy_name: a.v2.policyName, policy_hash: a.v2.policyHash } : {}),
      ...(ruleId ? { rule_id: ruleId } : {}),
      ...(a.shadow.length ? { shadow: a.shadow.map((s) => ({ policy_id: s.policyId, policy_name: s.policyName, verdict: s.verdict, rule_id: s.rule })) } : {}),
    },
  };
  if (a.v2 && (row.status === "blocked" || row.status === "held") && row.output === undefined) {
    row.output = { matchedPolicy: { policyId: a.v2.policyId, name: a.v2.policyName, policyVersion: a.v2.policyHash } };
  }
  return row;
}

export const DOCTOR_COMMAND = "armorantigravity status";

// Evidence is set up first so the guard can hand it every decision; the daemon runs setups in order.
export function armoriqPlugins(): readonly DaemonPlugin[] {
  let recorder: EvidenceRecorder | null = null;
  // agy's transcript names no model; every hook payload does, and hooks arrive before the turn end
  // that reads the transcript.
  const models = new Map<string, string>();
  const appDirs = Object.entries(APP_DATA_DIRS).map(([name, surface]) => ({ dir: path.join(homedir(), ".gemini", name), surface }));
  const source = createAgySource({ appDirs, modelOf: (id) => models.get(id) });
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
        return guardRegistration(ctx, recorder, defaultReachability(ctx));
      },
    },
  ];
}

function defaultReachability({ log, auth }: DaemonContext): Reachability {
  return createReachability({
    log,
    headers: auth.headers,
    // A probe still in flight when the key changed must not decide the new key's state.
    onResponse: (probed, status, body) => {
      const state = auth.state();
      if ("login" in state && loginBinding(state.login) === loginBinding(probed)) auth.reportStatus(status, body, "probe");
    },
  });
}

function guardRegistration(ctx: DaemonContext, recorder: EvidenceRecorder, reachability: Reachability): PluginRegistration {
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
    onOrgMode: (mode) => {
      const before = auth.mode();
      auth.orgMode.set(mode);
      if (auth.mode() !== before) log.info("workspace mode changed", { mode: mode.mode, notices: mode.notices });
    },
  });
  const bundle = createPolicyBundle({ access, log });
  const mcpGate = createMcpGate({ access, log, ownServer: DEFAULT_OWN_MCP_SERVER });
  const syncOrg = () => {
    void policy.refresh();
    void bundle.refresh();
    void mcpGate.sync();
  };

  const runtime: IntentRuntime = createIntentRuntime({
    client: auth.client,
    login: () => auth.uploadLogin(),
    mode: () => auth.mode(),
    policy: () => policyView(policy.current().policy),
    mintPolicy: () => undefined,
    // Intent rows come from the plugin's own MCP tools.
    audit: (row) => recorder.audit({ ...row, capability: "mcp" }, { surface: surfaceOf(runtime, row.session_id) }),
    // The intent backend flags relogin only for this exact response (sdk isReloginRequired).
    onRelogin: () => auth.reportStatus(403, { error: "relogin_required" }, "mint"),
    onUnauthorized: () => auth.reportStatus(401, null, "mint"),
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
  const auditRow = (
    surface: Surface,
    call: CoreToolCall,
    decision: Decision,
    attribution: PolicyAttribution,
    status: AuditStatus,
    extra: { at: number; durationMs: number | null; error: string | null; capability: Capability },
  ) => {
    const { session, root } = sessions(surface, call.sessionId);
    const login = auth.uploadLogin();
    // Logged out is monitor mode: nothing is recorded, so no row can upload later under no user.
    if (!login) return;
    const row = toAuditRow({ call, session, root, status, decision, output: null, ...extra, userId: login.userId || undefined, userEmail: login.email || undefined }, ANTIGRAVITY);
    recorder.audit(withAttribution(row, attribution), { surface });
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
    const capability = capabilityOf(record.call);
    if (record.status !== "allowed") auditRow(surface, call, decision, record.attribution, record.status, { at: record.at, durationMs: null, error: null, capability });
    // A held call the user approves still runs; its result row comes from PostToolUse.
    if (record.status !== "blocked") {
      open.set(call.callId, { surface, call, decision, attribution: record.attribution, capability, at: record.at });
      if (open.size > MAX_OPEN_CALLS) open.delete(open.keys().next().value ?? call.callId);
    }
  };

  const onResult = (payload: PostToolUse, at: number) => {
    const callId = callIdOf(payload.conversationId, payload.stepIdx);
    const opened = open.get(callId);
    if (!opened) return;
    open.delete(callId);
    const status: AuditStatus = payload.error === "" ? "success" : "failed";
    auditRow(opened.surface, opened.call, opened.decision, opened.attribution, status, { at, durationMs: Math.max(0, at - opened.at), error: payload.error || null, capability: opened.capability });
  };

  const posture = async (surface: Surface, payload: PreToolUse, at: number): Promise<HookResponse | null> => {
    const state = auth.state();
    if (state.kind === "local_only") void reachability.check(state.login);
    const call: MappedCall = mapToolCall(payload.toolCall);
    if (capabilityOf(call) === "read") return null;
    if (auth.failClosed()?.code === "org_mode_unknown") await withinMs(policy.refresh(), ORG_MODE_WAIT_MS);
    const decision = closedFor(auth.failClosed()) ?? (await unusable(state)) ?? closedFor(auth.failClosed());
    if (!decision) return null;
    const response = toHookResponse(decision);
    onDecision(surface, { conversationId: payload.conversationId, stepIdx: payload.stepIdx, at, call, decision, status: "blocked", response, attribution: BUILTIN_ATTRIBUTION });
    return response;
  };

  const unusable = async (state: AuthState): Promise<AdapterDecision | null> => {
    if ((state.kind !== "active" && state.kind !== "refused") || auth.mode() === "monitor") return null;
    if (bundle.agentMissing()) {
      return { kind: "deny", code: "policy_bundle_unusable", reason: `the ArmorIQ policy bundle does not list the ${V2_AGENT} agent; only read calls run until it does. Run \`${DOCTOR_COMMAND}\` to check.`, ruleId: null };
    }
    const reach = await reachability.check(state.login);
    if (reach.kind !== "unreachable") return null;
    return {
      kind: "deny",
      code: "backend_unreachable",
      reason: `the ArmorIQ backend at ${state.login.backend} is unreachable (${reach.reason}); only read calls run until it answers. Run \`${DOCTOR_COMMAND}\` to check.`,
      ruleId: null,
    };
  };

  const builtin = { armoriqDir: ctx.paths.armoriqDir, ownTools: new Set<string>(OWN_TOOLS), shadowedTools: new Set<string>() };
  const guard = { home, protectedPaths: guardPaths(home) };
  // createCoreDecide resolves a session from the conversationId alone, but intent keys plans by surface too,
  // so each surface gets its own handler.
  const signedPlan = (surface: Surface, conversationId: string): SignedPlan | null => {
    const root = runtime.root({ surface, conversationId });
    const token = root?.token;
    if (!root?.plan?.id || token?.status !== "active" || !token.jwt) return null;
    return { planId: root.plan.id, jwt: token.jwt };
  };
  const handlers = new Map<Surface, (hook: HookInput) => HookResponse | Promise<HookResponse>>();
  const handlerFor = (surface: Surface) => {
    let handler = handlers.get(surface);
    if (!handler) {
      handler = createDecisionHandler({
        decide: createCoreDecide({ sessions: (id) => sessions(surface, id), builtin }),
        policy,
        bundle,
        userEmail: () => auth.uploadLogin()?.email || undefined,
        mcpGate,
        guard,
        log,
        onDecision: (record) => onDecision(surface, record),
        orgMonitor: () => auth.orgMonitor(),
        resolveHold: createHoldResolver({ access, plan: (id) => signedPlan(surface, id), agentId: AGENT_ID, builtinServer: AGENT_ID, log }),
      });
      handlers.set(surface, handler);
    }
    return handler;
  };

  const unsubscribe = auth.onChange(syncOrg);
  syncOrg();

  return {
    // The plugin's own intent tools are decided before this runs; they need the backend anyway and fail on their own.
    decide: withIntent(runtime, async (hook: HookContext) => {
      const surface = hook.session.surface;
      if (hook.payload.event !== "PreToolUse") return handlerFor(surface)(hook);
      const blocked = await posture(surface, hook.payload, hook.receivedAt);
      // A probe can turn a 401 into local-only mode; decide with the mode it left behind.
      return blocked ?? handlerFor(surface)({ payload: hook.payload, mode: auth.mode(), receivedAt: hook.receivedAt });
    }),
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
          bundle.stop();
        },
      },
    ],
    mcpOutcome: async (tool, args, waitMs) => {
      const own = ownToolName(tool);
      return own ? runtime.mcpOutcome(own, args, waitMs) : null;
    },
  };
}

function closedFor(closed: FailClosed | null): AdapterDecision | null {
  return closed ? { kind: "deny", code: closed.code, reason: closed.reason, ruleId: null } : null;
}

async function withinMs(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work.catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
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

function toCoreDecision(decision: AdapterDecision): Decision {
  if (decision.kind !== "deny") return decision;
  switch (decision.code) {
    case "mcp_server_denied":
    case "mcp_server_unapproved":
      return { kind: "deny", code: "policy_forbid", reason: decision.reason, ruleId: decision.ruleId };
    case "login_rejected":
    case "org_mode_unknown":
    case "policy_bundle_unusable":
      return { kind: "deny", code: "backend_unreachable", reason: `${decision.code}: ${decision.reason}`, ruleId: null };
    default:
      return { kind: "deny", code: decision.code, reason: decision.reason, ruleId: decision.ruleId };
  }
}

function surfaceOf(runtime: IntentRuntime, conversationId: string): Surface {
  for (const c of runtime.registry.all()) if (c.ref.conversationId === conversationId) return c.ref.surface;
  return "unknown";
}
