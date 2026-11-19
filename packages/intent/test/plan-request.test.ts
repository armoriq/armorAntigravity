import { describe, expect, test } from "bun:test";
import { canonicalJson, intentValiditySeconds, planHash, planRequest, requestKey } from "../src/plan-request.ts";
import contract from "./fixtures/plan-capture-v1.json";

describe("plan capture fixture vectors", () => {
  for (const v of contract.canonicalJson) test(`canonical JSON: ${v.name}`, () => expect(canonicalJson(v.input)).toBe(v.expected));
  for (const v of contract.planHash) test(`plan hash: ${v.name}`, () => expect(planHash(v.plan)).toBe(v.expected));
  for (const v of contract.idempotencyKey) test(`request key: ${v.name}`, () => expect(requestKey(v.input)).toBe(v.expected));
  test("a retirement epoch never changes refresh keys", () => {
    const input = { kind: "refresh", countedPlanId: "parent", tokenExpiresAt: "2030-01-01T00:00:00.000Z" };
    expect(requestKey({ ...input, epoch: 2 })).toBe(requestKey(input));
  });
  for (const entry of contract.parserCases) {
    const parsed = "ok" in entry.expect ? entry.expect.ok : null;
    if (!parsed || parsed.kind === "unknown") continue;
    test(`generated headers satisfy the parser contract: ${entry.name}`, () => {
      const request = planRequest({
        kind: parsed.kind, ...(parsed.promptId ? { promptId: parsed.promptId } : {}),
        parentPlanId: parsed.parentPlanId, ...(parsed.parentPlanId ? { countedPlanId: parsed.parentPlanId } : {}),
        planHash: "hash", tokenExpiresAt: "2030-01-01T00:00:00.000Z",
      }, { plan: {} });
      expect(request.headers[contract.headers.kind]).toBe(parsed.kind);
      expect(request.headers[contract.headers.parentPlanId] ?? null).toBe(parsed.parentPlanId);
      expect(request.headers[contract.headers.promptId] ?? null).toBe(parsed.promptId);
      const key = request.headers[contract.headers.idempotencyKey]!;
      expect(key).toMatch(/^[A-Za-z0-9:_.-]{1,128}$/);
      const promptId = request.headers[contract.headers.promptId];
      if (promptId) expect(promptId).toMatch(/^[A-Za-z0-9:_.-]{1,128}$/);
      if (parsed.kind === "new") expect(parsed.parentPlanId).toBeNull();
      else expect(parsed.parentPlanId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      if (parsed.kind !== "refresh") expect(promptId).toBeString();
    });
  }
  test("headers and wire kinds follow the shared contract", () => {
    for (const kind of contract.kinds.wire) {
      const r = planRequest({ kind, promptId: "prompt", parentPlanId: "parent", countedPlanId: "parent", tokenExpiresAt: "2030-01-01T00:00:00.000Z", planHash: "hash" }, { plan: {} });
      expect(r.headers[contract.headers.kind]).toBe(kind);
      expect(r.headers[contract.headers.promptId]).toBe("prompt");
      expect(r.headers[contract.headers.idempotencyKey]).toBe(r.key);
      expect(r.headers[contract.headers.parentPlanId]).toBe(kind === "new" ? undefined : "parent");
    }
  });
  test("the descriptor detaches mutable arguments", () => {
    const body = { plan: { goal: "first" } };
    const r = planRequest({ kind: "new", promptId: "p", planHash: "h" }, body);
    body.plan.goal = "changed";
    expect(r.body).toEqual({ plan: { goal: "first" } });
  });
  test.each([NaN, Infinity, undefined, "\ud800", { a: undefined }])("rejects values outside canonical JSON: %p", value => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe("intent validity", () => {
  test("defaults to 3600 and the shared variable wins over the local knob", () => {
    expect(intentValiditySeconds({})).toBe(3600);
    expect(intentValiditySeconds({}, 600)).toBe(600);
    expect(intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: "180" }, 600)).toBe(180);
    expect(intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: "3600" })).toBe(3600);
  });
  test.each(["", "179", "3601", "1.8e2", "180.5", "bad", " 180"])('refuses invalid value "%s"', raw => {
    expect(() => intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: raw })).toThrow("ARMORIQ_INTENT_VALIDITY_SECONDS");
  });
});
