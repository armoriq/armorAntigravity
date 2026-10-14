import { backendRequest, type BackendAccess, type Fetch } from "./backend-http.ts";
import type { Log } from "./core-contract.ts";
import { isRecord } from "./tools.ts";

export type McpServerStatus = "approved" | "denied" | "pending";

export type McpVerdict = { kind: "approved" } | { kind: "denied" } | { kind: "unapproved"; firstSeen: boolean };

export type SyncOutcome = { kind: "synced"; route: string; servers: number } | { kind: "skipped"; reason: string } | { kind: "failed"; reason: string };

export interface McpGate {
  // Memory only; safe on the hook path. The first sight of a server registers it in the background.
  check(server: string): McpVerdict;
  approve(server: string): void;
  deny(server: string): void;
  // Pulls the org's registered servers. Session start and timer only.
  sync(): Promise<SyncOutcome>;
  statuses(): ReadonlyMap<string, McpServerStatus>;
}

export type McpGateOptions = {
  readonly access: () => BackendAccess | null;
  readonly log: Log;
  // ArmorIQ's own server is always approved.
  readonly ownServer: string;
  readonly fetch?: Fetch;
  // Seeds for statuses persisted by the daemon.
  readonly initial?: ReadonlyMap<string, McpServerStatus>;
  readonly onChange?: (server: string, status: McpServerStatus) => void;
};

const STATUSES: ReadonlySet<string> = new Set<McpServerStatus>(["approved", "denied", "pending"]);
const isStatus = (v: unknown): v is McpServerStatus => typeof v === "string" && STATUSES.has(v);

// armorClaude reads `{servers}` or a bare array; conmap-auto answers `{success, data}`
// with `{mcpId, name, url}` rows. A server the org registered counts as approved
// unless the row says otherwise.
export function parseServerList(data: unknown): { name: string; status: McpServerStatus }[] {
  const rows: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.servers)
      ? data.servers
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : [];
  const out: { name: string; status: McpServerStatus }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = typeof row.mcpName === "string" ? row.mcpName : typeof row.name === "string" ? row.name : "";
    if (name) out.push({ name, status: isStatus(row.status) ? row.status : "approved" });
  }
  return out;
}

// PRD 7.1 E7, after armorClaude's engine.mjs MCP deny-by-default gate.
export function createMcpGate(options: McpGateOptions): McpGate {
  const { log } = options;
  const statuses = new Map<string, McpServerStatus>(options.initial ?? []);
  const set = (server: string, status: McpServerStatus) => {
    if (statuses.get(server) === status) return;
    statuses.set(server, status);
    options.onChange?.(server, status);
  };
  const request = { ...(options.fetch ? { fetch: options.fetch } : {}) };

  const register = (server: string): void => {
    const access = options.access();
    if (!access) return;
    void backendRequest(access, {
      method: "POST",
      path: "/mcp/auto-register",
      body: { mcpName: server, source: "armorantigravity-autodetect" },
      ...request,
    }).then((res) => {
      if (!res.ok) log.info("MCP auto-register not accepted", { server, reason: res.reason });
    });
  };

  return {
    check(server) {
      if (server === options.ownServer) return { kind: "approved" };
      const status = statuses.get(server);
      if (status === "approved") return { kind: "approved" };
      if (status === "denied") return { kind: "denied" };
      if (status === undefined) {
        set(server, "pending");
        register(server);
        return { kind: "unapproved", firstSeen: true };
      }
      return { kind: "unapproved", firstSeen: false };
    },
    approve: (server) => set(server, "approved"),
    deny: (server) => set(server, "denied"),
    statuses: () => statuses,
    async sync() {
      const access = options.access();
      if (!access) return { kind: "skipped", reason: "not logged in" };
      // /mcp/servers is what armorClaude calls, but conmap-auto guards it with a
      // dashboard JWT; /mcp/my-servers is the API-key route for the same org list.
      let route = "/mcp/servers";
      let res = await backendRequest(access, { method: "GET", path: route, ...request });
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404)) {
        route = "/mcp/my-servers";
        res = await backendRequest(access, { method: "GET", path: route, ...request });
      }
      if (!res.ok) {
        log.warn("MCP registry sync failed", { reason: res.reason });
        return { kind: "failed", reason: res.reason };
      }
      const servers = parseServerList(res.data);
      // A local deny is the user's own call; the org list never overrides it.
      for (const s of servers) if (statuses.get(s.name) !== "denied") set(s.name, s.status);
      return { kind: "synced", route, servers: servers.length };
    },
  };
}
