import { expect, test } from "bun:test";
import contract from "../fixtures/client-events-v1.json";
import { CLIENT_EVENTS, clientEvent } from "../../src/core/client-events.ts";

test("client events equal the backend contract and enforce its examples", () => {
  expect(Object.keys(CLIENT_EVENTS.reasons)).toEqual(contract.types);
  expect(contract.queues).toEqual([...CLIENT_EVENTS.queues]);
  expect<unknown>(contract.reasonCodes).toEqual(CLIENT_EVENTS.reasons);
  expect(contract.limits.maxEventsPerRequest).toBe(CLIENT_EVENTS.maxBatchEvents);
  expect(contract.limits.maxCount).toBe(CLIENT_EVENTS.maxCount);
  for (const { event, outcome } of contract.examples) {
    const build = () => clientEvent(event.type, event.queue, event.count, event.reason_code, Date.parse(event.occurred_at), event.event_id, event.oldest_pending_seconds);
    if (outcome === "accepted") expect<unknown>(build()).toEqual({ ...event, occurred_at: new Date(event.occurred_at).toISOString() });
    else expect(build).toThrow();
  }
});
