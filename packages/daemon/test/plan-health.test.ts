import { afterEach, expect, test } from "bun:test";
import * as sdk from "@armoriq/sdk-dev";
import { createHealthPump, type Uploads } from "@armorantigravity/evidence";
import { conversationKey, createOwnTools, createRegistry, createSdkBackend } from "@armorantigravity/intent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

test.each([false, true])("token requests reach the durable health stream, recovery=%p", async recovered => {
  const dir = mkdtempSync(join(tmpdir(), "agy-plan-health-"));
  const auth = { backend: "http://localhost:1", apiKey: "ak_test_plan_health", userId: "user", orgId: "org", email: "", deviceId: "device", deviceName: "test" };
  const quietLog = { info() {}, warn() {}, error() {} };
  const uploads: Uploads = { client: { product: "armorantigravity", version: "0.1.0" }, headers: { "X-ArmorIQ-Client": "armorantigravity/0.1.0" }, login: () => auth, report() {} };
  let now = Date.now();
  let fail = true;
  let attempts = 0;
  const delivered: unknown[] = [];
  const deps = { dataDir: dir, uploads, log: quietLog, clock: { now: () => now, random: () => 0 },
    post: async (_auth: unknown, _uploads: unknown, events: readonly unknown[]) => { delivered.push(...events); return { ok: true as const, rejected: [] }; },
  };
  let health = createHealthPump(deps);
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  const backend = createSdkBackend({ client: deps.uploads.client, loadSdk: async () => ({ ...sdk, ArmorIQClient: class extends sdk.ArmorIQClient {
    constructor(options: ConstructorParameters<typeof sdk.ArmorIQClient>[0]) {
      super(options);
      this._sessionInternals().httpClient.defaults.adapter = async (config: { data: string }) => {
        attempts++;
        return { status: fail ? 503 : 200, statusText: "test", headers: {}, config,
          data: fail ? {} : { success: true, plan_id: "plan-1", kind: "new", jwt_token: "jwt", token: { expires_at: Date.now() / 1000 + 180 } },
        };
      };
    }
  } }) });
  const ref = { surface: "cli" as const, conversationId: "health-request" };
  const key = conversationKey(ref);
  const file = join(dir, "intent-state.json");
  let registry = createRegistry(() => now, file);
  registry.syncAuth(auth, "enforce");
  registry.open(ref);
  registry.beginPrompt(key, 0);
  const tools = () => createOwnTools({ registry, backend, health, now: () => now, login: () => auth, mode: () => "enforce", log: quietLog,
    policy: () => ({ hash: "policy", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) }), audit() {},
  });
  const plan = { goal: "read a file", steps: [{ action: "view_file" }] };
  expect(await tools().handle(ref, "register_intent_plan", plan)).toContain("not confirmed");
  const descriptor = registry.get(key)!.pendingRequest!;
  expect(descriptor.deadlineAt).toBe(now + 40_000);
  expect(attempts).toBe(2);
  await health.kick();
  expect(delivered).toHaveLength(0);
  await health.stop();
  health = createHealthPump(deps);
  registry = createRegistry(() => now, file);
  registry.syncAuth(auth, "enforce");
  fail = !recovered;
  const result = await tools().handle(ref, "register_intent_plan", plan);
  expect(result).toContain(recovered ? "Intent registered" : "not confirmed");
  if (!recovered) expect(registry.get(key)!.pendingRequest).toEqual(descriptor);
  now = descriptor.deadlineAt!;
  await health.kick();
  expect(delivered).toEqual(recovered ? [] : [expect.objectContaining({ type: "plan_request_failed", queue: "health", count: 1, reason_code: "server_error" })]);
  expect(health.status().pending).toBe(0);
});
