import { describe, expect, test } from "bun:test";
import type { HookPayload, HookResponse, Surface } from "@armorantigravity/protocol";
import { INTENT_DIRECTIVE } from "../src/directive.ts";
import { intentRegistration, withIntent, type IntentHook } from "../src/plugin.ts";
import { createIntentRuntime } from "../src/runtime.ts";
import { LOGIN, permitAll, recordingBackend, silentLog } from "./helpers.ts";

const CONV = "95c0238a-147e-4adc-942e-376c18a16f42";
const base = { conversationId: CONV, workspacePaths: ["/private/tmp/agspike/ws"], transcriptPath: "" };
const preInvocation: HookPayload = { ...base, event: "PreInvocation", invocationNum: 0 };
const register: HookPayload = {
  ...base,
  event: "PreToolUse",
  toolCall: { name: "mcp_armoriq_register_intent_plan", args: { goal: "list files", steps: [{ action: "run_command" }] } },
  stepIdx: 1,
};
const runCommand: HookPayload = { ...base, event: "PreToolUse", toolCall: { name: "run_command", args: { CommandLine: "ls" } }, stepIdx: 2 };

function setup(mode: "enforce" | "monitor" = "enforce") {
  const rec = recordingBackend();
  const rt = createIntentRuntime({
    client: { product: "armorantigravity", version: "0.0.0" },
    login: () => LOGIN,
    mode: () => mode,
    policy: () => permitAll,
    mintPolicy: () => undefined,
    audit: () => {},
    log: silentLog,
    backend: rec.backend,
  });
  const seen: HookPayload[] = [];
  let reply: HookResponse = {};
  const decide = withIntent(rt, (hook: IntentHook) => {
    seen.push(hook.payload);
    return hook.payload.event === "PreToolUse" ? { decision: "allow" } : reply;
  });
  const hook = (payload: HookPayload, surface: Surface = "cli") => decide({ payload, session: { surface } });
  return { rt, rec, seen, hook, setReply: (r: HookResponse) => void (reply = r) };
}

describe("withIntent", () => {
  test("own tools are decided by intent and never reach the inner handler", async () => {
    const { rt, rec, seen, hook } = setup();
    expect(await hook(register)).toEqual({ decision: "allow" });
    expect(seen).toEqual([]);
    expect(rec.mints).toHaveLength(1);
    expect(rt.root({ surface: "cli", conversationId: CONV })?.plan?.id).toBe("plan-1");
  });

  test("other tool calls go to the inner handler after the conversation is observed", async () => {
    const { rt, seen, hook } = setup();
    expect(await hook(runCommand)).toEqual({ decision: "allow" });
    expect(seen).toEqual([runCommand]);
    expect(rt.root({ surface: "cli", conversationId: CONV })).not.toBeNull();
  });

  test("the directive is injected while no plan is registered, and appended to the inner steps", async () => {
    const { hook, setReply } = setup();
    expect(await hook(preInvocation)).toEqual({ injectSteps: [{ type: "ephemeralMessage", text: INTENT_DIRECTIVE }] });
    setReply({ injectSteps: [{ type: "userMessage", text: "core" }] });
    expect(await hook(preInvocation)).toEqual({
      injectSteps: [
        { type: "userMessage", text: "core" },
        { type: "ephemeralMessage", text: INTENT_DIRECTIVE },
      ],
    });
    await hook(register);
    setReply({});
    expect(await hook(preInvocation)).toEqual({});
  });

  test("monitor mode leaves the inner PreInvocation response untouched", async () => {
    const { hook } = setup("monitor");
    expect(await hook(preInvocation)).toEqual({});
  });

  test("the same conversationId on two surfaces keeps two plans", async () => {
    const { rt, rec, hook } = setup();
    await hook(register, "cli");
    expect(rt.root({ surface: "ide", conversationId: CONV })).toBeNull();
    await hook(register, "ide");
    expect(rec.mints.map((m) => m.contextId)).toEqual([CONV, CONV]);
    expect(rt.root({ surface: "ide", conversationId: CONV })?.plan?.id).toBe("plan-2");
  });
});

describe("intentRegistration", () => {
  test("session_end revokes the conversation's plan; other events do nothing", async () => {
    const { rt, rec, hook } = setup();
    await hook(register);
    const reg = intentRegistration(rt);
    const session = { surface: "cli" as const, conversationId: CONV };
    reg.observe({ kind: "turn_end", session });
    reg.observe({ kind: "auth" });
    expect(rec.revokes).toEqual([]);
    reg.observe({ kind: "session_end", session });
    await Bun.sleep(0);
    expect(rec.revokes.map((r) => r.planId)).toEqual(["plan-1"]);
    expect(reg.pumps.map((p) => p.name)).toEqual(["intent-token"]);
    await rt.pump.stop();
  });
});
