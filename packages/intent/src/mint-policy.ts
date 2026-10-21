import { CLIENT_ID, type PolicyEffect } from "./types.ts";

export interface MintPolicyStatement {
  readonly effect: PolicyEffect;
  readonly action: { readonly eq?: string; readonly in?: readonly string[] };
}

export interface MintPolicyIr<S extends MintPolicyStatement = MintPolicyStatement> {
  readonly schemaVersion: string;
  readonly statements: readonly S[];
}

const actionValues = (action: MintPolicyStatement["action"]): readonly string[] =>
  typeof action.eq === "string" ? [action.eq] : Array.isArray(action.in) ? action.in.filter((v) => typeof v === "string") : ["*"];

const unique = (values: readonly string[]) => [...new Set(values.filter((v) => v.trim()))];

// ArmorClaude policy-compiler.mjs compilePolicyForSdkIntent. The local IR is already enforced before the
// mint, so the CSRG token policy allows every plan path and carries the statements for the backend.
export function compileMintPolicy<S extends MintPolicyStatement>(ir: MintPolicyIr<S>, policyHash: string): Record<string, unknown> {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const statement of ir.statements) {
    if (statement.effect === "forbid") denied.push(...actionValues(statement.action));
    else allowed.push(...actionValues(statement.action));
  }
  return {
    allow: ["*"],
    deny: [],
    allowed_tools: unique(allowed),
    denied_tools: unique(denied),
    statements: ir.statements,
    metadata: { source: CLIENT_ID, schemaVersion: ir.schemaVersion, policyHash },
  };
}
