import { startDaemon, type DaemonPlugin, type RunningDaemon } from "@armorantigravity/daemon";
import {
  DAEMON_UNAVAILABLE_CODE,
  DAEMON_UNAVAILABLE_REASON,
  fallbackResponse,
  hookResponseLine,
  type HookEvent,
} from "@armorantigravity/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileHook, hostTarget } from "../../../scripts/build-hook.ts";
import { sandboxHome } from "../../daemon/test/sandbox.ts";

const buildDir = mkdtempSync(path.join(tmpdir(), "agd-hook-build-"));
const CLIENT = path.join(buildDir, "agd-hook");
const DAEMON_MAIN = path.join(import.meta.dir, "../../daemon/src/main.ts");
let sandbox: ReturnType<typeof sandboxHome>;
let daemon: RunningDaemon | null = null;

beforeAll(() => {
  compileHook(hostTarget(), CLIENT);
});
afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});
beforeEach(() => {
  sandbox = sandboxHome();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  sandbox.cleanup();
});

const quiet = { info() {}, warn() {}, error() {} };
// A decision no pre-rendered fallback can produce, so a hook that quietly fell back fails the test.
const FROM_DAEMON = { decision: "ask", reason: "answered by the daemon" } as const;
const decider: DaemonPlugin = { name: "decider", setup: () => ({ decide: ({ event }) => (event === "PreToolUse" ? FROM_DAEMON : null) }) };
const live = () => startDaemon({ env: {}, plugins: [decider], log: quiet });
const dataDir = () => path.join(sandbox.home, ".armoriq", "armorantigravity");
const base = (id: string) => ({
  conversationId: id,
  workspacePaths: ["/w"],
  transcriptPath: `${sandbox.home}/.gemini/antigravity-ide/brain/${id}/t.jsonl`,
  artifactDirectoryPath: `${sandbox.home}/.gemini/antigravity-ide/brain/${id}`,
  modelName: "gemini-3.8-flash-high",
});
const payload = (id: string) => ({ ...base(id), invocationNum: 0, initialNumSteps: 0 });
const stopPayload = (id: string) => ({ ...base(id), executionNum: 0, fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" });
const toolPayload = (id: string) => ({ ...base(id), toolCall: { name: "write_to_file", args: { TargetFile: "/w/a" } }, stepIdx: 2 });

async function run(args: string[], stdin: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([CLIENT, ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", env: { ...process.env, ...env } });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

async function hook(args: string[], stdin: string, env: Record<string, string> = {}): Promise<unknown> {
  const out = await run(args, stdin, env);
  return out === "" ? null : JSON.parse(out);
}

test("forwards stdin to the daemon and prints the decision", async () => {
  daemon = await live();
  expect(await hook(["PreToolUse"], JSON.stringify(toolPayload("c1")))).toEqual(FROM_DAEMON);
  expect(await hook(["PostInvocation"], JSON.stringify(payload("c1")))).toBeNull();
  await daemon.stop();
  expect(readdirSync(path.join(dataDir(), "sessions"))).toEqual(["ide-c1.json"]);
});

test("a payload spread over several lines still reaches the daemon as one request", async () => {
  daemon = await live();
  expect(await hook(["PreToolUse"], JSON.stringify(toolPayload("c2"), null, 2))).toEqual(FROM_DAEMON);
});

test("an unknown event prints an empty response without contacting the daemon", async () => {
  expect(await hook(["SessionStart"], "{}")).toBeNull();
  expect(await hook([], "")).toBeNull();
});

test("unparseable stdin reaches the daemon, which applies the mode", async () => {
  daemon = await startDaemon({ env: {}, plugins: [], log: quiet });
  expect(await hook(["PreToolUse"], "not json")).toEqual({ decision: "allow" });
});

test("a cold socket starts the daemon and the call is answered", async () => {
  const starter = path.join(sandbox.home, "start-agd");
  writeFileSync(starter, `#!/bin/sh\nexec ${process.execPath} ${DAEMON_MAIN}\n`, { mode: 0o755 });
  chmodSync(starter, 0o755);
  const out = await run(["PreToolUse"], JSON.stringify(toolPayload("c3")), { ARMORANTIGRAVITY_DAEMON: starter });
  expect(JSON.parse(out)).toEqual({ decision: "allow" });
  expect(existsSync(path.join(dataDir(), "agd.sock"))).toBe(true);
}, 20_000);

test("with no daemon reachable it prints the fallback the daemon left for that event", async () => {
  const env = { ARMORANTIGRAVITY_DAEMON: path.join(sandbox.home, "missing-agd") };
  const fallbackDir = path.join(dataDir(), "fallback");
  mkdirSync(fallbackDir, { recursive: true });
  const publish = (event: HookEvent, mode: "enforce" | "monitor") =>
    writeFileSync(path.join(fallbackDir, event), hookResponseLine(fallbackResponse(event, mode, DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_REASON)));

  publish("PreToolUse", "enforce");
  publish("Stop", "enforce");
  const started = Date.now();
  expect(await hook(["PreToolUse"], JSON.stringify(toolPayload("c")), env)).toMatchObject({
    decision: "deny",
    reason: `ArmorIQ blocked this call [${DAEMON_UNAVAILABLE_CODE}]: ${DAEMON_UNAVAILABLE_REASON}`,
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await hook(["Stop"], JSON.stringify(stopPayload("c")), env)).toBeNull();

  publish("PreToolUse", "monitor");
  expect(await hook(["PreToolUse"], JSON.stringify(toolPayload("c")), env)).toEqual({ decision: "allow" });
}, 20_000);

test("a missing fallback file denies the tool call with the protocol's own enforce response", async () => {
  const env = { ARMORANTIGRAVITY_DAEMON: path.join(sandbox.home, "missing-agd") };
  expect(await run(["PreToolUse"], JSON.stringify(toolPayload("c")), env)).toBe(
    hookResponseLine(fallbackResponse("PreToolUse", "enforce", DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_REASON)),
  );
  expect(await run(["PostToolUse"], JSON.stringify(toolPayload("c")), env)).toBe("");
}, 20_000);
