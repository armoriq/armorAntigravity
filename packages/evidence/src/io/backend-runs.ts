import type { RunReport } from "@armorantigravity/core";
import { runTransportId } from "@armorantigravity/core";
import type { Login } from "@armorantigravity/core";
import { BATCH_TIMEOUT_MS } from "./backend-audit.ts";
import type { Uploads } from "../context.ts";
import { authHeaders, retryAfterMs as parseRetryAfter } from "./http.ts";
import type { SendResult } from "@armorantigravity/core";
import type { ReportingResult } from "./reporting-delivery.ts";

// A malformed list acknowledges nothing. Missing entries retry independently of accepted entries.
export function parseRunsReply(status: number, body: unknown, headers: Headers, reports: readonly RunReport[], now = Date.now()): ReportingResult<RunReport> {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), now);
  const failed = (reason: string): Extract<SendResult<RunReport>, { ok: false }> => ({ ok: false, endpointStatus: status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason,
    stallReason: status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "backend_unreachable" });
  if (status === 404) return failed("runs endpoint unavailable");
  if (status === 403 && (body as { error?: unknown } | null)?.error === "org_required") return { ok: false, hold: "org_required", reason: "org_required", endpointStatus: status };
  const unauthorized = (): SendResult<RunReport> => ({ ok: false, endpointStatus: status, relogin: true, reason: "runs authentication refused", stallReason: "auth_paused" });
  if (status === 401) return unauthorized();
  const hasResults = body !== null && typeof body === "object" && Object.hasOwn(body, "results");
  if (!hasResults) {
    if (status === 403) return unauthorized();
    if (status === 400 || status === 422) return { ...failed(`runs returned ${status}`), ok: false, legacyRefusal: true };
    const inProgress = status === 409 && (body as { error?: unknown } | null)?.error === "request_in_progress";
    return { ...failed(`runs returned ${status} without a valid results list`),
      nonTransient: status >= 400 && status < 500 && ![408, 429].includes(status) && !inProgress, tooLarge: status === 413 };
  }
  const results = body && typeof body === "object" ? (body as { results?: unknown }).results : null;
  const sent = new Set(reports.map(runTransportId));
  const seen = new Set<string>();
  if (!Array.isArray(results) || !results.every((result: unknown) => {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    if (typeof r.run_id !== "string" || !Number.isSafeInteger(r.report_seq) ||
        !["accepted", "stale", "duplicate", "rejected"].includes(String(r.outcome)) || (r.error !== undefined && typeof r.error !== "string")) return false;
    const id = runTransportId(r as unknown as RunReport);
    if (!sent.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  })) return status === 403 ? unauthorized() : failed("runs returned an invalid results list");
  const outcomes = new Map(results.map((result: { run_id: string; report_seq: number; outcome: string; error?: string }) => [runTransportId(result), result]));
  return { ok: true, endpointStatus: status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), rejected: reports.flatMap(item => {
    const result = outcomes.get(runTransportId(item));
    return result && result.outcome !== "rejected" ? [] : [{ item, error: result?.error ?? "missing run outcome", permanent: result?.outcome === "rejected", transient: result?.outcome !== "rejected" }];
  }) };
}

export async function postRunsBatch(login: Login, uploads: Uploads, reports: readonly RunReport[], timeoutMs = BATCH_TIMEOUT_MS): Promise<ReportingResult<RunReport>> {
  try {
    const response = await fetch(`${login.backend}/iap/runs/batch`, {
      method: "POST", headers: authHeaders(login, uploads), body: JSON.stringify({ reports }), signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try { body = await response.json(); } catch {}
    uploads.report(response.status, body);
    return parseRunsReply(response.status, body, response.headers, reports);
  } catch {
    return { ok: false, reason: "runs request failed", stallReason: "backend_unreachable" };
  }
}
