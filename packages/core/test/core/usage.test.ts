import { describe, expect, test } from "bun:test";
import {
  bucketByHour,
  changedBuckets,
  hourKey,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_SNAPSHOTS,
  packBatches,
  splitParts,
  titleFromSession,
  toParts,
  toSnapshots,
  type UsageSnapshot,
} from "../../src/core/usage.ts";
import { stepUsageFromTokens } from "../support/step-usage.ts";
import type { SessionID, StepTokens } from "../../src/types.ts";

const part = (id: string, tokens: Partial<Pick<StepTokens, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">>, messageID = "msg_1", sessionID = "ses_1") => ({
  partId: id,
  sessionId: sessionID as SessionID,
  messageId: messageID,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...tokens,
});
const models: Record<string, string> = { msg_1: "anthropic/claude-sonnet-5", msg_2: "openai/gpt-5" };
const modelOf = (id: string) => models[id] ?? null;
const at = (iso: string) => Date.parse(iso);

describe("stepUsage", () => {
  test("maps step tokens and counts reasoning as output, as ArmorCodex does", () => {
    const step = stepUsageFromTokens(
      part("prt_1", { input: 100, output: 20, reasoning: 5, cacheRead: 300, cacheWrite: 40 }),
      modelOf,
      "/repo",
      at("2026-10-11T10:00:00Z"),
    );
    expect(step).toEqual({
      sessionId: "ses_1" as any,
      messageId: "msg_1",
      partId: "prt_1",
      at: at("2026-10-11T10:00:00Z"),
      repo: "/repo",
      entry: { model: "anthropic/claude-sonnet-5", inputTokens: 100, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 40 },
      reasoningTokens: 5,
    });
  });

  test("rejects zero and invalid usage; unknown model stays countable", () => {
    expect(stepUsageFromTokens(part("p", { input: 0, output: 0 }), modelOf, "r")).toBeNull();
    expect(stepUsageFromTokens(part("p", { input: -5, output: Number.NaN }), modelOf, "r")).toBeNull();
    expect(stepUsageFromTokens(part("p", { input: 3 }, "msg_9"), modelOf, "r")?.entry.model).toBe("unknown");
  });
});

describe("bucketByHour", () => {
  test("splits a session at the UTC hour boundary and sums per model", () => {
    const steps = [
      stepUsageFromTokens(part("a", { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }), modelOf, "/r", at("2026-10-11T10:59:59Z"))!,
      stepUsageFromTokens(part("b", { input: 20, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0 }, "msg_2"), modelOf, "/r", at("2026-10-11T11:00:00Z"))!,
      stepUsageFromTokens(part("c", { input: 30, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 7 }), modelOf, "/r", at("2026-10-11T11:30:00Z"))!,
    ];
    const buckets = bucketByHour(steps);
    expect(buckets.map((b) => [hourKey(b), b.entries])).toEqual([
      ["2026-10-11T10", [{ model: "anthropic/claude-sonnet-5", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]],
      [
        "2026-10-11T11",
        [
          { model: "anthropic/claude-sonnet-5", inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 7 },
          { model: "openai/gpt-5", inputTokens: 20, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 },
        ],
      ],
    ]);
    expect(bucketByHour([...steps].reverse()).map((b) => b.digest)).toEqual(buckets.map((b) => b.digest));
    expect(changedBuckets(buckets, { [hourKey(buckets[0]!)]: buckets[0]!.digest })).toEqual([buckets[1]!]);
  });
});

describe("packBatches", () => {
  test("every batch stays inside the snapshot, entry and byte limits", () => {
    const entry = (m: number) => ({ model: `m${m}`, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const many: UsageSnapshot[] = Array.from({ length: 250 }, (_, i) => ({
      sessionId: `ses_${i}`,
      usageDate: "2026-10-11",
      usageHour: 1,
      revision: 1,
      armored: true,
      repo: "x".repeat(200),
      entries: Array.from({ length: 1 + (i % 7) }, (_, m) => entry(m)),
    }));
    const batches = packBatches(many.map((s) => ({ snapshots: [s], calls: [], sessions: [] })));
    expect(batches.flatMap((b) => b.snapshots)).toEqual(many);
    for (const b of batches) {
      expect(b.snapshots.length).toBeLessThanOrEqual(MAX_BATCH_SNAPSHOTS);
      expect(b.snapshots.reduce((n, s) => n + s.entries.length, 0)).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
      expect(Buffer.byteLength(JSON.stringify({ generation: "g", batchId: "b", ...b }))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  test("snapshots carry armored, a bounded repo and the revision", () => {
    const [b] = bucketByHour([stepUsageFromTokens(part("a", { input: 1 }), modelOf, "r".repeat(500), 0)!]);
    const [s] = toSnapshots([b!], 7);
    expect(s).toMatchObject({ sessionId: "ses_1", usageDate: "1970-01-01", usageHour: 0, revision: 7, armored: true });
    expect(s!.repo).toHaveLength(200);
  });

  test("a repo cut at the limit never ends in half of a surrogate pair", () => {
    const repo = `${"r".repeat(199)}\u{1F600}tail`;
    const [b] = bucketByHour([stepUsageFromTokens(part("a", { input: 1 }), modelOf, repo, 0)!]);
    const [s] = toSnapshots([b!], 1);
    expect(s!.repo).toBe("r".repeat(199));
    expect(s!.repo!.isWellFormed()).toBe(true);
  });
});

describe("call records", () => {
  const stepAt = (id: string, iso: string, sessionID = "ses_1") =>
    stepUsageFromTokens(part(id, { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 3 }, "msg_1", sessionID), modelOf, "/repo", at(iso))!;
  const snapshotOf = (steps: ReturnType<typeof stepAt>[]) => toSnapshots(bucketByHour(steps), 1);

  test("each step is one record, keyed by message and part, beside its own hour's snapshot", () => {
    const steps = [stepAt("prt_1", "2026-10-11T10:59:59Z"), stepAt("prt_2", "2026-10-11T11:00:00Z")];
    const parts = toParts(snapshotOf(steps), steps);
    expect(parts.map((p) => [p.snapshots.map(hourKey), p.calls.flatMap((c) => c.records.map((r) => r.key))])).toEqual([
      [["2026-10-11T10"], ["msg_1:prt_1"]],
      [["2026-10-11T11"], ["msg_1:prt_2"]],
    ]);
    expect(parts[0]!.calls).toEqual([
      {
        sessionId: "ses_1",
        armored: true,
        repo: "/repo",
        records: [
          {
            key: "msg_1:prt_1",
            model: "anthropic/claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 3,
            reasoningOutputTokens: 1,
            occurredAt: "2026-10-11T10:59:59.000Z",
          },
        ],
      },
    ]);
  });

  test("records of an hour with no changed snapshot travel without one", () => {
    const steps = [stepAt("prt_1", "2026-10-11T10:00:00Z"), stepAt("prt_2", "2026-10-11T11:00:00Z")];
    const parts = toParts(snapshotOf([steps[1]!]), steps);
    expect(parts.map((p) => [p.snapshots.length, p.calls[0]!.records.map((r) => r.key)])).toEqual([
      [1, ["msg_1:prt_2"]],
      [0, ["msg_1:prt_1"]],
    ]);
  });

  test("an hour with more records than one batch holds is split, and every batch stays inside the call limit", () => {
    const steps = Array.from({ length: 600 }, (_, i) => stepAt(`prt_${i}`, "2026-10-11T10:30:00Z"));
    const batches = packBatches(toParts(snapshotOf(steps), steps));
    expect(batches.map((b) => [b.snapshots.length, b.calls.reduce((n, c) => n + c.records.length, 0)])).toEqual([
      [1, MAX_BATCH_ENTRIES],
      [0, 100],
    ]);
  });

  test("a refused batch splits into one session-hour each, every record staying with its hour", () => {
    const steps = [
      stepAt("prt_1", "2026-10-11T10:10:00Z"),
      stepAt("prt_2", "2026-10-11T11:10:00Z"),
      stepAt("prt_3", "2026-10-11T12:10:00Z"),
      stepAt("prt_4", "2026-10-11T10:20:00Z", "ses_2"),
    ];
    const [batch] = packBatches(toParts(snapshotOf(steps.slice(0, 2)), steps));
    const split = splitParts(batch!);
    expect(split.map((p) => [p.snapshots.map((s) => `${s.sessionId} ${hourKey(s)}`), p.calls.flatMap((c) => c.records.map((r) => r.key))])).toEqual([
      [["ses_1 2026-10-11T10"], ["msg_1:prt_1"]],
      [["ses_1 2026-10-11T11"], ["msg_1:prt_2"]],
      [[], ["msg_1:prt_3"]],
      [[], ["msg_1:prt_4"]],
    ]);
  });
});

describe("session titles", () => {
  const info = (title: string, updated = Date.UTC(2026, 9, 12, 10, 30)) => ({ id: "ses_1", title, time: { created: 0, updated } });

  test("OpenCode's own title is sent as opencode-session-title, stamped when the plugin sees it", () => {
    expect(titleFromSession(info("Fix the usage batch", Date.UTC(2026, 9, 12, 9)), Date.UTC(2026, 9, 12, 10, 30))).toEqual({
      sessionId: "ses_1",
      title: "Fix the usage batch",
      titleSource: "opencode-session-title",
      titleUpdatedAt: "2026-10-12T10:30:00.000Z",
    });
  });

  test("OpenCode's placeholder titles, empty titles and malformed sessions are not titles", () => {
    expect(titleFromSession(info("New session - 2026-10-12T10:40:56.682Z"))).toBeNull();
    expect(titleFromSession(info("Child session - 2026-10-12T10:40:56.682Z"))).toBeNull();
    expect(titleFromSession(info("   "))).toBeNull();
    expect(titleFromSession({ id: 7, title: "x" })).toBeNull();
  });

  test("a title longer than the backend keeps is cut at 200 characters", () => {
    expect(titleFromSession(info("t".repeat(250)))!.title).toHaveLength(200);
  });

  test("a title travels in a batch of its own when no snapshot changed, and batches hold at most 100 titles", () => {
    const titles = Array.from({ length: 150 }, (_, i) => titleFromSession({ ...info(`title ${i}`), id: `ses_${i}` })!);
    const batches = packBatches(toParts([], [], titles));
    expect(batches.map((b) => [b.snapshots.length, b.calls.length, b.sessions.length])).toEqual([
      [0, 0, 100],
      [0, 0, 50],
    ]);
    expect(splitParts(batches[1]!)).toHaveLength(50);
  });
});
