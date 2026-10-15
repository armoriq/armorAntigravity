// Drives the intent, token and drift flows against a real ArmorIQ backend and prints every request on the wire.
// Usage: HOME=<sandbox with .armoriq/credentials.json> bun packages/intent/e2e/live.ts <profile> <conversationId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkIntent,
  compileMintPolicy,
  conversationKey,
  createOwnTools,
  createRegistry,
  createSdkBackend,
  createTokenPump,
  denyReason,
  intentAuditRow,
  policySpanResult,
  type AuditRow,
  type Login,
  type PolicyView,
} from "../src/index.ts";

const [profileName, conversationId] = process.argv.slice(2);
if (!profileName || !conversationId) throw new Error("usage: live.ts <profile> <conversationId>");

const creds: unknown = JSON.parse(readFileSync(join(homedir(), ".armoriq", "credentials.json"), "utf8"));
const profile = typeof creds === "object" && creds !== null && "profiles" in creds && typeof creds.profiles === "object" && creds.profiles !== null && profileName in creds.profiles
  ? Object.entries(creds.profiles).find(([k]) => k === profileName)?.[1]
  : undefined;
const field = (k: string): string => {
  const v: unknown = typeof profile === "object" && profile !== null ? Object.entries(profile).find(([key]) => key === k)?.[1] : undefined;
  if (typeof v !== "string" || !v) throw new Error(`profile ${profileName} has no ${k}`);
  return v;
};
const upstream = field("backend");

const wire: { method: string; path: string; headers: Record<string, string>; body: unknown; status: number }[] = [];
const redact = (k: string, v: string) => (/^(x-api-key|authorization)$/i.test(k) ? `<${v.length} chars, present>` : v);
const proxy = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.arrayBuffer();
    const res = await fetch(upstream + url.pathname + url.search, { method: req.method, headers: req.headers, body: raw.byteLength ? raw : null });
    const out = await res.arrayBuffer();
    const headers = Object.fromEntries([...req.headers].filter(([k]) => /^(x-api-key|authorization|x-armoriq-client|idempotency-key|content-type)$/i.test(k)).map(([k, v]) => [k, redact(k, v)]));
    const isJson = (req.headers.get("content-type") ?? "").includes("json");
    const body: unknown = !raw.byteLength ? null : isJson ? JSON.parse(new TextDecoder().decode(raw)) : `<${raw.byteLength} bytes ${req.headers.get("content-type")}>`;
    wire.push({ method: req.method, path: url.pathname, headers, body, status: res.status });
    return new Response(out, { status: res.status, headers: res.headers });
  },
});

const login: Login = { backend: `http://localhost:${proxy.port}`, apiKey: field("apiKey"), userId: field("userId") };
const statements = [
  { id: "no-curl-pipe", effect: "forbid" as const, action: { eq: "run_command" }, principal: { type: "agent", id: "*" } },
  { id: "allow-all", effect: "permit" as const, action: { eq: "*" }, principal: { type: "agent", id: "*" } },
];
const policy: PolicyView = { hash: "e2e-policy", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const audit: AuditRow[] = [];
const log = { info: console.log, warn: console.warn, error: console.error };
const registry = createRegistry();
const backend = createSdkBackend({
  client: { product: "armorantigravity", version: "0.0.0-dev" },
  mintPolicy: () => compileMintPolicy({ schemaVersion: "armor.policy.v1", statements }, policy.hash),
});
const tools = createOwnTools({ registry, backend, login: () => login, mode: () => "enforce", policy: () => policy, audit: (r) => audit.push(r), log });
const pump = createTokenPump({ registry, backend, login: () => login, log });

const ref = { surface: "cli" as const, conversationId };
const key = conversationKey(ref);
const show = (label: string, value: unknown) => console.log(`\n=== ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

show("register_intent_plan", await tools.handle(ref, "register_intent_plan", { goal: "Run the test suite", steps: [{ action: "run_command", description: "run tests", metadata: { inputs: { CommandLine: "bun test" } } }] }));
show("MCP server outcome for the same call", await tools.outcome("register_intent_plan", { goal: "Run the test suite", steps: [{ action: "run_command", description: "run tests", metadata: { inputs: { CommandLine: "bun test" } } }] }, 100));

const args = { TargetFile: "/repo/src/secrets.ts", CodeContent: "export const x = 1;" };
const verdict = checkIntent({ root: registry.root(key), tool: "write_to_file", args, readOnly: false, now: Date.now() });
show("drift verdict", verdict);
if (verdict.kind !== "deny") throw new Error("expected intent_drift");
show("hook reason", denyReason(verdict, { plan: registry.root(key)?.plan ?? null, tool: "write_to_file", args }));
const root = registry.root(key)!;
audit.push(intentAuditRow({ verdict, conversation: root, root, tool: "write_to_file", input: args, userId: login.userId, at: Date.now() }));
const span = policySpanResult(verdict);
show("policy span result", span);
const sdk = await import("@armoriq/sdk-dev");
const telemetry = new sdk.ArmorIQTelemetryRuntime({
  backendEndpoint: login.backend,
  apiKey: login.apiKey,
  client: { product: "armorantigravity", version: "0.0.0-dev" },
  sdkVersion: sdk.VERSION,
  options: { serviceName: "armorantigravity" },
});
const turn = new sdk.OtelSession(telemetry, { sessionId: conversationId, userId: login.userId });
await turn.refreshPolicy();
await turn.beginRoot({ input: "e2e drift turn" });
await turn.recordPolicy({ toolName: "write_to_file", toolCallId: "e2e-drift-1", arguments: args }, span, { endTime: new Date() });
await turn.close({ status: "ok", endTime: new Date() });
await telemetry.forceFlush();
await telemetry.close();

show("revision", await tools.handle(ref, "register_intent_plan", { goal: "Run tests and fix a file", steps: [{ action: "run_command" }, { action: "write_to_file" }], reason: "the test needs a fixture file" }));
await tools.settled();
show("trust_delegate", await tools.handle(ref, "trust_delegate", { delegatePublicKey: "ed25519:e2e-child", subtreePath: "/steps/[0]", targetAgent: "e2e-child" }));

const auditRes = await fetch(`${login.backend}/iap/audit/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.apiKey}`, "X-API-Key": login.apiKey, "X-ArmorIQ-Client": "armorantigravity/0.0.0-dev" },
  body: JSON.stringify({ rows: audit }),
});
show(`audit batch -> ${auditRes.status}`, await auditRes.text());

pump.noteStop(key);
await pump.stop();

show("wire", wire);
proxy.stop(true);
