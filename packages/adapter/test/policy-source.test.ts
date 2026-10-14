import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAccess } from "../src/backend-http.ts";
import type { CoreToolCall, SessionID } from "../src/core-contract.ts";
import { createPolicySource, type PolicySource } from "../src/policy-source.ts";
import { stubBackend } from "./support/backend.ts";
import { DEFAULT_POLICY_SOURCE } from "@armorantigravity/core";
import { compileAntigravityPolicy } from "../src/product.ts";
import { memoryLog } from "./support/log.ts";

const call = (tool: string): CoreToolCall => ({ sessionId: "c0ffee00" as SessionID, callId: "1", tool, args: {} });

const forbid = (id: string, tool: string) => ({
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "current", description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements: [{ id, effect: "forbid", principal: { type: "agent", id: "claude-code" }, action: { type: "tool", eq: tool }, resource: { type: "workspace", scope: "current" }, conditions: [] }],
});

// conmap-auto ArmorPolicyService.getActiveForOrg
const active = (version: number, policy: unknown) => Response.json({ version, policy, updatedBy: "dashboard", publishedAt: policy ? "2026-10-12T10:00:00.000Z" : null });

let dir = "";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function source(opts: { access?: () => BackendAccess | null; refreshMs?: number; file?: unknown } = {}): { src: PolicySource; path: string; log: ReturnType<typeof memoryLog> } {
  dir = mkdtempSync(join(tmpdir(), "agd-policy-"));
  const path = join(dir, "policy.json");
  if (opts.file !== undefined) writeFileSync(path, typeof opts.file === "string" ? opts.file : JSON.stringify(opts.file));
  const log = memoryLog();
  const src = createPolicySource({
    path,
    compile: compileAntigravityPolicy,
    defaultSource: DEFAULT_POLICY_SOURCE,
    access: opts.access ?? (() => null),
    log,
    pollMs: 10,
    refreshMs: opts.refreshMs ?? 60_000,
  });
  cleanups.push(() => src.stop());
  return { src, path, log };
}

const until = async (check: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("local policy file", () => {
  test("missing file uses the default allow-all policy", () => {
    const { src } = source();
    expect(src.current().origin).toBe("default");
    expect(src.current().policy.evaluate(call("run_command")).effect).toBe("permit");
  });

  test("a valid file is enforced and an edit is picked up without a restart", async () => {
    const { src, path } = source({ file: forbid("no-shell", "run_command") });
    expect(src.current().origin).toBe("file");
    expect(src.current().policy.evaluate(call("run_command"))).toMatchObject({ effect: "forbid", ruleId: "no-shell" });
    writeFileSync(path, JSON.stringify(forbid("no-writes", "write_to_file")));
    await until(() => src.current().policy.evaluate(call("write_to_file")).effect === "forbid");
    expect(src.current().policy.evaluate(call("run_command")).effect).toBe("permit");
  });

  test("a file that never compiled fails closed", () => {
    const { src, log } = source({ file: "{ not json" });
    expect(src.current().origin).toBe("fail_closed");
    expect(src.current().policy.evaluate(call("view_file")).effect).toBe("forbid");
    expect(log.entries.some((e) => e.level === "error")).toBe(true);
  });

  test("a bad edit keeps the last good policy", async () => {
    const { src, path, log } = source({ file: forbid("no-shell", "run_command") });
    writeFileSync(path, JSON.stringify({ schemaVersion: "armor.policy.v2" }));
    await until(() => log.entries.some((e) => e.message.startsWith("policy change rejected")));
    expect(src.current().policy.evaluate(call("run_command")).ruleId).toBe("no-shell");
  });

  test("deleting the file falls back to the default", async () => {
    const { src, path } = source({ file: forbid("no-shell", "run_command") });
    unlinkSync(path);
    await until(() => src.current().origin === "default");
  });
});

describe("org policy from GET /policies/profiles/active", () => {
  test("a confirmed org policy wins over the local file and is pulled with the API key and client header", async () => {
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(3, forbid("org-no-shell", "run_command")) });
    cleanups.push(backend.stop);
    const { src } = source({ file: forbid("local-no-writes", "write_to_file"), access: () => ({ login: backend.login, client: "armorantigravity/0.1.0" }) });

    expect(await src.refresh()).toMatchObject({ kind: "applied", version: 3 });
    expect(src.current()).toMatchObject({ origin: "backend", backendVersion: 3 });
    expect(src.current().policy.evaluate(call("run_command")).ruleId).toBe("org-no-shell");
    expect(src.current().policy.evaluate(call("write_to_file")).effect).toBe("permit");

    const req = backend.seen[0];
    expect(req?.method).toBe("GET");
    expect(req?.headers.get("x-api-key")).toBe("ak_test_0123456789");
    expect(req?.headers.get("authorization")).toBe("Bearer ak_test_0123456789");
    expect(req?.headers.get("x-armoriq-client")).toBe("armorantigravity/0.1.0");
  });

  test("an org with no confirmed policy (policy:null) keeps the local policy", async () => {
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(0, null) });
    cleanups.push(backend.stop);
    const { src } = source({ file: forbid("local", "write_to_file"), access: () => ({ login: backend.login, client: "c" }) });
    expect(await src.refresh()).toEqual({ kind: "no_backend_policy" });
    expect(src.current().origin).toBe("file");
  });

  test("an admin unpublishing the policy drops it on the next refresh", async () => {
    let policy: unknown = forbid("org", "run_command");
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(policy ? 1 : 0, policy) });
    cleanups.push(backend.stop);
    const { src } = source({ access: () => ({ login: backend.login, client: "c" }) });
    await src.refresh();
    expect(src.current().origin).toBe("backend");
    policy = null;
    await src.refresh();
    expect(src.current().origin).toBe("default");
  });

  test.each([
    ["a 500", () => Response.json({ message: "boom" }, { status: 500 })],
    ["a 401", () => Response.json({ message: "Invalid API key" }, { status: 401 })],
    ["an invalid org policy", () => active(4, { schemaVersion: "armor.policy.v9" })],
  ])("%s keeps the org policy already enforced", async (_label, failing) => {
    let fail = false;
    const backend = stubBackend({ "GET /policies/profiles/active": () => (fail ? failing() : active(2, forbid("org", "run_command"))) });
    cleanups.push(backend.stop);
    const { src } = source({ access: () => ({ login: backend.login, client: "c" }) });
    await src.refresh();
    fail = true;
    expect((await src.refresh()).kind).toBe("failed");
    expect(src.current()).toMatchObject({ origin: "backend", backendVersion: 2 });
  });

  test("an unreachable backend keeps the local policy", async () => {
    const { src } = source({ file: forbid("local", "write_to_file"), access: () => ({ login: { backend: "http://127.0.0.1:1", apiKey: "k", userId: "", orgId: "", email: "", deviceId: "", deviceName: "" }, client: "c" }) });
    expect((await src.refresh()).kind).toBe("failed");
    expect(src.current().origin).toBe("file");
  });

  test("logging out drops the org policy", async () => {
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(1, forbid("org", "run_command")) });
    cleanups.push(backend.stop);
    let loggedIn = true;
    const { src } = source({ access: () => (loggedIn ? { login: backend.login, client: "c" } : null) });
    await src.refresh();
    loggedIn = false;
    expect(await src.refresh()).toEqual({ kind: "skipped", reason: "not logged in" });
    expect(src.current().origin).toBe("default");
  });

  test("a pull that returns after the key changed is discarded", async () => {
    let apiKey = "ak_old";
    const backend = stubBackend({
      "GET /policies/profiles/active": async () => {
        apiKey = "ak_new";
        return active(1, forbid("old-org", "run_command"));
      },
    });
    cleanups.push(backend.stop);
    const { src } = source({ access: () => ({ login: { ...backend.login, apiKey }, client: "c" }) });
    expect(await src.refresh()).toEqual({ kind: "skipped", reason: "login changed" });
    expect(src.current().origin).toBe("default");
  });

  test("concurrent refreshes share one request", async () => {
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(1, forbid("org", "run_command")) });
    cleanups.push(backend.stop);
    const { src } = source({ access: () => ({ login: backend.login, client: "c" }) });
    await Promise.all([src.refresh(), src.refresh(), src.refresh()]);
    expect(backend.seen.length).toBe(1);
  });

  test("the refresh timer picks up a newly confirmed policy without a restart", async () => {
    let policy: unknown = null;
    const backend = stubBackend({ "GET /policies/profiles/active": () => active(policy ? 5 : 0, policy) });
    cleanups.push(backend.stop);
    const { src } = source({ access: () => ({ login: backend.login, client: "c" }), refreshMs: 20 });
    policy = forbid("org", "run_command");
    await until(() => src.current().origin === "backend");
    expect(src.current().backendVersion).toBe(5);
  });
});
