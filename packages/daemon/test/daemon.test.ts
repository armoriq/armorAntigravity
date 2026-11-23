import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_REASON, HOOK_FRAME_TAG, type HookEvent } from "@armorantigravity/protocol";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { AlreadyRunning, startDaemon, type RunningDaemon } from "../src/daemon.ts";
import type { DaemonEvent, DaemonPlugin } from "../src/plugin.ts";
import { RESTART_EXIT_CODE } from "../src/update.ts";
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
  // Signed-in runs here cover Block; workspace Monitor is covered in armoriq.test.ts.
  const d = await startDaemon({ env: { ARMORIQ_BACKEND_URL: STAGING, ARMORIQ_ORG_MODE: "enforce", ...env }, plugins, log: quiet });
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

test("a socket path longer than sun_path is bound in full, from its directory", async () => {
  const socket = path.join(sandbox.home, "d".repeat(120), "agd.sock");
  const cwd = process.cwd();
  const rec = recorder();
  await start([rec.plugin], { ARMORANTIGRAVITY_SOCKET: socket });
  expect(process.cwd()).toBe(cwd);
  expect(statSync(socket).mode & 0o777).toBe(0o600);
  expect(await hook("PreToolUse", toolPayload("conv-long"))).toEqual({ decision: "allow" });
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

function sendRaw(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath);
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      if (!buf.includes("\n")) return;
      s.destroy();
      resolve(buf.slice(0, buf.indexOf("\n")));
    });
    s.on("error", reject);
    s.write(`${line}\n`);
  });
}

const frame = (d: RunningDaemon, event: HookEvent, payload: string) => sendRaw(d.paths.socket, `${HOOK_FRAME_TAG} ${event} ${Date.now()} ${payload}`);

test("a frame is answered with the bare response line, and a null response with an empty one", async () => {
  const rec = recorder();
  const d = await start([rec.plugin]);
  expect(await frame(d, "PreToolUse", JSON.stringify(toolPayload("conv-f1")))).toBe(`${HOOK_FRAME_TAG} {"decision":"allow"}`);
  expect(await frame(d, "PostInvocation", JSON.stringify(payload("conv-f1")))).toBe(HOOK_FRAME_TAG);
  await settle();
  expect(rec.events.map((e) => e.kind)).toEqual(["session_start", "hook", "hook"]);
});

test("a frame whose payload is not JSON reaches the mode, not the decision handler", async () => {
  login();
  const d = await start([]);
  expect(await frame(d, "PreToolUse", "not json")).toBe(
    `${HOOK_FRAME_TAG} ${JSON.stringify({ decision: "deny", reason: "ArmorIQ blocked this call [malformed_payload]: the hook payload is missing required fields" })}`,
  );
});

test("the daemon pre-renders the fallback each event gets while it is unreachable", async () => {
  const d = await start([]);
  const read = (event: string) => readFileSync(path.join(d.paths.fallbackDir, event), "utf8");
  expect(read("PreToolUse")).toBe('{"decision":"allow"}\n');
  for (const event of ["PostToolUse", "PreInvocation", "PostInvocation", "Stop"]) expect(read(event)).toBe("");

  await running.pop()?.stop();
  login();
  const enforcing = await start([]);
  expect(readFileSync(path.join(enforcing.paths.fallbackDir, "PreToolUse"), "utf8")).toBe(
    `${JSON.stringify({ decision: "deny", reason: `ArmorIQ blocked this call [${DAEMON_UNAVAILABLE_CODE}]: ${DAEMON_UNAVAILABLE_REASON}` })}\n`,
  );
  expect(readFileSync(enforcing.paths.modeFile, "utf8")).toBe("enforce\n");
});

function stageUpdate(version: string, members: Record<string, string>): string {
  const dataDir = path.join(sandbox.home, ".armoriq", "armorantigravity");
  const stage = path.join(sandbox.home, "stage");
  mkdirSync(stage, { recursive: true });
  mkdirSync(path.join(dataDir, "staged"), { recursive: true });
  for (const [name, body] of Object.entries(members)) writeFileSync(path.join(stage, name), body, { mode: 0o755 });
  const archive = path.join(dataDir, "staged", "armorantigravity-test.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", archive, "-C", stage, ...Object.keys(members)]).exitCode).toBe(0);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(path.join(dataDir, "update.json"), JSON.stringify({ lastCheckedAt: 1, lastSeenVersion: version, staged: { version, channel: "stable", archive, sha256, stagedAt: 1 } }));
  return archive;
}

test("armoriq-agd applies a staged update at startup and exits for the service manager to restart it", async () => {
  const binDir = path.join(sandbox.home, ".armoriq", "armorantigravity", "bin");
  mkdirSync(binDir, { recursive: true });
  const archive = stageUpdate("v9.9.9", { armorantigravity: "#!/bin/sh\n# new cli\n", "armoriq-agd": '#!/bin/sh\nNODE=""\n# new agd\n', "agd-hook": "#!/bin/sh\n# new hook\n", "agd.js": "// new bundle\n" });

  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "main.ts")], { env: { PATH: process.env.PATH ?? "", HOME: sandbox.home }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(RESTART_EXIT_CODE);
  expect(stderr).toContain("applied ArmorAntigravity v9.9.9");
  expect(readFileSync(path.join(binDir, "armoriq-agd"), "utf8")).toContain("# new agd");
  expect(readFileSync(path.join(binDir, "agd.js"), "utf8")).toBe("// new bundle\n");
  expect(existsSync(path.join(sandbox.home, ".armoriq", "armorantigravity", "release.sha256"))).toBe(true);
  expect(existsSync(archive)).toBe(false);
});

test("a staged update asks for a restart only once no session is open", async () => {
  const restarts: string[] = [];
  const d = await startDaemon({ env: { ARMORIQ_BACKEND_URL: STAGING }, plugins: [], log: quiet, sessionIdleMs: 300, onRestartRequired: (v) => restarts.push(v) });
  running.push(d);
  await hook("PreInvocation", payload("conv-busy"));
  stageUpdate("v9.9.9", { armorantigravity: "x", "armoriq-agd": "x", "agd-hook": "x" });
  await Bun.sleep(200);
  expect(restarts).toEqual([]);
  await Bun.sleep(700);
  expect(restarts).toEqual(["v9.9.9"]);
  await Bun.sleep(400);
  expect(restarts).toEqual(["v9.9.9"]);
});
