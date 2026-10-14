import { isRecord } from "../src/io/http.ts";
import { stubBackend, type Handler, type Recorded } from "./support.ts";

type Batch = {
  generation: string;
  runId?: string;
  snapshots: Array<{ sessionId: string; usageDate: string; usageHour: number }>;
  calls?: Array<{ sessionId: string; records: Array<{ key: string }> }>;
  sessions?: Array<{ sessionId: string; title: string; titleSource: string }>;
};

export const batchOf = (r: Recorded): Batch => {
  if (!isRecord(r.body)) throw new Error("batch body is not an object");
  return r.body as Batch;
};

// conmap's token-usage routes, with the acknowledgement shapes the SDK checks.
export function usageBackend(extra: Record<string, Handler> = {}, opts: { generations?: string[]; fence?: (b: Batch) => boolean; refuse?: () => number | null } = {}) {
  const generations = [...(opts.generations ?? [crypto.randomUUID()])];
  let current = generations[0] ?? crypto.randomUUID();
  const runs = new Map<string, { applied: boolean; completedAt: string | null }>();
  const backend = stubBackend({
    "POST /dashboard/token-usage/stream": () => {
      current = generations.shift() ?? current;
      return { body: { generation: current } };
    },
    "POST /dashboard/token-usage/batch": (r) => {
      const b = batchOf(r);
      const refused = opts.refuse?.();
      if (refused) return { status: refused, body: { message: "Invalid API key" } };
      if (b.generation !== current || opts.fence?.(b)) return { status: 409, body: { message: "Usage stream generation is not current" } };
      const sent = (b.calls ?? []).reduce((n, c) => n + c.records.length, 0);
      return {
        body: {
          results: b.snapshots.map((s) => ({ sessionId: s.sessionId, usageDate: s.usageDate, usageHour: s.usageHour, status: "applied" })),
          ...(sent ? { calls: { stored: sent, duplicates: 0 } } : {}),
        },
      };
    },
    "PUT /dashboard/token-usage/runs/*": (r) => {
      const runId = r.path.split("/").pop() ?? "";
      const phase = isRecord(r.body) ? r.body.phase : null;
      const run = { applied: true, completedAt: phase === "complete" ? new Date().toISOString() : null };
      runs.set(runId, run);
      return { body: { applied: true, run: { runId, completedAt: run.completedAt } } };
    },
    "POST /dashboard/token-usage/latency": () => ({ body: { recorded: true } }),
    ...extra,
  });
  return { ...backend, batches: () => backend.hits("POST", "/dashboard/token-usage/batch").map(batchOf), runs };
}
