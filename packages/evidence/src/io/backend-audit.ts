import type { AuditRow, BatchAck, Login } from "@armorantigravity/core";
import type { Uploads } from "../context.ts";
import { authHeaders, isRecord, parseJson, retryAfterMs, type CallResult } from "./http.ts";

// The backend can spend 15 s on a batch (10 s budget plus a 5 s row timeout). Abandoning
// sooner makes the client resend batches the server already committed.
export const BATCH_TIMEOUT_MS = 20_000;
export const MAX_BATCH_ROWS = 200;
export const PAYLOAD_TOO_LARGE = 413;

// Rows on the wire always carry client_row_id, so a resend of a stored row is not stored again.
export type QueuedAuditRow = AuditRow & { readonly client_row_id: string };

// An index outside the batch means the ack does not describe these rows, so none counts as written.
export function parseFailures(body: unknown, rowCount: number): BatchAck["failures"] | null {
  if (!isRecord(body) || !Array.isArray(body.failures)) return null;
  const out: { index: number; error: string }[] = [];
  for (const f of body.failures) {
    if (!isRecord(f)) return null;
    const { index, error } = f;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= rowCount || typeof error !== "string") return null;
    out.push({ index, error });
  }
  return out;
}

// POST /iap/audit/batch. 200 carries per-row failures; a 2xx without them is a failed send.
export async function postAuditBatch(
  login: Login,
  uploads: Uploads,
  rows: readonly QueuedAuditRow[],
  timeoutMs = BATCH_TIMEOUT_MS,
): Promise<CallResult<BatchAck>> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${login.backend}/iap/audit/batch`, {
      method: "POST",
      headers: authHeaders(login, uploads),
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, retryable: true, reason: `audit batch request failed: ${String(error)}` };
  }
  const body = parseJson(text);
  const status = response.status;
  uploads.report(status, body);
  if (status < 200 || status >= 300) {
    const after = retryAfterMs(response.headers.get("retry-after"));
    return {
      ok: false,
      status,
      // Only 413 is about this batch, and a smaller one can pass. A whole-request 400 or 422 comes
      // from the envelope, a proxy or a DTO mismatch, so it is retried unchanged like a 5xx.
      retryable: status !== PAYLOAD_TOO_LARGE,
      ...(after === undefined ? {} : { retryAfterMs: after }),
      reason: `audit batch returned ${status}: ${text.slice(0, 200)}`,
    };
  }
  const failures = parseFailures(body, rows.length);
  if (!failures) return { ok: false, status, retryable: true, reason: `audit batch returned ${status} without a valid failures list: ${text.slice(0, 200)}` };
  const written = isRecord(body) && typeof body.written === "number" ? body.written : rows.length - failures.length;
  return { ok: true, value: { written, failures } };
}
