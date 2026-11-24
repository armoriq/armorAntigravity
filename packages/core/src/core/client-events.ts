// These wire values follow the backend client events contract.
export const CLIENT_EVENTS = Object.freeze({
  maxBatchEvents: 100,
  maxCount: 1_000_000,
  queues: ["audit", "runs", "health"] as const,
  outcomes: ["accepted", "duplicate", "retryable", "rejected"] as const,
  reasons: {
    dead_letter: ["rejected", "attempts_exhausted", "oversize"],
    queue_stalled: ["backend_unreachable", "auth_paused", "rate_limited", "server_error", "undeliverable_login"],
    plan_request_failed: ["timeout", "network", "rate_limited", "server_error", "request_in_progress", "rejected"],
  } as const,
});

export type EventType = keyof typeof CLIENT_EVENTS.reasons;
export type EventQueue = typeof CLIENT_EVENTS.queues[number];
export type StallReason = typeof CLIENT_EVENTS.reasons.queue_stalled[number];
export type PlanFailureReason = typeof CLIENT_EVENTS.reasons.plan_request_failed[number];
export type DeadLetterReason = typeof CLIENT_EVENTS.reasons.dead_letter[number];
export type ClientEvent = {
  event_id: string;
  type: EventType;
  queue: EventQueue;
  count: number;
  reason_code: typeof CLIENT_EVENTS.reasons[EventType][number];
  occurred_at: string;
  oldest_pending_seconds?: number;
};

// Identity and time come from the caller so this module stays independent of its host.
export function clientEvent(type: string, queue: string, count: number, reason: string, now: number, eventId: string, oldestPendingSeconds?: number): ClientEvent {
  if (!Object.hasOwn(CLIENT_EVENTS.reasons, type) ||
      !(CLIENT_EVENTS.reasons[type as EventType] as readonly string[]).includes(reason) ||
      !(CLIENT_EVENTS.queues as readonly string[]).includes(queue) ||
      !Number.isInteger(count) || count < 1 || count > CLIENT_EVENTS.maxCount ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId) ||
      (oldestPendingSeconds !== undefined && (!Number.isSafeInteger(oldestPendingSeconds) || oldestPendingSeconds < 0))) throw new Error("invalid client event");
  return {
    event_id: eventId, type: type as EventType, queue: queue as EventQueue, count,
    reason_code: reason as ClientEvent["reason_code"], occurred_at: new Date(now).toISOString(),
    ...(oldestPendingSeconds === undefined ? {} : { oldest_pending_seconds: oldestPendingSeconds }),
  };
}
