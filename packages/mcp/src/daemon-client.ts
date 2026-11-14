import { PROTOCOL_VERSION, type McpOutcomeRequest } from "@armorantigravity/protocol";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { AskDaemon } from "./server.ts";

// One request per connection: the daemon answers one line and the socket closes.
export function daemonAsker(socketPath: string, waitMs: number): AskDaemon {
  return (tool, args) =>
    new Promise((resolve) => {
      const request: McpOutcomeRequest = { v: PROTOCOL_VERSION, id: randomUUID(), kind: "mcp_outcome", tool, args, waitMs };
      const socket = createConnection(socketPath);
      let buffer = "";
      const finish = (text: string | null) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(text);
      };
      const timer = setTimeout(() => finish(null), waitMs + 1000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("error", () => finish(null));
      socket.on("close", () => finish(null));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        finish(parseText(buffer.slice(0, nl), request.id));
      });
    });
}

function parseText(line: string, id: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("id" in value) || value.id !== id || !("text" in value)) return null;
  return typeof value.text === "string" ? value.text : null;
}
