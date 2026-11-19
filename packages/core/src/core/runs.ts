// Shared run facts contain ids and counters, never prompt text or tool arguments.
export const RUNS = {
  endReasons: ["stop", "next_prompt", "session_end", "recovered"],
  noPlanReasons: ["monitor_mode", "no_tool_use", "read_only", "backend_unreachable", "request_failed", "plan_rejected", "not_registered"],
  limits: { maxBatchReports: 200, maxIdChars: 128, maxPlanIds: 20, maxBatchBytes: 8388608, maxInteger: 2147483647 },
} as const;

export type RunEndReason = typeof RUNS.endReasons[number];
export type NoPlanReason = typeof RUNS.noPlanReasons[number];
export type RunRequestOutcome = "pending" | "failed" | "confirmed";
export type RunBinding = { backend: string; keyId: string };
export type RunReport = {
  run_id: string;
  report_seq: number;
  session_id: string;
  started_at: string;
  ended_at?: string;
  end_reason?: RunEndReason;
  tool_calls: number;
  gated_tool_calls: number;
  plan_ids: string[];
  no_plan_reason?: NoPlanReason;
};
export type RunState = {
  runId: string;
  sessionId: string;
  startedAt: number;
  updatedAt?: number;
  binding: RunBinding | null;
  owner: { id: string; pid: number };
  version: number;
  reportSeq: number;
  enforcing: boolean;
  enforcementNeeded: boolean;
  toolCalls: number;
  gatedToolCalls: number;
  callIds: string[];
  planIds: string[];
  requests: Record<string, RunRequestOutcome>;
  rejected: boolean;
  unreachable: boolean;
  end: { reason: RunEndReason; at: number } | null;
  closed: boolean;
};

export type RunCapabilityRule = { patterns: readonly string[]; counted: boolean; gated: boolean };
export function runCapability(tool: string, rules: readonly RunCapabilityRule[], trustedOwnTool = true): { counted: boolean; gated: boolean } {
  for (const rule of rules) {
    if (!trustedOwnTool && !rule.counted) continue;
    if (rule.patterns.some(pattern => new RegExp(pattern).test(tool))) return { counted: rule.counted, gated: rule.gated };
  }
  return { counted: true, gated: true };
}

export function countRunAttempt(run: RunState, callId: string, tool: string, enforcing: boolean, rules: readonly RunCapabilityRule[], trustedOwnTool = true): RunState | null {
  const capability = runCapability(tool, rules, trustedOwnTool);
  if (run.closed || run.end || !capability.counted || run.callIds.includes(callId)) return null;
  return {
    ...run, version: run.version + 1, callIds: [...run.callIds, callId],
    toolCalls: Math.min(RUNS.limits.maxInteger, run.toolCalls + 1),
    gatedToolCalls: Math.min(RUNS.limits.maxInteger, run.gatedToolCalls + Number(capability.gated)),
    enforcementNeeded: run.enforcementNeeded || capability.gated && enforcing,
  };
}

export function settleRunRequest(run: RunState, key: string, outcome: RunRequestOutcome, planId?: string, unreachable = false): RunState {
  const planIds = outcome === "confirmed" && planId && !run.planIds.includes(planId) && run.planIds.length < RUNS.limits.maxPlanIds
    ? [...run.planIds, planId] : run.planIds;
  return { ...run, version: run.version + 1, requests: { ...run.requests, [key]: outcome }, planIds, unreachable: run.unreachable || unreachable };
}

export function noPlanReason(run: RunState): NoPlanReason | undefined {
  if (run.planIds.length) return undefined;
  if (!run.enforcing && !run.enforcementNeeded) return "monitor_mode";
  if (run.toolCalls === 0) return "no_tool_use";
  if (run.gatedToolCalls === 0) return "read_only";
  if (run.unreachable) return "backend_unreachable";
  const outcomes = Object.values(run.requests);
  if (outcomes.length && outcomes.every(outcome => outcome === "failed")) return "request_failed";
  if (run.rejected) return "plan_rejected";
  return "not_registered";
}

export function runReport(run: RunState): RunReport {
  const report: RunReport = {
    run_id: run.runId, report_seq: run.reportSeq, session_id: run.sessionId,
    started_at: new Date(run.startedAt).toISOString(), tool_calls: run.toolCalls, gated_tool_calls: run.gatedToolCalls,
    plan_ids: [...run.planIds],
  };
  if (run.closed && run.end) {
    report.ended_at = new Date(Math.max(run.startedAt, run.end.at)).toISOString();
    report.end_reason = run.end.reason;
    const reason = noPlanReason(run);
    if (reason !== undefined) report.no_plan_reason = reason;
  }
  return report;
}

export const runTransportId = (report: Pick<RunReport, "run_id" | "report_seq">): string => JSON.stringify([report.run_id, report.report_seq]);
