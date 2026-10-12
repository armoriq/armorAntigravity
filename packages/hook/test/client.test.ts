import { startDaemon, type RunningDaemon } from "@armorantigravity/daemon";
import type { HookEvent } from "@armorantigravity/protocol";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sandboxHome } from "../../daemon/test/sandbox.ts";

const CLIENT = path.join(import.meta.dir, "../src/main.ts");
let sandbox: ReturnType<typeof sandboxHome>;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  sandbox = sandboxHome();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  sandbox.cleanup();
});

const quiet = { info() {}, warn() {}, error() {} };
const dataDir = () => path.join(sandbox.home, ".armoriq", "armorantigravity");
const payload = (id: string) => ({ conversationId: id, workspacePaths: ["/w"], transcriptPath: `${sandbox.home}/.gemini/antigravity-ide/brain/${id}/t.jsonl` });
const toolPayload = (id: string) => ({ ...payload(id), toolCall: { name: "write_to_file", args: { TargetFile: "/w/a" } }, stepIdx: 2 });

async function hook(args: string[], stdin: string, env: Record<string, string> = {}): Promise<unknown> {
  const proc = Bun.spawn(["bun", CLIENT, ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", env: { ...process.env, ...env } });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(out);
}

test("forwards stdin to the daemon and prints the decision", async () => {
  daemon = await startDaemon({ env: {}, plugins: [], log: quiet });
  expect(await hook(["PreToolUse"], JSON.stringify(toolPayload("c1")))).toEqual({ decision: "allow" });
  expect(await hook(["PostInvocation"], JSON.stringify(payload("c1")))).toEqual({});
  await daemon.stop();
  expect(readdirSync(path.join(dataDir(), "sessions"))).toEqual(["ide-c1.json"]);
});

test("an unknown event prints an empty response without contacting the daemon", async () => {
  expect(await hook(["SessionStart"], "{}")).toEqual({});
  expect(await hook([], "")).toEqual({});
});

test("unparseable stdin reaches the daemon, which applies the mode", async () => {
  daemon = await startDaemon({ env: {}, plugins: [], log: quiet });
  expect(await hook(["PreToolUse"], "not json")).toEqual({ decision: "allow" });
});

test("with no daemon reachable it follows the cached mode within the start budget", async () => {
  const env = { ARMORANTIGRAVITY_DAEMON: path.join(sandbox.home, "missing-agd") };
  const run = (event: HookEvent, p: unknown) => hook([event], JSON.stringify(p), env);

  const started = Date.now();
  expect(await run("PreToolUse", toolPayload("c"))).toMatchObject({ decision: "deny", reason: expect.stringContaining("ArmorIQ blocked this call [daemon_unavailable]") });
  expect(Date.now() - started).toBeLessThan(5_000);

  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path.join(dataDir(), "mode"), "monitor\n");
  expect(await run("PreToolUse", toolPayload("c"))).toEqual({ decision: "allow" });
  expect(await run("Stop", payload("c"))).toEqual({});

  writeFileSync(path.join(dataDir(), "mode"), "enforce\n");
  expect(await run("PreToolUse", toolPayload("c"))).toMatchObject({ decision: "deny" });
}, 20_000);
