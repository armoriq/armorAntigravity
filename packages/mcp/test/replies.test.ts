import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, NO_OUTCOME, OUTCOME_WAIT_MS } from "../src/server.ts";

test("the outcome wait covers the 40 second deadline plus a margin", () => {
  expect(OUTCOME_WAIT_MS).toBeGreaterThanOrEqual(45_000);
});

for (const unavailable of ["no outcome", "daemon disconnected"] as const) {
  test(`plan tools report an unconfirmed registration when there is ${unavailable}`, async () => {
    const server = createServer(async () => {
      if (unavailable === "daemon disconnected") throw new Error("daemon disconnected");
      return null;
    }, "0.0.0");
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      for (const name of ["register_intent_plan", "trust_reanchor"]) {
        const result = await client.callTool({ name, arguments: name === "trust_reanchor" ? { updatedPlan: { goal: "g", steps: [{ action: "run_command" }] }, reason: "changed task" } : {} });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "Plan registration not confirmed: the daemon did not confirm the registration. Retry the same plan to obtain confirmation." }]);
      }
      const local = await client.callTool({ name: "policy_read", arguments: {} });
      expect(local.isError).toBe(true);
      expect(local.content).toEqual([{ type: "text", text: NO_OUTCOME }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("MCP marks registration failures and unconfirmed outcomes as errors", async () => {
  let text = "Plan not registered: org_required.";
  const server = createServer(async () => text, "0.0.0");
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    for (text of ["Plan not registered: org_required.", "Plan registration not confirmed: network error. It will be retried with the same request id."]) {
      const result = await client.callTool({ name: "register_intent_plan", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text }]);
    }
    for (text of ["Intent registered: plan plan-1 (new), 1 steps. Token valid until 2030-01-01T00:00:00.000Z.", "Plan recorded locally, not registered (monitor_mode).", "Plan recorded locally, not registered (logged_out)."]) {
      expect((await client.callTool({ name: "register_intent_plan", arguments: {} })).isError).not.toBe(true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
