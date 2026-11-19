import type { Log, RunRecorder } from "./types.ts";

// A recorder can fail after the guard has decided. It must never replace that decision or its reply.
export function safeRunRecorder(recorder: RunRecorder | undefined, log: Log): RunRecorder | undefined {
  if (!recorder) return undefined;
  const failed = () => log.error("run bookkeeping failed");
  const guard = <T>(work: () => T, fallback: T): T => {
    try { return work(); } catch { failed(); return fallback; }
  };
  return {
    enabled: recorder.enabled,
    begin: (...args) => guard(() => recorder.begin(...args), undefined),
    end: (...args) => guard(() => recorder.end(...args), undefined),
    attempt: (...args) => guard(() => recorder.attempt(...args), undefined),
    request: (...args) => guard(() => recorder.request(...args), undefined),
    reject: (...args) => guard(() => recorder.reject(...args), undefined),
    registration: (...args) => {
      const settle = guard(() => recorder.registration(...args), () => {});
      return () => guard(settle, undefined);
    },
    kick: async () => { try { await recorder.kick(); } catch { failed(); } },
  };
}
