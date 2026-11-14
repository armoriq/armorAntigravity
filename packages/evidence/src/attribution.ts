import type { AuditRow } from "@armorantigravity/core";
import type { Surface } from "@armorantigravity/protocol";
import { AGENT_ID, PRODUCT } from "./context.ts";

export const SURFACE_KEY = "_antigravity_surface";

// PRD A2: the product's own ids and the surface on every row, whoever built it. session_id stays
// what the row builder set, the raw root conversationId.
export function attribute(row: AuditRow, surface: Surface): AuditRow {
  return { ...row, agent_id: AGENT_ID, client_id: PRODUCT, input: { ...row.input, [SURFACE_KEY]: surface } };
}
