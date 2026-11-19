import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOutbox } from "@armorantigravity/core";
import { createAuditPump } from "../src/pumps/audit.ts";
import { login, quietLog, uploads } from "./support.ts";

const buildDir = mkdtempSync(path.join(tmpdir(), "agy-fallback-build-"));
const HOOK = path.join(buildDir, "agd-hook");
beforeAll(async () => {
  const { compileHook, hostTarget } = await import(path.join(import.meta.dir, "../../../scripts/build-hook.ts"));
  compileHook(hostTarget(), HOOK);
});
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const capture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../adapter/test/fixtures/captured/pre-write_file.json"), "utf8")).stdin;

async function fallback(signedIn: boolean, stdin = JSON.stringify(capture)) {
  const { startDaemon } = await import(path.join(import.meta.dir, "../../daemon/src/daemon.ts"));
  const home = mkdtempSync(path.join(tmpdir(), "agy-fallback-"));
  homes.push(home);
  const dataDir = path.join(home, ".armoriq", "armorantigravity");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ backendUrl: "https://capture.invalid" }));
  const env = { ...process.env, HOME: home, ARMORIQ_HOME: path.join(home, ".armoriq"), ARMORANTIGRAVITY_SOCKET: path.join(dataDir, "agd.sock"), ARMORANTIGRAVITY_DAEMON: "/usr/bin/false", ARMORIQ_ORG_MODE: "enforce", ARMORIQ_API_KEY: signedIn ? "ak_test_capture" : "", ARMORIQ_BACKEND_URL: "https://capture.invalid" };
  const prior = await startDaemon({ env, plugins: [], log: quietLog });
  await prior.stop();
  // Missing pre-rendered output exercises the compiled deny even while deliberately logged out.
  if (!signedIn) rmSync(path.join(dataDir, "fallback", "PreToolUse"));
  const proc = Bun.spawn([HOOK, "PreToolUse"], {
    stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
    env,
  });
  const response = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(response).toMatchObject({ decision: "deny" });
  expect(readdirSync(path.join(dataDir, "fallback-spool")).filter(f => f.endsWith(".spool"))).toHaveLength(1);
  const daemon = await startDaemon({ env, plugins: [], log: quietLog });
  await daemon.stop();
  expect(readdirSync(path.join(dataDir, "fallback-spool", "archive"))).toHaveLength(1);
  return { dataDir, response, env };
}

test("a C fallback is durable before exit and the daemon adopts one sanitized envelope", async () => {
  const { dataDir } = await fallback(true);
  const delivered: unknown[] = [];
  const identity = login("https://capture.invalid", { apiKey: "ak_test_capture" });
  const pump = createAuditPump({ dataDir, log: quietLog, uploads: uploads(() => identity), post: async (_login, _uploads, rows) => {
    delivered.push(...rows);
    return { ok: true, value: { written: rows.length, failures: [] } };
  } });
  await pump.kick();
  expect(delivered).toEqual([{
    client_row_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    session_id: capture.conversationId, tool: "unknown", action: "unknown", input: {},
    executed_at: expect.any(String), decision_code: "internal_error", status: "blocked",
  }]);
  expect(pump.status()).toEqual({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 0, legacyPending: 0, corruptRecords: 0, holds: [] });
  await pump.stop();
  const text = readdirSync(path.join(dataDir, "outbox", "audit-v2")).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(path.join(dataDir, "outbox", "audit-v2", f), "utf8")).join("");
  expect(text).not.toContain("ak_test_capture");
  expect(text).not.toContain("TargetFile");
}, 10_000);

test("a deliberate logged out C fallback creates no row or capture failure", async () => {
  const { dataDir } = await fallback(false, "not JSON");
  const outbox = createOutbox(dataDir, "audit", quietLog, { login: () => ({ backend: "https://capture.invalid", keyId: "later" }) });
  expect(outbox.status()).toEqual({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 0, legacyPending: 0, corruptRecords: 0, holds: [] });
  await outbox.persist();
}, 10_000);
