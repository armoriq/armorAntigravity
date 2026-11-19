import { CLIENT_EVENTS, type ClientEvent, type Login, type SendResult, type StallReason } from "@armorantigravity/core";
import type { Uploads } from "../context.ts";
import { BATCH_TIMEOUT_MS } from "./backend-audit.ts";
import { authHeaders, parseJson, retryAfterMs as parseRetryAfter } from "./http.ts";
import type { ReportingResult } from "./reporting-delivery.ts";

// Validate the complete list before acknowledging any event. There is no legacy aggregate reply.
export function parseClientEventsReply(status: number, body: unknown, headers: Headers, events: readonly ClientEvent[], now = Date.now()): ReportingResult<ClientEvent> {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), now);
  const delay = retryAfterMs === undefined ? {} : { retryAfterMs };
  const stallReason: StallReason = status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "backend_unreachable";
  const failed = (reason: string): Extract<SendResult<ClientEvent>, { ok: false }> => ({ ok: false, endpointStatus: status, ...delay, stallReason, reason });
  const unauthorized = (): SendResult<ClientEvent> => ({ ok: false, endpointStatus: status, relogin: true, stallReason: "auth_paused", reason: "client events authentication refused" });
  if (status === 404) return failed("client events endpoint unavailable");
  if (status === 401) return unauthorized();
  if (status === 403 && (body as { error?: unknown } | null)?.error === "org_required") return { ok: false, hold: "org_required", reason: "org_required", endpointStatus: status };
  if (body && typeof body === "object" && Object.hasOwn(body, "results")) {
    const results = (body as { results: unknown }).results;
    const sent = new Set(events.map(event => event.event_id));
    const seen = new Set<string>();
    if (!Array.isArray(results) || !results.every(result => {
      if (!result || typeof result !== "object" || typeof result.event_id !== "string" || !sent.has(result.event_id) || seen.has(result.event_id) ||
          !(CLIENT_EVENTS.outcomes as readonly unknown[]).includes(result.outcome) || (result.error !== undefined && typeof result.error !== "string")) return false;
      seen.add(result.event_id);
      return true;
    })) return status === 403 ? unauthorized() : failed("client events returned an invalid results list");
    const outcomes = new Map(results.map(result => [result.event_id, result]));
    return { ok: true, endpointStatus: status, ...delay, rejected: events.flatMap(item => {
      const result = outcomes.get(item.event_id);
      return result?.outcome === "accepted" || result?.outcome === "duplicate" ? [] : [{ item, error: result?.error ?? result?.outcome ?? "missing event outcome", permanent: result?.outcome === "rejected", transient: result?.outcome !== "rejected" }];
    }) };
  }
  if (status === 403) return unauthorized();
  if (status === 400 || status === 422) return { ...failed(`client events returned ${status}`), legacyRefusal: true };
  const inProgress = status === 409 && (body as { error?: unknown } | null)?.error === "request_in_progress";
  return { ...failed(`client events returned ${status} without a valid results list`),
    nonTransient: status >= 400 && status < 500 && ![408, 429].includes(status) && !inProgress, tooLarge: status === 413 };
}

export async function postClientEvents(login: Login, uploads: Uploads, events: readonly ClientEvent[], timeoutMs = BATCH_TIMEOUT_MS): Promise<ReportingResult<ClientEvent>> {
  try {
    const response = await fetch(`${login.backend}/iap/client-events`, {
      method: "POST", headers: authHeaders(login, uploads), body: JSON.stringify({ events }), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = parseJson(await response.text());
    uploads.report(response.status, body);
    return parseClientEventsReply(response.status, body, response.headers, events);
  } catch {
    return { ok: false, stallReason: "backend_unreachable", reason: "client events request failed" };
  }
}
