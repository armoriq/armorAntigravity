import { describe, expect, test } from "bun:test";
import { createSdkBackend, logLegacyBackend, parseRetryAfter, toSdkPlan } from "../src/backend.ts";
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

function transport(responses: { status?: number; error?: string; stall?: boolean; headers?: Record<string, string>; data?: unknown }[]) {
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
  return { calls, backend: createSdkBackend({ client: { product: "armorantigravity-dev", version: "0.0.0" }, loadSdk }) };
}

const draft = { hash: "hash", goal: "g", steps: [{ action: "run_command", tool: "run_command" }], revision: 1, registeredInMessage: "prompt" };
const descriptor = () => planRequest({ kind: "new", promptId: "prompt", planHash: "hash" }, requestBody(LOGIN, draft, "root", 180));

describe("durable token transport", () => {
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
