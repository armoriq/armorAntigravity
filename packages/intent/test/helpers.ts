import { createOwnTools } from "../src/own-tools.ts";
import { createRegistry } from "../src/registry.ts";
import type { AuditRow, CallResult, Draft, IntentBackend, Login, Minted, PolicyView } from "../src/types.ts";

export const LOGIN: Login = { backend: "http://backend.test", apiKey: "ak_test_x", userId: "user-1" };

export const silentLog = { info() {}, warn() {}, error() {} };

export const permitAll: PolicyView = {
  hash: "policy-hash",
  intentRequired: true,
  evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }),
};

export type MintCall = { contextId: string; goal: string; tools: string[] };

// Records what the registry asked the backend for; each mint resolves when `release` is called if gated.
export function recordingBackend(opts: { gate?: boolean; now?: () => number } = {}) {
  const mints: MintCall[] = [];
  const reanchors: { planId: string; reason: string }[] = [];
  const revokes: { planId: string; reason: string }[] = [];
  const gates: (() => void)[] = [];
  let next = 0;
  const backend: IntentBackend = {
    async mint(_login: Login, plan: Draft, contextId: string): Promise<CallResult<Minted>> {
      mints.push({ contextId, goal: plan.goal, tools: plan.steps.map((s) => s.tool) });
      if (opts.gate) await new Promise<void>((r) => gates.push(r));
      next += 1;
      return {
        ok: true,
        value: {
          planId: `plan-${next}`,
          token: { status: "active", jwt: "jwt", expiresAt: (opts.now ?? Date.now)() + 3_600_000, deniedTools: new Set(), heldTools: new Set() },
        },
      };
    },
    async reanchor(_login, planId, _plan, reason) {
      reanchors.push({ planId, reason });
      return { ok: true, value: { trustId: "trust-1" } };
    },
    async revoke(_login, planId, reason) {
      revokes.push({ planId, reason });
      return { ok: true, value: undefined };
    },
    async delegate() {
      return { ok: true, value: { trustId: "trust-d", subtreeRoot: "root-hash", inclusionProofLength: 2 } };
    },
  };
  return { backend, mints, reanchors, revokes, release: () => gates.splice(0).forEach((r) => r()) };
}

export function harness(opts: { gate?: boolean; login?: Login | null; policy?: PolicyView } = {}) {
  const registry = createRegistry();
  const rec = recordingBackend({ gate: opts.gate ?? false });
  const audit: AuditRow[] = [];
  const login = opts.login === undefined ? LOGIN : opts.login;
  const tools = createOwnTools({
    registry,
    backend: rec.backend,
    login: () => login,
    mode: () => (login ? "enforce" : "monitor"),
    policy: () => opts.policy ?? permitAll,
    audit: (row) => audit.push(row),
    log: silentLog,
  });
  return { registry, tools, audit, ...rec };
}
