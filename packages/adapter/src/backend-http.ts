import type { Login } from "./core-contract.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type BackendAccess = {
  readonly login: Login;
  // X-ArmorIQ-Client value, e.g. "armorantigravity/0.1.0".
  readonly client: string;
};

export type BackendResult = { ok: true; status: number; data: unknown } | { ok: false; status: number | null; reason: string };

const TIMEOUT_MS = 8000;

// API-key call shaped like armorClaude backend-client.mjs, with the client header PRD 4a requires on every call.
export async function backendRequest(
  access: BackendAccess,
  request: { method: "GET" | "POST"; path: string; body?: unknown; fetch?: Fetch; timeoutMs?: number },
): Promise<BackendResult> {
  const doFetch: Fetch = request.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(`${access.login.backend.replace(/\/+$/, "")}${request.path}`, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access.login.apiKey}`,
        "X-API-Key": access.login.apiKey,
        "X-ArmorIQ-Client": access.client,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, data };
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${request.timeoutMs ?? TIMEOUT_MS} ms` : String(error);
    return { ok: false, status: null, reason };
  } finally {
    clearTimeout(timer);
  }
}
