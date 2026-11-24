import { toAuditRow as upstreamAuditRow, snapshotAuditContext, type AuditInput as UpstreamInput } from "./core/audit.ts";
import type { ProductConfig } from "./product.ts";
import type { AuditRow } from "./types.ts";

export { clientRowId, DECISION_CODES, fallbackAuditRow, snapshotAuditContext, type AuditSnapshot } from "./core/audit.ts";
export type AuditProduct = Pick<ProductConfig, "slug" | "agentId" | "childSessionKey">;
export type AuditInput = Omit<UpstreamInput, "userId" | "userEmail" | "capability"> & {
  userId?: string | undefined;
  userEmail?: string | undefined;
  capability?: UpstreamInput["capability"] | undefined;
};

export function toAuditRow(input: AuditInput, product: AuditProduct): AuditRow {
  const snapshot = input.snapshot ?? snapshotAuditContext(input.session!, input.root!, input.decision);
  const { userId, userEmail, capability, ...captured } = input;
  const row = upstreamAuditRow({ ...captured, ...(userId === undefined ? {} : { userId }), ...(userEmail === undefined ? {} : { userEmail }), ...(capability === undefined ? {} : { capability }) });
  row.agent_id = product.agentId;
  row.client_id = product.slug;
  // A subagent's rows carry the root session id; the child id rides along so the run stays traceable.
  if (snapshot.sessionId !== snapshot.rootSessionId) {
    delete row.input._opencode_session;
    row.input[product.childSessionKey] = snapshot.sessionId;
  }
  return row;
}
