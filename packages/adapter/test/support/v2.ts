import { compile, parseYaml, type PolicyDocument } from "@armoriq/policy-ir";
import { parseBundleAgent, type PolicyBundle, type V2Agent } from "../../src/policy-v2.ts";

export const ORG = 'org: "*"';
export const AGENT = "agent: armorantigravity";
export const APPROVAL = "  approvalDefaults: {approvers: 1, roles: [admin]}\n";

// Compiled by policy-ir exactly as conmap compiles a v2 YAML policy.
export function doc(policyId: string, target: string, rules: string, toolsDefault = "allow", extra = ""): PolicyDocument {
  const yaml = `apiVersion: armor.io/v2\nkind: Policy\nmetadata:\n  name: ${policyId}\n  orgId: 11111111-1111-4111-8111-111111111111\ntarget:\n  ${target}\nspec:\n  tools:\n    default: ${toolsDefault}\n    rules:\n${rules}${extra}`;
  const parsed = parseYaml(yaml);
  if (!parsed.source) throw new Error(JSON.stringify(parsed.diagnostics));
  const result = compile(parsed.source, [], { policyId });
  if (!result.document) throw new Error(JSON.stringify(result.diagnostics));
  return result.document;
}

export type Entry = { policyId: string; name: string; document: PolicyDocument; targetType: "org" | "agent"; status: "active" | "shadow" };
export const entry = (name: string, targetType: Entry["targetType"], status: Entry["status"], document: PolicyDocument): Entry => ({ policyId: `id-${name}`, name, document, targetType, status });

// conmap feat/policy-v2-org-target PolicyBundleService: one entry per requested agent.
export const bundleOf = (policies: Entry[], extra: Record<string, unknown> = {}) => ({
  orgId: "org-1",
  agents: [{ agentId: "armorantigravity", name: "armorantigravity", registeredName: null, registered: false, inactive: false, policy: null, policies: policies.map((p) => ({ ...p, policyHash: `sha256:${p.name}` })), tools: [], members: [], ...extra }],
});

export const agentOf = (policies: Entry[], extra: Record<string, unknown> = {}): V2Agent => {
  const a = parseBundleAgent(bundleOf(policies, extra), "armorantigravity");
  if (!a) throw new Error("no agent");
  return a;
};

export const fixedBundle = (policies: Entry[]): PolicyBundle => {
  const agent = agentOf(policies);
  return { current: () => agent, refresh: async () => ({ kind: "unchanged" }), stop() {} };
};
