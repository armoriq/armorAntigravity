import type { Login } from "@armorantigravity/core";
import type { Uploads } from "../context.ts";

export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly retryable: boolean; readonly retryAfterMs?: number; readonly reason: string; readonly status?: number };

export function authHeaders(login: Login, uploads: Uploads): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${login.apiKey}`,
    "X-API-Key": login.apiKey,
    ...uploads.headers,
  };
}

export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
