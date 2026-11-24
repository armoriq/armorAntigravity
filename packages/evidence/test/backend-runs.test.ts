import { expect, test } from "bun:test";
import { parseRunsReply, postRunsBatch } from "../src/io/backend-runs.ts";
import { login, uploads } from "./support.ts";
import type { RunReport } from "@armorantigravity/core";

const reports: RunReport[] = [1, 2, 3, 4].map(report_seq => ({ run_id: "same", report_seq, session_id: "s", started_at: "2026-11-15T00:00:00Z", tool_calls: 0, gated_tool_calls: 0, plan_ids: [] }));
test.each([400, 422, 403])("runs settle usable per report outcomes on HTTP %s", status => {
  expect(parseRunsReply(status, { results: [{ run_id: "same", report_seq: 1, outcome: "rejected", error: "invalid_report" }] }, new Headers(), [reports[0]!])).toMatchObject({ ok: true, rejected: [{ item: reports[0], permanent: true }] });
});
test("run outcomes match both run id and sequence and validate the whole reply", () => {
  const results = ["accepted", "stale", "duplicate", "rejected"].map((outcome, index) => ({ run_id: "same", report_seq: index + 1, outcome, error: "invalid" }));
  expect(parseRunsReply(200, { results: [...results].reverse() }, new Headers(), reports)).toMatchObject({ ok: true, rejected: [{ item: reports[3], permanent: true }] });
  for (const body of [{ results: [results[0], results[0]] }, { results: [{ ...results[0], run_id: "other" }] }, { results: [{ ...results[0], outcome: "retryable" }] }, { written: 4 }])
    expect(parseRunsReply(200, body, new Headers(), reports).ok).toBe(false);
  expect(parseRunsReply(200, { results: [results[0]] }, new Headers(), reports)).toMatchObject({ ok: true, rejected: [{ item: reports[1] }, { item: reports[2] }, { item: reports[3] }] });
  expect(parseRunsReply(401, {}, new Headers(), reports)).toMatchObject({ ok: false, relogin: true });
  expect(parseRunsReply(429, {}, new Headers({ "retry-after": "3" }), reports)).toMatchObject({ ok: false, retryAfterMs: 3000 });
});

test("runs use the report envelope and authenticated client headers", async () => {
  const original = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (url, options) => {
    expect(String(url)).toBe("http://localhost:1/iap/runs/batch");
    expect(new Headers(options?.headers).get("X-API-Key")).toBe("test");
    expect(new Headers(options?.headers).get("X-ArmorIQ-Client")).toContain("armorantigravity");
    body = JSON.parse(String(options?.body));
    return Response.json({ results: reports.map(r => ({ run_id: r.run_id, report_seq: r.report_seq, outcome: "accepted" })) });
  }) as typeof fetch;
  try {
    expect((await postRunsBatch(login("http://localhost:1", { apiKey: "test" }), uploads(() => null), reports)).ok).toBe(true);
    expect(body).toEqual({ reports });
  } finally { globalThis.fetch = original; }
});
