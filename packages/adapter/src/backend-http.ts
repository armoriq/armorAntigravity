import type { Login } from "./core-contract.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type BackendAccess = {
  readonly login: Login;
  // X-ArmorIQ-Client value, e.g. "armorantigravity/0.1.0".
  readonly client: string;
};

export type BackendResult = { ok: true; status: number; data: unknown; headers: Headers } | { ok: false; status: number | null; reason: string };

const TIMEOUT_MS = 8000;

// Scanned rather than `.replace(/\/+$/, "")`, which backtracks quadratically on a
// long run of slashes.
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return end === url.length ? url : url.slice(0, end);
}

// API-key call shaped like armorClaude backend-client.mjs, with the client header PRD 4a requires on every call.
export async function backendRequest(
  access: BackendAccess,
  request: { method: "GET" | "POST"; path: string; body?: unknown; headers?: Readonly<Record<string, string>>; fetch?: Fetch; timeoutMs?: number },
): Promise<BackendResult> {
  const doFetch: Fetch = request.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(`${stripTrailingSlashes(access.login.backend)}${request.path}`, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access.login.apiKey}`,
        "X-API-Key": access.login.apiKey,
        "X-ArmorIQ-Client": access.client,
        // This build runs Monitor itself, so the backend sends the real policy and the workspace mode.
        "X-ArmorIQ-Monitor-Aware": "1",
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    const data: unknown = await res.json().catch(() => null);
    // 304 answers a conditional GET; the caller kept the body it validated.
    if (!res.ok && res.status !== 304) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, data, headers: res.headers };
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${request.timeoutMs ?? TIMEOUT_MS} ms` : String(error);
    return { ok: false, status: null, reason };
  } finally {
    clearTimeout(timer);
  }
}
