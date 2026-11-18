import { resolveSocketPath } from "@armorantigravity/protocol/socket";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { daemonAsker } from "./daemon-client.ts";
import { createServer, OUTCOME_WAIT_MS } from "./server.ts";

const socketPath = resolveSocketPath(process.env, homedir());
const server = createServer(daemonAsker(socketPath, OUTCOME_WAIT_MS), "0.0.0");
await server.connect(new StdioServerTransport());
