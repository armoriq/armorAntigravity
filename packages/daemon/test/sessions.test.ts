import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionStore, SNAPSHOT_TTL_MS, snapshotPath } from "../src/sessions.ts";
import { sessionKey } from "../src/surface.ts";

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "agd-sessions-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("a restarted daemon restores plugin state and turn state from the v1 snapshot", async () => {
  const dir = freshDir();
  const store = createSessionStore(dir, 1_000);
  const { session, created } = store.open("cli", "conv-1", 1_000);
  session.set("core", { planId: "p1", steps: ["run_command"] });
  store.beginTurn(session.key, 1_500);
  await store.flush();

  expect(created).toBe(true);
  expect(JSON.parse(readFileSync(path.join(dir, "cli-conv-1.json"), "utf8"))).toEqual({
    v: 1,
    surface: "cli",
    conversationId: "conv-1",
    startedAt: 1_000,
    lastEventAt: 1_000,
    turnStartedAt: 1_500,
    state: { core: { planId: "p1", steps: ["run_command"] } },
  });

  const restored = createSessionStore(dir, 2_000);
  const again = restored.open("cli", "conv-1", 2_000);
  expect(again.created).toBe(false);
  expect(again.session.get("core")).toEqual({ planId: "p1", steps: ["run_command"] });
  expect(again.session.turnStartedAt).toBe(1_500);
  expect(again.session.startedAt).toBe(1_000);
});

test("snapshots older than 24 h and corrupt files are dropped on load", () => {
  const dir = freshDir();
  const now = 10 * SNAPSHOT_TTL_MS;
  const snap = (id: string, lastEventAt: number) =>
    JSON.stringify({ v: 1, surface: "app", conversationId: id, startedAt: 0, lastEventAt, turnStartedAt: null, state: {} });
  writeFileSync(snapshotPath(dir, "app", "old"), snap("old", now - SNAPSHOT_TTL_MS - 1));
  writeFileSync(snapshotPath(dir, "app", "new"), snap("new", now - 1_000));
  writeFileSync(path.join(dir, "junk.json"), "{not json");
  writeFileSync(path.join(dir, "v2.json"), JSON.stringify({ v: 2, surface: "app", conversationId: "x", startedAt: 0, lastEventAt: now }));

  const store = createSessionStore(dir, now);
  expect([...store.all()].map((s) => s.conversationId)).toEqual(["new"]);
  expect(readdirSync(dir).sort()).toEqual(["app-new.json", "junk.json"]);
});

test("conversation ids with path characters get a hashed, collision-free file name", () => {
  const a = snapshotPath("/d", "cli", "a/b");
  const b = snapshotPath("/d", "cli", "a_b");
  expect(path.dirname(a)).toBe("/d");
  expect(a).toMatch(/^\/d\/cli-a_b-[0-9a-f]{12}\.json$/);
  expect(b).toBe("/d/cli-a_b.json");
});

test("idle sessions are reported and closing one removes its snapshot", async () => {
  const dir = freshDir();
  const store = createSessionStore(dir, 0);
  store.open("ide", "quiet", 0);
  store.open("ide", "busy", 0);
  store.open("ide", "busy", 9_000);
  await store.flush();

  const idle = store.idle(10_000, 5_000);
  expect(idle.map((s) => String(s.key))).toEqual(["ide:quiet"]);
  store.close(sessionKey("ide", "quiet"));
  await store.flush();
  expect(readdirSync(dir)).toEqual(["ide-busy.json"]);
});
