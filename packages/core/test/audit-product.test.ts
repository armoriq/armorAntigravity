import { expect, test } from "bun:test";
import { toAuditRow } from "../src/audit.ts";
import type { Session, SessionID } from "../src/types.ts";

const session = (id: string, parentId: string | null): Session => ({
  id: id as SessionID,
  parentId: parentId as SessionID | null,
  mode: "enforce",
  plan: null,
  token: null,
  stepCursor: 0,
  revisionsThisMessage: 0,
  currentMessageId: null,
});

test("audit rows carry the product's slug, agent id and child-session key", () => {
  const root = session("conv-root", null);
  const child = session("conv-child", "conv-root");
  const row = toAuditRow(
    {
      call: { sessionId: child.id, callId: "c", tool: "shell_exec", args: { Cmd: "ls" } },
      session: child,
      root,
      status: "success",
      decision: { kind: "allow", stepIndex: null, paramMismatch: false },
      output: "ok",
      error: null,
      durationMs: null,
      at: Date.parse("2026-10-12T00:00:00.000Z"),
    },
    { slug: "armorexample", agentId: "example", childSessionKey: "_example_session" },
  );
  expect([row.session_id, row.agent_id, row.client_id, row.input]).toEqual([
    "conv-root",
    "example",
    "armorexample",
    { Cmd: "ls", _example_session: "conv-child" },
  ]);
});
