import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookPayload } from "@armorantigravity/protocol";
import { checkIntent } from "../src/decision.ts";
import { INTENT_DIRECTIVE } from "../src/directive.ts";
import { createIntentRuntime } from "../src/runtime.ts";
import { LOGIN, permitAll, recordingBackend, silentLog } from "./helpers.ts";

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

function runtime(opts: { mode?: "enforce" | "monitor"; fileExists?: (p: string) => boolean } = {}) {
  const rec = recordingBackend();
  const rt = createIntentRuntime({
    client: { product: "armorantigravity", version: "0.0.0" },
    login: () => (opts.mode === "monitor" ? null : LOGIN),
    mode: () => opts.mode ?? "enforce",
    policy: () => permitAll,
    mintPolicy: () => undefined,
    audit: () => {},
    log: silentLog,
    backend: rec.backend,
    ...(opts.fileExists ? { fileExists: opts.fileExists } : {}),
  });
  return { rt, rec };
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
    expect(rt.root({ surface: "cli", conversationId: PARENT })?.turn).toBe(2);
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

describe("unlinked subagent", () => {
  test("gets no directive while its link file has not appeared, so it is never told to register its own plan", async () => {
    const { rt } = runtime({ fileExists: () => false });
    const injected = await replay(rt);
    expect(injected.filter((i) => i.conversationId === CHILD)).toEqual([]);
    expect(injected.filter((i) => i.conversationId === PARENT).length).toBeGreaterThan(0);
  });
});

describe("planning mode draft", () => {
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
