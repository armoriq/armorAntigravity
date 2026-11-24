import { createHash } from "node:crypto";
import type { PendingRequest } from "./registry.ts";
import { AGENT_ID, type Draft, type Login } from "./types.ts";

export const PLAN_SOURCE = "antigravity-registered";

// RFC 8785 uses UTF 16 key order and ECMAScript number and string encoding.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("invalid JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${canonicalJson(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("value is outside JSON");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const planHash = (plan: unknown): string => sha256(canonicalJson(plan));

interface KeyInput {
  readonly kind: string;
  readonly promptId?: string;
  readonly parentPlanId?: string | null;
  readonly planHash?: string;
  readonly countedPlanId?: string;
  readonly tokenExpiresAt?: string;
  readonly epoch?: number;
}

export function requestKey(input: KeyInput): string {
  const parts = input.kind === "refresh"
    ? ["refresh", input.countedPlanId, input.tokenExpiresAt]
    : [input.kind, input.promptId, input.parentPlanId ?? "", input.planHash];
  if (input.kind !== "refresh" && (input.epoch ?? 0) > 0) parts.push(`epoch:${input.epoch}`);
  if (parts.some(p => typeof p !== "string")) throw new Error("missing plan request identity");
  return `pcc1:${sha256(parts.join("\n"))}`;
}

export function planRequest(input: KeyInput, body: Record<string, unknown>): PendingRequest {
  const key = requestKey(input);
  const headers: Record<string, string> = { "Idempotency-Key": key, "X-ArmorIQ-Plan-Kind": input.kind };
  if (input.promptId) headers["X-ArmorIQ-Prompt-Id"] = input.promptId;
  const parent = input.kind === "refresh" ? input.countedPlanId : input.kind === "revision" ? input.parentPlanId : null;
  if (parent) headers["X-ArmorIQ-Parent-Plan-Id"] = parent;
  return { key, headers, body: JSON.parse(canonicalJson(body)) };
}

export function toSdkPlan(plan: Pick<Draft, "goal" | "steps">): { goal: string; steps: Record<string, unknown>[]; metadata: Record<string, unknown> } {
  return {
    goal: plan.goal,
    steps: plan.steps.map(s => ({ action: s.tool, tool: s.tool, mcp: AGENT_ID, description: s.action, metadata: s.params ? { inputs: s.params } : {} })),
    metadata: { goal: plan.goal, source: PLAN_SOURCE },
  };
}

export function requestBody(login: Login, plan: Draft, contextId: string, validity: number, policy?: Record<string, unknown>): Record<string, unknown> {
  return { user_id: login.userId, agent_id: AGENT_ID, context_id: contextId, plan: toSdkPlan(plan), expires_in: validity, ...(policy ? { policy } : {}) };
}

export function intentValiditySeconds(env: Readonly<Record<string, string | undefined>> = {}, local = 3600): number {
  const raw = env.ARMORIQ_INTENT_VALIDITY_SECONDS;
  const seconds = raw === undefined ? local : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(seconds) || seconds < 180 || seconds > 3600) throw new Error("ARMORIQ_INTENT_VALIDITY_SECONDS must be an integer from 180 to 3600");
  return seconds;
}
