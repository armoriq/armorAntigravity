import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookPayload } from "@armorantigravity/protocol";
import { checkIntent } from "../src/decision.ts";
import { INTENT_DIRECTIVE } from "../src/directive.ts";
import { createIntentRuntime } from "../src/runtime.ts";
import { intentRegistration } from "../src/plugin.ts";
import type { Login, Mode } from "../src/types.ts";
import { LOGIN, permitAll, recordingBackend, silentLog } from "./helpers.ts";
import contract from "./fixtures/plan-capture-v1.json";

const FIXTURE = join(import.meta.dir, "fixtures", "spike");
const PARENT = "95c0238a-147e-4adc-942e-376c18a16f42";
const CHILD = "b82464e5-3392-4925-8772-4bda03973e9f";
const SECOND_CHILD = "3afe252b-10dc-4b17-85fc-e3f3a5f5c391";

// Hook events captured from agy CLI by the P0 spike (run r4-subagents), home directory relocated to the fixture.
const events: HookPayload[] = readFileSync(join(FIXTURE, "events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const { event, payload } = JSON.parse(line.replaceAll("<HOME>", join(FIXTURE, "home")));
    return { ...payload, event };
  });

function runtime(opts: { mode?: Mode; fileExists?: (p: string) => boolean; gate?: boolean; now?: () => number } = {}) {
  const rec = recordingBackend({ gate: opts.gate ?? false, ...(opts.now ? { now: opts.now } : {}) });
  let login: Login | null = opts.mode === "monitor" ? null : LOGIN;
  let mode: Mode = opts.mode ?? "enforce";
  const rt = createIntentRuntime({
    client: { product: "armorantigravity", version: "0.0.0" },
    login: () => login,
    mode: () => mode,
    policy: () => permitAll,
    mintPolicy: () => undefined,
    audit: () => {},
    log: silentLog,
    backend: rec.backend,
    ...(opts.fileExists ? { fileExists: opts.fileExists } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    rt, rec,
    setLogin: (next: Login | null) => {
      login = next;
      intentRegistration(rt).observe({ kind: "auth" });
    },
    setMode: (next: Mode) => {
      mode = next;
      intentRegistration(rt).observe({ kind: "auth" });
    },
  };
}

async function replay(rt: ReturnType<typeof runtime>["rt"], until = events.length) {
  const injected: { conversationId: string; text: string }[] = [];
  for (const payload of events.slice(0, until)) {
    rt.observe("cli", payload);
    if (payload.event === "PreInvocation") {
      const r = rt.preInvocation("cli", payload);
      if (r && "injectSteps" in r) for (const s of r.injectSteps) if (s.type === "ephemeralMessage") injected.push({ conversationId: payload.conversationId, text: s.text });
    }
  }
  return injected;
}

const parentPlanCall: HookPayload = {
  event: "PreToolUse",
  conversationId: PARENT,
  workspacePaths: ["/private/tmp/agspike/ws"],
  transcriptPath: "",
  artifactDirectoryPath: `/private/tmp/agspike/home/.gemini/antigravity-cli/brain/${PARENT}`,
  modelName: "gemini-3.8-flash-high",
  toolCall: { name: "mcp_armoriq_register_intent_plan", args: { goal: "delegate work", steps: [{ action: "invoke_subagent" }, { action: "run_command" }] } },
  stepIdx: 1,
};

describe("replay of the spike capture", () => {
  test("both subagents resolve to the parent, and a child's call is checked against the parent's plan", async () => {
    const { rt } = runtime();
    rt.observe("cli", events[0]!);
    rt.observe("cli", parentPlanCall);
    expect(await rt.ownToolDecision("cli", parentPlanCall)).toEqual({ decision: "allow" });
    await replay(rt);

    expect(rt.root({ surface: "cli", conversationId: CHILD })?.ref.conversationId).toBe(PARENT);
    expect(rt.root({ surface: "cli", conversationId: SECOND_CHILD })?.ref.conversationId).toBe(PARENT);
    const childRoot = rt.root({ surface: "cli", conversationId: CHILD });
    expect(checkIntent({ root: childRoot, tool: "run_command", args: {}, readOnly: false, now: Date.now() })).toEqual({ kind: "allow", stepIndex: 1, paramMismatch: false });
    expect(checkIntent({ root: childRoot, tool: "write_to_file", args: {}, readOnly: false, now: Date.now() })).toMatchObject({ code: "intent_drift" });
  });

  test("the revision counter resets once per user message, not once per model invocation", async () => {
    const { rt } = runtime();
    await replay(rt);
    const parentPreInvocations = events.filter((e) => e.event === "PreInvocation" && e.conversationId === PARENT);
    const userMessages = parentPreInvocations.filter((e) => e.event === "PreInvocation" && e.invocationNum === 0);
    // invocationNum 0 appears twice, each delivered twice because the capture registered global and plugin
    // hooks. The second is the parent waking on its subagent's send_message, not a user message.
    expect(parentPreInvocations.length).toBe(10);
    expect(userMessages.length).toBe(4);
    expect(rt.root({ surface: "cli", conversationId: PARENT })?.turn).toBe(1);
  });

  test("enforce mode injects the directive into the root while it has no plan, never into a subagent", async () => {
    const { rt } = runtime();
    const injected = await replay(rt);
    expect(new Set(injected.map((i) => i.conversationId))).toEqual(new Set([PARENT]));
    expect(injected[0]!.text).toBe(INTENT_DIRECTIVE);
  });

  test("monitor mode injects nothing", async () => {
    const { rt } = runtime({ mode: "monitor" });
    expect(await replay(rt)).toEqual([]);
  });

  test("a link file that appears after the child's first hook still links it on a later event", async () => {
    let visible = false;
    const { rt } = runtime({ fileExists: (p) => visible && existsSync(p) });
    const firstChild = events.findIndex((e) => e.conversationId === CHILD);
    await replay(rt, firstChild + 1);
    expect(rt.root({ surface: "cli", conversationId: CHILD })?.ref.conversationId).toBe(CHILD);
    visible = true;
    rt.observe("cli", events[firstChild]!);
    expect(rt.root({ surface: "cli", conversationId: CHILD })?.ref.conversationId).toBe(PARENT);
  });
});

const ROOT = { surface: "cli" as const, conversationId: PARENT };
const prompt = (initialNumSteps: number, invocationNum = 0): HookPayload => ({
  ...parentPlanCall, event: "PreInvocation", invocationNum, initialNumSteps,
});
const stop: HookPayload = {
  ...parentPlanCall, event: "Stop", executionNum: 0, fullyIdle: true, terminationReason: "done", error: "",
};

describe("prompt lifecycle", () => {
  test("the shared identity contract names the root conversation and prompt hooks", () => {
    expect(contract.identity.find((entry) => entry.plugin === "ArmorAntigravity")).toMatchObject({
      contextIdSource: "root conversationId",
      agentId: "antigravity",
      promptIdentity: "conversationId plus initialNumSteps of PreInvocation 0 (after the subagent filter)",
      turnEndEvent: "Stop",
    });
  });

  test("initialNumSteps deduplicates prompt starts and a different identity gets a fresh UUID", () => {
    const { rt, rec } = runtime();
    rt.observe("cli", prompt(0));
    const first = rt.root(ROOT)!.promptId;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    rt.observe("cli", prompt(0));
    rt.observe("cli", prompt(2, 1));
    expect(rt.root(ROOT)?.promptId).toBe(first);
    expect(rt.root(ROOT)?.promptGeneration).toBe(1);
    expect(rt.root(ROOT)?.turn).toBe(1);
    rt.observe("cli", prompt(7));
    expect(rt.root(ROOT)?.promptId).not.toBe(first);
    expect(rt.root(ROOT)?.promptGeneration).toBe(2);
    expect(rec.mints).toEqual([]);
  });

  test("a delayed duplicate of an older prompt cannot retire the current prompt", async () => {
    const { rt } = runtime();
    rt.observe("cli", prompt(0));
    rt.observe("cli", prompt(7));
    await rt.ownToolDecision("cli", parentPlanCall);
    const current = rt.root(ROOT)!.promptId;
    rt.observe("cli", prompt(0));
    expect(rt.root(ROOT)?.promptId).toBe(current);
    expect(rt.root(ROOT)?.promptGeneration).toBe(2);
    expect(rt.root(ROOT)?.plan?.id).toBe("plan-1");
  });

  test("a subagent wake up at invocation 0 starts no prompt and preserves the parent plan", async () => {
    const { rt } = runtime();
    rt.observe("cli", events[0]!);
    await rt.ownToolDecision("cli", parentPlanCall);
    const first = rt.root(ROOT)!.promptId;
    expect(first).toBeDefined();
    await replay(rt);
    expect(rt.root(ROOT)?.promptId).toBe(first);
    expect(rt.root(ROOT)?.promptGeneration).toBe(1);
    expect(rt.root(ROOT)?.plan?.id).toBe("plan-1");
    expect([...rt.registry.all()].filter((c) => c.parent !== null).every((c) => c.promptId === null)).toBe(true);
  });

  test("Stop closes only its own prompt, and hook activity updates the root", () => {
    let clock = 100;
    const { rt } = runtime({ now: () => clock });
    rt.observe("cli", prompt(0));
    expect(rt.root(ROOT)?.promptOpenSince).toBe(100);
    rt.registry.link({ surface: "cli", conversationId: CHILD }, ROOT);
    clock = 200;
    rt.observe("cli", { ...stop, conversationId: CHILD });
    expect(rt.root(ROOT)?.promptOpenSince).toBe(100);
    expect(rt.root(ROOT)?.lastActivityAt).toBe(200);
    clock = 300;
    rt.observe("cli", stop);
    expect(rt.root(ROOT)?.promptOpenSince).toBeNull();
    rt.observe("cli", prompt(0));
    expect(rt.root(ROOT)?.promptOpenSince).toBeNull();
    expect(rt.root(ROOT)?.promptGeneration).toBe(1);
  });

  test("the next prompt retires authorization for both root and subagent without server revocation", async () => {
    const { rt, rec } = runtime();
    rt.observe("cli", prompt(0));
    await rt.ownToolDecision("cli", parentPlanCall);
    rt.registry.link({ surface: "cli", conversationId: CHILD }, ROOT);
    expect(checkIntent({ root: rt.root(ROOT), tool: "run_command", args: {}, readOnly: false, now: Date.now() }).kind).toBe("allow");
    rt.observe("cli", prompt(8));
    for (const ref of [ROOT, { surface: "cli" as const, conversationId: CHILD }]) {
      expect(checkIntent({ root: rt.root(ref), tool: "run_command", args: {}, readOnly: false, now: Date.now() })).toMatchObject({ code: "intent_plan_missing" });
    }
    expect(rec.revokes).toEqual([]);
  });

  test("a second prompt registers as new without a revision reason, even with the same hook step", async () => {
    const { rt, rec } = runtime();
    rt.observe("cli", prompt(0));
    await rt.ownToolDecision("cli", parentPlanCall);
    await rt.mcpOutcome("register_intent_plan", parentPlanCall.toolCall.args, 0);
    rt.observe("cli", prompt(8));
    await rt.ownToolDecision("cli", parentPlanCall);
    expect(rec.mints.map((m) => m.contextId)).toEqual([PARENT, PARENT]);
    expect(rt.root(ROOT)?.plan?.revision).toBe(1);
    expect(rt.root(ROOT)?.kind).toBe("new");
    expect(rec.reanchors).toEqual([]);
    expect(await rt.mcpOutcome("register_intent_plan", parentPlanCall.toolCall.args, 0)).toStartWith("Intent registered:");
  });

  test("a mint from the previous prompt cannot install its result", async () => {
    const { rt, rec } = runtime({ gate: true });
    rt.observe("cli", prompt(0));
    const pending = rt.ownToolDecision("cli", parentPlanCall);
    rt.observe("cli", prompt(8));
    rec.release();
    await pending;
    expect(rt.root(ROOT)?.plan).toBeNull();
    expect(rt.root(ROOT)?.token).toBeNull();
    expect(await rt.mcpOutcome("register_intent_plan", parentPlanCall.toolCall.args, 0)).not.toStartWith("Intent registered:");
  });

  for (const change of ["logout", "login", "key", "mode"] as const) {
    test(`${change} retires the plan and drops a result from the previous auth generation`, async () => {
      const h = runtime({ gate: true });
      h.rt.observe("cli", prompt(0));
      const first = h.rt.ownToolDecision("cli", parentPlanCall);
      h.rec.release();
      await first;
      const conversation = h.rt.root(ROOT)!;
      const before = conversation.authGeneration;
      const revision = {
        ...parentPlanCall, stepIdx: 2,
        toolCall: { ...parentPlanCall.toolCall, args: { goal: "changed", steps: [{ action: "run_command" }], reason: "changed task" } },
      };
      const pending = h.rt.ownToolDecision("cli", revision);
      if (change === "logout") h.setLogin(null);
      if (change === "login") { h.setLogin(null); h.setLogin(LOGIN); }
      if (change === "key") h.setLogin({ ...LOGIN, apiKey: "ak_test_changed" });
      if (change === "mode") h.setMode("monitor");
      expect(h.rt.registry.get(conversation.key)?.plan).toBeNull();
      expect(h.rt.registry.get(conversation.key)?.authGeneration).toBe(before + (change === "login" ? 2 : 1));
      h.rec.release();
      await pending;
      expect(h.rt.root(ROOT)?.plan).toBeNull();
      expect(h.rt.root(ROOT)?.token).toBeNull();
      expect(h.rec.reanchors).toEqual([]);
    });
  }

  test("a later invocation gets the directive only until the current prompt has a registered plan", async () => {
    const { rt } = runtime();
    rt.observe("cli", prompt(0));
    const later = prompt(0, 1);
    rt.observe("cli", later);
    expect(rt.preInvocation("cli", later)).toEqual({ injectSteps: [{ type: "ephemeralMessage", text: INTENT_DIRECTIVE }] });
    await rt.ownToolDecision("cli", parentPlanCall);
    expect(rt.root(ROOT)?.countedPlanId).toBe("plan-1");
    rt.observe("cli", later);
    expect(rt.preInvocation("cli", later)).toBeNull();
  });

  test("the first invocation of the next prompt gets the directive after the previous plan is retired", async () => {
    const { rt } = runtime();
    rt.observe("cli", prompt(0));
    expect(rt.preInvocation("cli", prompt(0))).toEqual({ injectSteps: [{ type: "ephemeralMessage", text: INTENT_DIRECTIVE }] });
    await rt.ownToolDecision("cli", parentPlanCall);
    expect(rt.root(ROOT)?.countedPlanId).toBe("plan-1");
    rt.observe("cli", stop);
    rt.observe("cli", prompt(8));
    expect(rt.root(ROOT)?.countedPlanId).toBeNull();
    expect(rt.preInvocation("cli", prompt(8))).toEqual({ injectSteps: [{ type: "ephemeralMessage", text: INTENT_DIRECTIVE }] });
    expect(INTENT_DIRECTIVE).toContain("before the first tool that needs a plan");
  });
});

describe("unlinked subagent", () => {
  test("gets no directive while its link file has not appeared, so it is never told to register its own plan", async () => {
    const { rt } = runtime({ fileExists: () => false });
    const injected = await replay(rt);
    expect(injected.filter((i) => i.conversationId === CHILD)).toEqual([]);
    expect(injected.filter((i) => i.conversationId === PARENT).length).toBeGreaterThan(0);
  });
});

describe("planning mode draft", () => {
  test("agy 1.4's write_file with Path is seen as a planning draft too", () => {
    const { rt } = runtime();
    const dir = join(FIXTURE, "home", ".gemini", "antigravity-cli", "brain", PARENT);
    const target = join(dir, "implementation_plan.md");
    const base = { conversationId: PARENT, workspacePaths: [], transcriptPath: "", artifactDirectoryPath: dir, modelName: "gemini-3.8-flash-high" };
    rt.observe("cli", { ...base, event: "PreToolUse", toolCall: { name: "write_file", args: { Content: "# plan", Path: target } }, stepIdx: 3 });
    const r = rt.preInvocation("cli", { ...base, event: "PreInvocation", invocationNum: 1, initialNumSteps: 0 });
    expect(JSON.stringify(r)).toContain(`Planning mode wrote ${target}.`);
  });


  test("a write of implementation_plan.md into the artifact directory is offered as a draft to register", () => {
    const { rt } = runtime();
    const dir = join(FIXTURE, "home", ".gemini", "antigravity-cli", "brain", PARENT);
    const write: HookPayload = {
      event: "PreToolUse",
      conversationId: PARENT,
      workspacePaths: [],
      transcriptPath: "",
      artifactDirectoryPath: dir,
      modelName: "gemini-3.8-flash-high",
      toolCall: { name: "write_to_file", args: { TargetFile: join(dir, "implementation_plan.md") } },
      stepIdx: 3,
    };
    rt.observe("cli", write);
    const r = rt.preInvocation("cli", { event: "PreInvocation", conversationId: PARENT, workspacePaths: [], transcriptPath: "", artifactDirectoryPath: dir, modelName: "gemini-3.8-flash-high", invocationNum: 1, initialNumSteps: 0 });
    expect(r).toEqual({
      injectSteps: [
        {
          type: "ephemeralMessage",
          text: `${INTENT_DIRECTIVE}\n\nPlanning mode wrote ${join(dir, "implementation_plan.md")}. Before carrying it out, call register_intent_plan with the tools that plan uses as steps.`,
        },
      ],
    });
  });
});
