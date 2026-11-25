import { afterEach, expect, test } from "bun:test";
import { mapToolCall } from "@armorantigravity/adapter";
import { createRunsPump, runCapability, type Uploads } from "@armorantigravity/evidence";
import { createIntentRuntime, withIntent, type IntentBackend, type Mode, type PolicyView } from "@armorantigravity/intent";
import type { Login } from "@armorantigravity/core";
import type { HookPayload } from "@armorantigravity/protocol";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contract from "../../evidence/test/fixtures/runs-v1.json";
import { armoriqPlugins } from "../src/armoriq.ts";
import type { Auth } from "../src/auth.ts";
import type { HookContext, PluginRegistration } from "../src/plugin.ts";
import { createSessionStore } from "../src/sessions.ts";
import { resolvePaths } from "../src/paths.ts";

const LOGIN = { backend: "http://localhost:1", apiKey: "test-runs", userId: "u" };
const silentLog = { info() {}, warn() {}, error() {} };
const permitAll: PolicyView = { hash: "policy", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const login = (backend: string, overrides: Partial<Login> = {}): Login => ({ ...LOGIN, backend, orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test", ...overrides });
const uploads = (current: () => Login | null): Uploads => ({ client: { product: "armorantigravity", version: "test" }, headers: {}, login: current, report() {} });
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "agy-runs-runtime-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function recordingBackend(options: { gate?: boolean } = {}) {
  const gates: (() => void)[] = [];
  let next = 0;
  const backend: IntentBackend = {
    async mint() {
      if (options.gate) await new Promise<void>(resolve => gates.push(resolve));
      return { ok: true, value: { planId: `plan-${++next}`, token: { status: "active", jwt: "jwt", expiresAt: Date.now() + 3_600_000, deniedTools: new Set<string>(), heldTools: new Set<string>() } } };
    },
    async reanchor() { return { ok: true, value: { trustId: "trust" } }; },
    async revoke() { return { ok: true, value: undefined }; },
    async delegate() { return { ok: true, value: { trustId: "trust", subtreeRoot: "root", inclusionProofLength: 1 } }; },
  };
  return { backend, release: () => gates.splice(0).forEach(resolve => resolve()) };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const ref = { surface: "cli" as const, conversationId: "root" };
const base = { conversationId: ref.conversationId, workspacePaths: [], transcriptPath: "", artifactDirectoryPath: "", modelName: "test" };
const prompt = (initialNumSteps = 0): HookPayload => ({ ...base, event: "PreInvocation", invocationNum: 0, initialNumSteps });
const stop: HookPayload = { ...base, event: "Stop", executionNum: 0, fullyIdle: true, terminationReason: "done", error: "" };
const tool = (name: string, stepIdx = 1, args: unknown = {}): Extract<HookPayload, { event: "PreToolUse" }> => ({ ...base, event: "PreToolUse", toolCall: { name, args }, stepIdx });
const plan = { goal: "work", steps: [{ action: "run_command" }] };

function setup(options: { mode?: Mode; backend?: IntentBackend; gate?: boolean; policy?: typeof permitAll } = {}) {
  const tmp = tempDir();
  const auth = login(LOGIN.backend, { apiKey: LOGIN.apiKey });
  const rec = recordingBackend({ gate: options.gate ?? false });
  const runs = createRunsPump({ dataDir: tmp.dir, uploads: uploads(() => auth), log: silentLog, enabled: true, post: async () => ({ ok: false, deferred: true }) });
  const rt = createIntentRuntime({ client: { product: "armorantigravity", version: "test" }, login: () => auth,
    mode: () => options.mode ?? "enforce", policy: () => options.policy ?? permitAll, mintPolicy: () => undefined,
    audit() {}, log: silentLog, backend: options.backend ?? rec.backend, runs, runToolName: call => mapToolCall(call).tool,
    stateFile: join(tmp.dir, "intent-state.json"),
  });
  cleanup.push(async () => { rec.release(); await rt.pump.stop(); await runs.stop(); tmp.cleanup(); });
  const observe = (payload: HookPayload) => rt.observe("cli", payload);
  const register = async (args: unknown = plan, name = "register_intent_plan", step = 100) => {
    const call = tool(`mcp_armoriq_${name}`, step, args);
    observe(call);
    await rt.ownToolDecision("cli", call);
    return rt.mcpOutcome(name as "register_intent_plan" | "trust_reanchor", args, 1000);
  };
  const reports = () => runs.outbox.readPending().map(p => p.row);
  return { rt, runs, rec, observe, register, reports, tmp };
}

test("Antigravity capability rules match the shared fixture before monitor bypass", () => {
  const rules = contract.capabilities.armorantigravity.rules;
  for (const name of ["read_file", "Read", "NotebookRead", "LS", "list", "Glob", "Grep", "WebSearch", "WebFetch", "search_web", "run_command", "invoke_subagent", "browser_open", "unknown", "mcp_other_policy_read", "mcp_armoriq_policy_read", "mcp_armoriq_trust_delegate"]) {
    const canonical = mapToolCall({ name, args: {} }).tool;
    const expected = rules.find(rule => rule.patterns.some(pattern => new RegExp(pattern).test(canonical)))!;
    expect(runCapability(canonical)).toEqual({ counted: expected.counted, gated: expected.gated });
  }
  expect(runCapability("policy_read", false)).toEqual({ counted: true, gated: true });
  expect(contract.adapterHooks.armorantigravity.sessionEnd).toEqual([]);
});

test("root hook lifecycle persists start immediately, deduplicates steps and closes at Stop", () => {
  const h = setup();
  h.observe(prompt());
  const id = h.rt.root(ref)!.promptId;
  expect(h.reports()).toEqual([expect.objectContaining({ run_id: id, report_seq: 1, tool_calls: 0 })]);
  h.observe(prompt());
  for (const [step, name] of [[1, "Read"], [2, "run_command"], [3, "mcp_armoriq_policy_read"], [4, "mcp_other_policy_read"], [5, "WebFetch"]] as const) {
    h.observe(tool(name, step)); h.observe(tool(name, step));
  }
  h.rt.registry.link({ surface: "cli", conversationId: "child" }, ref);
  h.observe({ ...tool("run_command", 8), conversationId: "child" });
  h.observe({ ...stop, conversationId: "child" });
  expect(h.reports()).toHaveLength(1);
  h.observe(stop); h.observe(stop);
  expect(h.reports()).toHaveLength(2);
  expect(h.reports()[1]).toMatchObject({ report_seq: 2, tool_calls: 4, gated_tool_calls: 3, end_reason: "stop", no_plan_reason: "not_registered" });
});

test("run write failures never replace a hook result or keep the previous prompt active", async () => {
  const fail = () => { throw new Error("runs write unavailable"); };
  const rt = createIntentRuntime({ client: { product: "armorantigravity", version: "test" }, login: () => null,
    mode: () => "monitor", policy: () => permitAll, mintPolicy: () => undefined, audit() {}, log: silentLog,
    backend: recordingBackend().backend,
    runs: { begin: fail, end: fail, attempt: fail, registration: fail, request: fail, reject: fail, kick: fail },
  });
  try {
    expect(() => rt.observe("cli", prompt())).not.toThrow();
    const old = rt.root(ref)?.promptId;
    expect(() => rt.observe("cli", tool("run_command"))).not.toThrow();
    expect(() => rt.observe("cli", stop)).not.toThrow();
    expect(() => rt.observe("cli", prompt(9))).not.toThrow();
    expect(rt.root(ref)?.promptId).not.toBe(old);
  } finally { await rt.pump.stop(); }
});

test("a Stop frame captured before the next prompt does not close its run", async () => {
  const h = setup();
  h.observe(prompt());
  const previous = h.rt.root(ref)!.promptId;
  h.observe(prompt(9));
  const current = h.rt.root(ref)!;
  const capturedAt = current.promptOpenSince! - 1;
  await withIntent(h.rt, () => null)({ payload: stop, session: { surface: "cli" }, receivedAt: capturedAt });
  await withIntent(h.rt, () => null)({ payload: stop, session: { surface: "cli" }, receivedAt: capturedAt });
  expect(h.reports().filter(r => r.report_seq === 2).map(r => r.run_id)).toEqual([previous!]);
});

test("captured child invocations and parent wake ups never create runs", () => {
  const h = setup();
  const fixture = join(import.meta.dir, "../../intent/test/fixtures/spike");
  for (const line of readFileSync(join(fixture, "events.jsonl"), "utf8").trim().split("\n")) {
    const event = JSON.parse(line.replaceAll("<HOME>", join(fixture, "home")));
    h.observe({ ...event.payload, event: event.event });
  }
  expect(h.reports().filter(r => r.report_seq === 1)).toHaveLength(1);
});

test("next prompt closes the previous run and late registration belongs only to that run", async () => {
  const h = setup({ gate: true });
  h.observe(prompt());
  const old = h.rt.root(ref)!.promptId;
  const pending = h.register();
  h.observe(prompt(9));
  const next = h.rt.root(ref)!.promptId;
  expect(h.reports().filter(r => r.report_seq === 2)).toEqual([]);
  h.rec.release();
  await pending;
  h.observe(stop);
  const finals = h.reports().filter(r => r.report_seq === 2);
  expect(finals.find(r => r.run_id === old)).toMatchObject({ end_reason: "next_prompt", plan_ids: ["plan-1"] });
  expect(finals.find(r => r.run_id === next)).toMatchObject({ end_reason: "stop", plan_ids: [], no_plan_reason: "no_tool_use" });
  expect(h.rt.root(ref)?.plan).toBeNull();
});

test.each(["no_tool_use", "read_only", "not_registered", "monitor_mode", "backend_unreachable", "request_failed", "plan_rejected"] as const)("reports reason %s", async reason => {
  const rec = recordingBackend();
  if (reason === "backend_unreachable" || reason === "request_failed") rec.backend.mint = async (_auth, _draft, _context, _request, options) => {
    await options?.onFailure?.(reason === "backend_unreachable" ? "network" : "rejected");
    return { ok: false, retryable: reason === "backend_unreachable", reason: "test refusal" };
  };
  const h = setup({ backend: rec.backend, mode: reason === "monitor_mode" ? "monitor" : "enforce" });
  h.observe(prompt());
  if (reason !== "no_tool_use") h.observe(tool(reason === "read_only" ? "read_file" : "run_command"));
  if (reason === "backend_unreachable" || reason === "request_failed") await h.register();
  if (reason === "plan_rejected") await h.register({ goal: "bad", steps: [] });
  h.observe(stop);
  expect(h.reports().at(-1)).toMatchObject({ report_seq: 2, no_plan_reason: reason });
});

test("trust_reanchor records a second logical request and confirmed plans suppress reasons", async () => {
  const h = setup();
  h.observe(prompt());
  await h.register();
  await h.register({ updatedPlan: { ...plan, goal: "changed" }, reason: "changed work" }, "trust_reanchor", 101);
  h.observe(stop);
  expect(h.reports().at(-1)).toMatchObject({ plan_ids: ["plan-1", "plan-2"] });
  expect(h.reports().at(-1)?.no_plan_reason).toBeUndefined();
});

test("forced monitor reports authenticated attempts with gated counters", () => {
  const h = setup({ mode: "monitor" });
  h.observe(prompt());
  h.observe(tool("run_command"));
  h.observe(stop);
  expect(h.reports()).toHaveLength(2);
  expect(h.reports()[1]).toMatchObject({ tool_calls: 1, gated_tool_calls: 1, no_plan_reason: "monitor_mode" });
});

test("a signed-in Monitor run reports the plan it registered", async () => {
  const h = setup({ mode: "monitor" });
  h.observe(prompt());
  expect(await h.register()).toStartWith("Intent registered: plan plan-1 (new)");
  h.observe(tool("run_command"));
  h.observe(stop);
  expect(h.reports().at(-1)).toMatchObject({ report_seq: 2, plan_ids: ["plan-1"], tool_calls: 1 });
  expect(h.reports().at(-1)?.no_plan_reason).toBeUndefined();
});

// regression: #0013
test.each([
  ["enforce", null, "no_tool_use", 0, 0],
  ["enforce", "read_file", "read_only", 1, 0],
  ["enforce", "run_command", "not_registered", 1, 1],
  ["monitor", "run_command", "not_registered", 1, 1],
] as const)("%s prompt with %s uses the actual mode when intent is optional", (mode, name, reason, toolCalls, gatedToolCalls) => {
  const options = { mode: mode as Mode, policy: { ...permitAll, intentRequired: false } };
  const h = setup(options);
  h.observe(prompt());
  options.mode = "enforce";
  if (name) h.observe(tool(name));
  h.observe(stop);
  expect(h.reports().at(-1)).toMatchObject({ report_seq: 2, no_plan_reason: reason, tool_calls: toolCalls, gated_tool_calls: gatedToolCalls });
});

test("session cleanup emits no session_end report; the next daemon recovers the run", async () => {
  const h = setup();
  h.observe(prompt());
  h.observe(tool("run_command"));
  h.rt.conversationEnded(ref);
  expect(h.reports()).toHaveLength(1);
  await h.runs.stop();
  const recovered = createRunsPump({ dataDir: h.tmp.dir, uploads: uploads(() => null), log: silentLog, enabled: true, clock: { now: () => Date.now() + 31 * 60_000, random: () => 0 } });
  await recovered.kick();
  expect(recovered.outbox.readPending().find(r => r.row.report_seq === 2)?.row).toMatchObject({ end_reason: "recovered", tool_calls: 1 });
  await recovered.stop();
});

test.each([[undefined, true], ["true", true], ["false", false]] as const)("daemon wiring reports authenticated forced monitor runs unless the switch is exactly false, ARMORIQ_RUN_REPORTING_ENABLED=%p", async (value, enabled) => {
  const tmp = tempDir();
  const previous = process.env.ARMORIQ_RUN_REPORTING_ENABLED;
  const fetch = globalThis.fetch;
  if (value === undefined) delete process.env.ARMORIQ_RUN_REPORTING_ENABLED;
  else process.env.ARMORIQ_RUN_REPORTING_ENABLED = value;
  const paths = resolvePaths({ ARMORIQ_HOME: tmp.dir });
  const sessions = createSessionStore(paths.sessionsDir);
  let current: Login | null = null;
  const auth: Auth = {
    client: { product: "armorantigravity", version: "test" }, headers: { "X-ArmorIQ-Client": "armorantigravity/test" },
    state: () => current ? { kind: "active", login: current } : { kind: "logged_out" }, mode: () => "monitor",
    orgMode: { current: () => ({ mode: "shadow", notices: false }), set() {}, monitoring: () => false, onChange: () => () => {} }, orgMonitor: () => false,
    uploadLogin: () => current, authenticationLogin: () => current, authenticationSucceeded() {}, onAuthenticated: () => () => {}, reportStatus() {}, onChange: () => () => {}, stop() {},
  };
  const sent: { run_id: string; report_seq: number; no_plan_reason?: string; gated_tool_calls: number }[] = [];
  globalThis.fetch = (async (url, options) => {
    expect(String(url)).toBe(`${LOGIN.backend}/iap/runs/batch`);
    expect(new Headers(options?.headers).get("X-API-Key")).toBe(LOGIN.apiKey);
    expect(new Headers(options?.headers).get("X-ArmorIQ-Client")).toBe("armorantigravity/test");
    const { reports } = JSON.parse(String(options?.body));
    sent.push(...reports);
    return Response.json({ results: reports.map((r: { run_id: string; report_seq: number }) => ({ run_id: r.run_id, report_seq: r.report_seq, outcome: "accepted" })) });
  }) as typeof globalThis.fetch;
  const registrations: PluginRegistration[] = [];
  try {
    for (const plugin of armoriqPlugins()) registrations.push(await plugin.setup({ paths, sessions, auth, log: silentLog }));
    current = login(LOGIN.backend);
    const session = sessions.open("cli", base.conversationId, Date.now()).session;
    const guard = registrations.find(r => r.decide)!;
    const decide = (payload: HookPayload) => guard.decide!({ payload, event: payload.event, session, mode: "monitor", auth: auth.state(), id: crypto.randomUUID(), receivedAt: Date.now() } satisfies HookContext);
    await decide(prompt());
    for (let i = 0; enabled && !sent.length && i < 100; i++) await Bun.sleep(1);
    if (enabled) expect(sent).toEqual([expect.objectContaining({ report_seq: 1 })]);
    else expect(sent).toEqual([]);
    await decide(tool("run_command"));
    await decide(stop);
    for (const r of registrations) for (const p of r.pumps ?? []) p.kick();
    for (let i = 0; enabled && sent.length < 2 && i < 100; i++) await Bun.sleep(1);
    expect(sent).toHaveLength(enabled ? 2 : 0);
    if (enabled) expect(sent[1]).toMatchObject({ run_id: sent[0]!.run_id, report_seq: 2, no_plan_reason: "monitor_mode", gated_tool_calls: 1 });
  } finally {
    await Promise.all(registrations.flatMap(r => r.pumps ?? []).map(p => p.stop()));
    await sessions.flush();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.ARMORIQ_RUN_REPORTING_ENABLED;
    else process.env.ARMORIQ_RUN_REPORTING_ENABLED = previous;
    tmp.cleanup();
  }
});
