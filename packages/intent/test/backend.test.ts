import { describe, expect, test } from "bun:test";
import { createSdkBackend, logLegacyBackend, parseRetryAfter, toSdkPlan, type ClientIdentity } from "../src/backend.ts";
import { AGENT_ID, CLIENT_ID } from "../src/types.ts";
import contract from "./fixtures/plan-capture-v1.json";
import { planRequest, requestBody } from "../src/plan-request.ts";
import { LOGIN, silentLog } from "./helpers.ts";
import * as sdk from "@armoriq/sdk-dev";
import { compileMintPolicy } from "../src/mint-policy.ts";

describe("mint payload pieces", () => {
  test("plan steps carry mcp antigravity and the registered source", () => {
    expect(
      toSdkPlan({ goal: "g", steps: [{ action: "Bash", tool: "run_command", params: { CommandLine: "ls" } }] }),
    ).toEqual({
      goal: "g",
      steps: [{ action: "run_command", tool: "run_command", mcp: "antigravity", description: "Bash", metadata: { inputs: { CommandLine: "ls" } } }],
      metadata: { goal: "g", source: "antigravity-registered" },
    });
  });

  test("the local policy compiles as ArmorClaude sends it", () => {
    const statements = [
      { id: "a", effect: "forbid" as const, action: { eq: "run_command" } },
      { id: "b", effect: "permit" as const, action: { in: ["view_file", "write_to_file"] } },
      { id: "c", effect: "require_approval" as const, action: {} },
    ];
    expect(compileMintPolicy({ schemaVersion: "armor.policy.v1", statements }, "ph")).toEqual({
      allow: ["*"],
      deny: [],
      allowed_tools: ["view_file", "write_to_file", "*"],
      denied_tools: ["run_command"],
      statements,
      metadata: { source: "armorantigravity", schemaVersion: "armor.policy.v1", policyHash: "ph" },
    });
  });
});

function transport(responses: { status?: number; error?: string; stall?: boolean; headers?: Record<string, string>; data?: unknown }[], client: ClientIdentity = { product: `${CLIENT_ID}-dev`, version: "0.0.0" }) {
  const calls: { body: Record<string, unknown>; headers: Record<string, string>; timeout: number }[] = [];
  const loadSdk = async () => ({ ...sdk, ArmorIQClient: class extends sdk.ArmorIQClient {
    constructor(options: ConstructorParameters<typeof sdk.ArmorIQClient>[0]) {
      super(options);
      this._sessionInternals().httpClient.defaults.adapter = async (config: { data: string; headers: { toJSON(): unknown }; timeout?: number }) => {
        calls.push({ body: JSON.parse(config.data), headers: config.headers.toJSON() as Record<string, string>, timeout: config.timeout! });
        const next = responses.shift()!;
        if (next.stall) return new Promise<never>(() => {});
        if (next.error) throw new Error(next.error);
        return { status: next.status ?? 200, statusText: "test", headers: next.headers ?? {}, config, data: next.data ?? { success: true, plan_id: "plan-1", kind: "new", jwt_token: "jwt", token: { expires_at: Date.now() / 1000 + 180 } } };
      };
    }
  } });
  return { calls, backend: createSdkBackend({ client, loadSdk }) };
}

const draft = { hash: "hash", goal: "g", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "prompt" };
const descriptor = () => planRequest({ kind: "new", promptId: "prompt", planHash: "hash" }, requestBody(LOGIN, draft, "root", 180));

describe("durable token transport", () => {
  for (const product of [CLIENT_ID, `${CLIENT_ID}-dev`]) {
    test(`${product} sends the identity defined by the contract fixture`, async () => {
      const identity = contract.identity.find(entry => entry.plugin === "ArmorAntigravity")!;
      const t = transport([{}], { product, version: "0.0.0" });
      expect((await t.backend.mint(LOGIN, draft, "root", descriptor())).ok).toBe(true);
      expect(AGENT_ID).toBe(identity.agentId);
      expect(t.calls[0]?.body.agent_id).toBe(identity.agentId);
      expect(t.calls[0]?.body.context_id).toBe("root");
      const clientPattern = identity.clientHeaderPattern.replace("[-dev]", "(?:-dev)?").replace("<v>", "0\\.0\\.0");
      expect(t.calls[0]?.headers["X-ArmorIQ-Client"]).toMatch(new RegExp(`^${clientPattern}$`));
    });
  }

  test("response expiry uses the request clock", async () => {
    const t = transport([{ data: { success: true, plan_id: "plan-1", kind: "new", jwt_token: "jwt", token: { expires_at: 180 } } }]);
    expect(await t.backend.mint(LOGIN, draft, "root", descriptor(), { now: () => 0 })).toMatchObject({ ok: true, value: { token: { expiresAt: 180_000 } } });
  });
  test("reports one failed logical request after both attempts, with a provisional deadline", async () => {
    const t = transport([{ status: 503 }, { status: 503 }]);
    const failures: unknown[] = [];
    await t.backend.mint(LOGIN, draft, "root", descriptor(), { now: () => 0, onFailure: (reason, notBefore) => { failures.push([reason, notBefore]); } });
    expect(t.calls).toHaveLength(2);
    expect(failures).toEqual([["server_error", 40_000]]);
  });
  test.each([
    [{ status: 429, headers: { "retry-after": "41" } }, "rate_limited"],
    [{ status: 409, data: { error: "request_in_progress" }, headers: { "retry-after": "41" } }, "request_in_progress"],
    [{ status: 422 }, "rejected"],
    [{ status: 401 }, "rejected"],
    [{ error: "network error" }, "network"],
  ] as const)("classifies the terminal request result %p as %s", async (reply, expected) => {
    const t = transport([{ ...reply }, { ...reply }]);
    const failures: string[] = [];
    await t.backend.mint(LOGIN, draft, "root", descriptor(), { onFailure: reason => { failures.push(reason); } });
    expect(failures).toEqual([expected]);
  });
  test("a recovered request cancels its provisional failure", async () => {
    const t = transport([{ status: 503 }, {}]);
    const failures: string[] = [];
    let successes = 0;
    await t.backend.mint(LOGIN, draft, "root", descriptor(), { onFailure: reason => { failures.push(reason); }, onSuccess: async () => { successes++; } });
    expect(failures).toEqual([]);
    expect(successes).toBe(1);
  });
  test.each(["new", "refresh"] as const)("a saved %s request gets a fresh retry budget after its logical deadline", async kind => {
    const t = transport([{ status: 503 }, { status: 503 }, { data: { success: true, plan_id: "plan-1", kind, jwt_token: "jwt", token: { expires_at: Date.now() / 1000 + 180 } } }]);
    let clock = 0;
    const base = kind === "new" ? descriptor() : planRequest({ kind: "refresh", promptId: "prompt", countedPlanId: "plan-1", tokenExpiresAt: "2026-11-19T00:00:00Z" }, requestBody(LOGIN, draft, "root", 180));
    const request = { ...base, deadlineAt: 40_000 };
    const failures: unknown[] = [];
    await t.backend.mint(LOGIN, draft, "root", request, { now: () => clock, sleep: async ms => { clock += ms; }, onFailure: (reason, notBefore) => { failures.push([reason, notBefore]); } });
    clock = 60_000;
    expect((await t.backend.mint(LOGIN, draft, "root", request, { now: () => clock })).ok).toBe(true);
    expect(t.calls.map(c => c.headers["Idempotency-Key"])).toEqual([request.key, request.key, request.key]);
    expect(t.calls.map(c => c.timeout)).toEqual([5000, 5000, 5000]);
    expect(failures).toEqual([["server_error", 40_000]]);
  });
  test.each(["success", "failure"])("health storage errors cannot replace a mint %s", async outcome => {
    const t = transport(outcome === "success" ? [{}] : [{ status: 422 }]);
    const broken = async () => { throw new Error("health storage unavailable"); };
    const result = await t.backend.mint(LOGIN, draft, "root", descriptor(), { onSuccess: broken, onFailure: broken });
    expect(result).toMatchObject(outcome === "success" ? { ok: true } : { ok: false, status: 422 });
  });
  test("a local SDK exception is not reported as backend unreachable", async () => {
    const backend = createSdkBackend({ client: { product: CLIENT_ID, version: "test" }, loadSdk: async () => { throw new Error("SDK initialization failed"); } });
    const failures: string[] = [];
    await backend.mint(LOGIN, draft, "root", descriptor(), { onFailure: reason => { failures.push(reason); } });
    expect(failures).toEqual(["rejected"]);
  });
  test("timeouts retry the saved request and leave its outcome unconfirmed", async () => {
    const t = transport([{ stall: true }, { stall: true }]);
    const request = descriptor();
    expect(await t.backend.mint(LOGIN, draft, "root", request)).toMatchObject({ ok: false, retryable: true, reason: "timed out after 5000 ms" });
    expect(t.calls).toHaveLength(2);
    expect(t.calls.map(call => call.headers["Idempotency-Key"])).toEqual([request.key, request.key]);
  }, 15_000);
  test("Retry After supports both wire forms", () => {
    const now = Date.UTC(2030, 0, 1);
    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000);
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
  });
  test("the compatibility warning is logged once", () => {
    let warnings = 0;
    const log = { ...silentLog, warn() { warnings++; } };
    logLegacyBackend(log);
    logLegacyBackend(log);
    expect(warnings).toBe(1);
  });
  test("cancellation prevents the retry from sending after a generation changes", async () => {
    const t = transport([{ status: 503, headers: { "retry-after": "1" } }]);
    let cancelled = false;
    expect(await t.backend.mint(LOGIN, draft, "root", descriptor(), { cancelled: () => cancelled, sleep: async () => { cancelled = true; } })).toMatchObject({ ok: false, retryable: false });
    expect(t.calls).toHaveLength(1);
  });
  test("the remaining logical deadline bounds the next attempt timeout", async () => {
    const t = transport([{ status: 503, headers: { "retry-after": "37" } }, {}]);
    let clock = 0;
    expect((await t.backend.mint(LOGIN, draft, "root", descriptor(), { now: () => clock, sleep: async ms => { clock += ms; } })).ok).toBe(true);
    expect(t.calls.map(c => c.timeout)).toEqual([5000, 3000]);
  });
  test.each([
    { status: 429, headers: { "retry-after": "2" } },
    { status: 503 },
    { status: 409, data: { error: "request_in_progress" }, headers: { "retry-after": "2" } },
    { error: "network error" },
  ])("retries %p with the same body, headers and key", async first => {
    const t = transport([first, {}]);
    const request = descriptor();
    const delays: number[] = [];
    const result = await t.backend.mint(LOGIN, draft, "root", request, { sleep: async ms => { delays.push(ms); } });
    expect(result.ok).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.body).toEqual(request.body);
    expect(t.calls[1]?.body).toEqual(request.body);
    for (const call of t.calls) {
      for (const [key, value] of Object.entries(request.headers)) expect(call.headers[key]).toBe(value);
      expect(call.headers["X-ArmorIQ-Client"]).toBe("armorantigravity-dev/0.0.0");
      expect(call.timeout).toBeLessThanOrEqual(5000);
    }
    if (first.headers) expect(delays).toEqual([2000]);
  });
  test("other conflicts are confirmed failures without retry", async () => {
    const t = transport([{ status: 409, data: { error: "other_conflict" } }]);
    const result = await t.backend.mint(LOGIN, draft, "root", descriptor());
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(t.calls).toHaveLength(1);
  });
  test("Retry After beyond the logical deadline starts no further attempt", async () => {
    const t = transport([{ status: 429, headers: { "retry-after": "41" } }]);
    let slept = false;
    const result = await t.backend.mint(LOGIN, draft, "root", descriptor(), { sleep: async () => { slept = true; } });
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(t.calls).toHaveLength(1);
    expect(slept).toBe(false);
  });
  test("does not install an SDK fabricated expiry when the response omits it", async () => {
    const t = transport([{ data: { success: true, plan_id: "plan-1", kind: "new", jwt_token: "jwt", token: {} } }]);
    expect(await t.backend.mint(LOGIN, draft, "root", descriptor())).toMatchObject({ ok: false, unconfirmed: true });
  });
});
