import { afterEach, describe, expect, test } from "bun:test";
import { createMcpGate, parseServerList } from "../src/mcp-gate.ts";
import { stubBackend } from "./support/backend.ts";
import { memoryLog } from "./support/policy.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

const until = async (check: () => boolean) => {
  const end = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("parseServerList", () => {
  test("conmap-auto /mcp/my-servers rows are approved", () => {
    expect(parseServerList({ success: true, data: [{ mcpId: "m1", name: "github", url: "https://mcp.github.com" }] })).toEqual([{ name: "github", status: "approved" }]);
  });
  test("armorClaude shapes with explicit statuses", () => {
    expect(parseServerList({ servers: [{ mcpName: "linear", status: "denied" }, { mcpName: "x", status: "weird" }] })).toEqual([
      { name: "linear", status: "denied" },
      { name: "x", status: "approved" },
    ]);
    expect(parseServerList([{ mcpName: "a", status: "pending" }])).toEqual([{ name: "a", status: "pending" }]);
  });
  test("junk yields nothing", () => {
    expect(parseServerList(null)).toEqual([]);
    expect(parseServerList({ data: [null, 3, { name: "" }] })).toEqual([]);
  });
});

describe("createMcpGate", () => {
  test("an unknown server is unapproved and registered once, in the background, as armorClaude does", async () => {
    const backend = stubBackend({});
    stops.push(backend.stop);
    const gate = createMcpGate({ access: () => ({ login: backend.login, client: "armorantigravity/0.1.0" }), log: memoryLog(), ownServer: "armoriq" });
    expect(gate.check("github")).toEqual({ kind: "unapproved", firstSeen: true });
    expect(gate.check("github")).toEqual({ kind: "unapproved", firstSeen: false });
    await until(() => backend.seen.length === 1);
    expect(backend.seen[0]).toMatchObject({ method: "POST", path: "/mcp/auto-register", body: { mcpName: "github", source: "armorantigravity-autodetect" } });
    expect(backend.seen[0]?.headers.get("x-armoriq-client")).toBe("armorantigravity/0.1.0");
  });

  test("own server is always approved and never registered", () => {
    const gate = createMcpGate({ access: () => null, log: memoryLog(), ownServer: "armoriq" });
    expect(gate.check("armoriq")).toEqual({ kind: "approved" });
    expect(gate.statuses().size).toBe(0);
  });

  test("approve and deny are local decisions reported through onChange", () => {
    const changes: string[] = [];
    const gate = createMcpGate({ access: () => null, log: memoryLog(), ownServer: "armoriq", onChange: (s, st) => changes.push(`${s}:${st}`) });
    gate.approve("github");
    gate.deny("evil");
    expect(gate.check("github")).toEqual({ kind: "approved" });
    expect(gate.check("evil")).toEqual({ kind: "denied" });
    expect(changes).toEqual(["github:approved", "evil:denied"]);
  });

  test("sync falls back to /mcp/my-servers when /mcp/servers refuses the API key, and keeps local denies", async () => {
    const backend = stubBackend({
      "GET /mcp/servers": () => Response.json({ message: "Invalid access token", error: "Unauthorized", statusCode: 401 }, { status: 401 }),
      "GET /mcp/my-servers": () =>
        Response.json({ success: true, data: [{ mcpId: "m1", name: "github", url: "u" }, { mcpId: "m2", name: "evil", url: "u" }] }),
    });
    stops.push(backend.stop);
    const gate = createMcpGate({ access: () => ({ login: backend.login, client: "c" }), log: memoryLog(), ownServer: "armoriq", initial: new Map([["evil", "denied"]]) });
    expect(await gate.sync()).toEqual({ kind: "synced", route: "/mcp/my-servers", servers: 2 });
    expect(backend.seen.map((s) => s.path)).toEqual(["/mcp/servers", "/mcp/my-servers"]);
    expect(gate.check("github")).toEqual({ kind: "approved" });
    expect(gate.check("evil")).toEqual({ kind: "denied" });
  });

  test("sync uses /mcp/servers when it answers", async () => {
    const backend = stubBackend({ "GET /mcp/servers": () => Response.json({ servers: [{ mcpName: "linear", status: "approved" }] }) });
    stops.push(backend.stop);
    const gate = createMcpGate({ access: () => ({ login: backend.login, client: "c" }), log: memoryLog(), ownServer: "armoriq" });
    expect(await gate.sync()).toEqual({ kind: "synced", route: "/mcp/servers", servers: 1 });
  });

  test("sync failures and logged-out state leave statuses alone", async () => {
    const backend = stubBackend({ "GET /mcp/servers": () => new Response("down", { status: 503 }) });
    stops.push(backend.stop);
    const gate = createMcpGate({ access: () => ({ login: backend.login, client: "c" }), log: memoryLog(), ownServer: "armoriq", initial: new Map([["github", "approved"]]) });
    expect((await gate.sync()).kind).toBe("failed");
    expect(gate.check("github")).toEqual({ kind: "approved" });
    const out = createMcpGate({ access: () => null, log: memoryLog(), ownServer: "armoriq" });
    expect(await out.sync()).toEqual({ kind: "skipped", reason: "not logged in" });
  });
});
