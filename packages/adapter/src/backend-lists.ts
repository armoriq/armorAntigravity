import { canonicalToolName, isRecord, type MapOptions } from "./tools.ts";

export type BackendToolLists = {
  readonly deniedTools: ReadonlySet<string>;
  readonly heldTools: ReadonlySet<string>;
};

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Reads `policy_validation` from the token response as armorOpenCode
// src/io/backend-intent.ts does. validated:false means the org has no agent or
// no active v2 policy, and the backend then lists every requested tool as
// denied (conmap-auto plan-check.service.ts `unvalidated`). That is "no
// opinion", not a deny, so both lists are emptied.
//
// The backend echoes the plan's step names, which may be Antigravity,
// ArmorClaude or OpenCode spellings, so each name is kept as sent and also in
// its canonical form.
export function backendToolLists(policyValidation: unknown, options: MapOptions = {}): BackendToolLists {
  const validation = isRecord(policyValidation) ? policyValidation : {};
  if (validation.validated === false) return { deniedTools: new Set(), heldTools: new Set() };
  const canon = (names: string[]) => new Set(names.flatMap((n) => [n, canonicalToolName(n, options)]));
  return { deniedTools: canon(stringList(validation.denied_tools)), heldTools: canon(stringList(validation.held_tools)) };
}
