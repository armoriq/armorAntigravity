import type { PlanCaptureState } from "../../src/types.ts";

export const planCaptureState = (): PlanCaptureState => ({
  promptId: null, promptGeneration: 0, retirementEpoch: 0, promptOpenSince: null, lastActivityAt: null,
  countedPlanId: null, tokenPlanId: null, planHash: null, kind: null,
  tokenExpiresAt: null, authGeneration: 0, pendingRequest: null,
  unregisteredLocalPlan: null, seenMessageIds: [],
});
