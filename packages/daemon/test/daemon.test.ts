import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import type { HookEvent } from "@armorantigravity/protocol";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { AlreadyRunning, startDaemon, type RunningDaemon } from "../src/daemon.ts";
import type { DaemonEvent, DaemonPlugin } from "../src/plugin.ts";
import { sandboxHome } from "./sandbox.ts";

const STAGING = "https://staging-api.armoriq.ai";
let sandbox: ReturnType<typeof sandboxHome>;
let running: RunningDaemon[] = [];

beforeEach(() => {
  sandbox = sandboxHome();
});
afterEach(async () => {
  await Promise.all(running.map((d) => d.stop()));
  running = [];
  sandbox.cleanup();
});

const quiet = { info() {}, warn() {}, error() {} };
const start = async (plugins: DaemonPlugin[], env: Record<string, string> = {}) => {
  const d = await startDaemon({ env: { ARMORIQ_BACKEND_URL: STAGING, ...env }, plugins, log: quiet });
  running.push(d);
  return d;
};
const login = () => saveLoginProfile({ backend: STAGING, product: "armorantigravity", apiKey: "ak_test", email: "dev@example.com", userId: "user-1", orgId: "org-1" });

const transcript = (dir: string, id: string) => `${sandbox.home}/.gemini/${dir}/brain/${id}/.system_generated/logs/transcript.jsonl`;
const base = (id: string, dir = "antigravity-cli") => ({
  conversationId: id,
  workspacePaths: ["/w"],
  transcriptPath: transcript(dir, id),
  artifactDirectoryPath: `${sandbox.home}/.gemini/${dir}/brain/${id}`,
  modelName: "gemini-3.8-flash-high",
});
const payload = (id: string, dir?: string) => ({ ...base(id, dir), invocationNum: 0, initialNumSteps: 0 });
const stopPayload = (id: string) => ({ ...base(id), executionNum: 0, fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" });
const toolPayload = (id: string, dir?: string) => ({ ...base(id, dir), toolCall: { name: "run_command", args: { CommandLine: "ls" } }, stepIdx: 0 });

let seq = 0;
function send(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath);
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      if (!buf.includes("\n")) return;
      s.destroy();
      resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
    });
    s.on("error", reject);
    s.write(`${line}\n`);
  });
}

async function hook(event: HookEvent, payload: unknown): Promise<unknown> {
  const d = running.at(-1);
  if (!d) throw new Error("no daemon running");
  const id = `r${++seq}`;
  const reply = await send(d.paths.socket, JSON.stringify({ v: 1, id, receivedAt: Date.now(), event, payload }));
  expect(reply).toMatchObject({ v: 1, id });
  return typeof reply === "object" && reply !== null && "response" in reply ? reply.response : undefined;
}

function recorder() {
  const events: DaemonEvent[] = [];
  const kicks: string[] = [];
  const flushed: string[] = [];
  const plugin: DaemonPlugin = {
    name: "recorder",
    setup: () => ({
      observe: (e) => events.push(e),
      pumps: [{ name: "audit", kick: () => kicks.push("audit"), stop: async () => void flushed.push("audit") }],
    }),
  };
  return { plugin, events, kicks, flushed };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("a hook request gets a decision and the session is keyed by surface", async () => {
  const rec = recorder();
  const d = await start([rec.plugin]);
  expect(await hook("PreToolUse", toolPayload("conv-1"))).toEqual({ decision: "allow" });
  expect(await hook("PreToolUse", toolPayload("conv-1", "antigravity-ide"))).toEqual({ decision: "allow" });
  await settle();

  expect(rec.events.map((e) => (e.kind === "hook" ? `hook:${e.hook.session.key}` : `${e.kind}:${"session" in e ? e.session.key : ""}`))).toEqual([
    "session_start:cli:conv-1",
    "hook:cli:conv-1",
    "session_start:ide:conv-1",
    "hook:ide:conv-1",
  ]);
  await d.stop();
  expect(readdirSync(d.paths.sessionsDir).sort()).toEqual(["cli-conv-1.json", "ide-conv-1.json"]);
  expect(readFileSync(d.paths.modeFile, "utf8")).toBe("monitor\n");
});

test("PreInvocation opens a turn and Stop closes it and kicks the pumps", async () => {
  const rec = recorder();
  await start([rec.plugin]);
  expect(await hook("PreInvocation", payload("conv-2"))).toBeNull();
  expect(await hook("Stop", stopPayload("conv-2"))).toBeNull();
  await settle();
  expect(rec.events.map((e) => e.kind)).toEqual(["session_start", "turn_start", "hook", "turn_end", "hook"]);
  expect(rec.kicks).toEqual(["audit"]);
});

test("graceful stop flushes pumps, writes snapshots and removes the socket", async () => {
  const rec = recorder();
  const d = await start([rec.plugin]);
  await hook("PreInvocation", payload("conv-3"));
  await d.stop();
  expect(rec.flushed).toEqual(["audit"]);
  expect(existsSync(d.paths.socket)).toBe(false);
  expect(JSON.parse(readFileSync(path.join(d.paths.sessionsDir, "cli-conv-3.json"), "utf8"))).toMatchObject({ v: 1, surface: "cli", conversationId: "conv-3" });
});

test("a second daemon is refused while the first holds the lock, and starts once it stops", async () => {
  const first = await start([]);
  await expect(start([])).rejects.toBeInstanceOf(AlreadyRunning);
  await first.stop();
  const second = await start([]);
  expect(existsSync(second.paths.socket)).toBe(true);
});

test("a plugin setup failure releases the lock and flushes earlier pumps", async () => {
  const rec = recorder();
  const twoDeciders: DaemonPlugin[] = [rec.plugin, { name: "a", setup: () => ({ decide: () => null }) }, { name: "b", setup: () => ({ decide: () => null }) }];
  await expect(startDaemon({ env: {}, plugins: twoDeciders, log: quiet })).rejects.toThrow("second decision handler");
  expect(rec.flushed).toEqual(["audit"]);
  await start([]);
});

test("enforce mode fails closed on a bad payload or a handler error; monitor fails open", async () => {
  const thrower: DaemonPlugin = { name: "thrower", setup: () => ({ decide: () => Promise.reject(new Error("boom")) }) };
  await start([thrower]);
  expect(await hook("PreToolUse", { conversationId: "x" })).toEqual({ decision: "allow" });
  expect(await hook("PreToolUse", toolPayload("conv-4"))).toEqual({ decision: "allow" });

  await running.pop()?.stop();
  login();
  const d = await start([thrower]);
  expect(readFileSync(d.paths.modeFile, "utf8")).toBe("enforce\n");
  expect(await hook("PreToolUse", { conversationId: "x" })).toEqual({
    decision: "deny",
    reason: "ArmorIQ blocked this call [malformed_payload]: the hook payload is missing required fields",
  });
  expect(await hook("PreToolUse", toolPayload("conv-4"))).toEqual({ decision: "deny", reason: "ArmorIQ blocked this call [internal_error]: guard error" });
  expect(await hook("PostToolUse", { conversationId: "x" })).toBeNull();
});

test("a request with another protocol version gets the fallback for its event", async () => {
  login();
  const d = await start([]);
  const line = JSON.stringify({ v: 2, id: "r1", receivedAt: 0, event: "PreToolUse", payload: toolPayload("c") });
  expect(await send(d.paths.socket, line)).toEqual({
    v: 1,
    id: "r1",
    response: { decision: "deny", reason: "ArmorIQ blocked this call [protocol_mismatch]: unsupported protocol version, expected 1" },
  });
});

test("one connection can carry several requests and each answer keeps its id", async () => {
  const d = await start([]);
  const replies = await new Promise<unknown[]>((resolve, reject) => {
    const s = connect(d.paths.socket);
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      const lines = buf.split("\n").filter(Boolean);
      if (lines.length < 2) return;
      s.destroy();
      resolve(lines.map((l) => JSON.parse(l)));
    });
    s.on("error", reject);
    const req = (id: string, event: HookEvent, p: unknown) => JSON.stringify({ v: 1, id, receivedAt: 0, event, payload: p });
    s.write(`${req("a", "PreToolUse", toolPayload("m"))}\n${req("b", "Stop", stopPayload("m"))}\n`);
  });
  expect(replies).toContainEqual({ v: 1, id: "a", response: { decision: "allow" } });
  expect(replies).toContainEqual({ v: 1, id: "b", response: null });
});

test("stop does not wait on a client that connected and never sent a line", async () => {
  const d = await start([]);
  const idle = connect(d.paths.socket);
  await new Promise((r) => idle.once("connect", r));
  const started = Date.now();
  await d.stop();
  expect(Date.now() - started).toBeLessThan(1_000);
  idle.destroy();
});
