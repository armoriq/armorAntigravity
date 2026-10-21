import { DEFAULT_SOCKET_PATH, SOCKET_PATH_ENV } from "@armorantigravity/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { daemonAsker } from "./daemon-client.ts";
import { createServer, OUTCOME_WAIT_MS } from "./server.ts";

const socketPath = process.env[SOCKET_PATH_ENV] || DEFAULT_SOCKET_PATH.replace(/^~(?=\/)/, homedir());
const server = createServer(daemonAsker(socketPath, OUTCOME_WAIT_MS), "0.0.0");
await server.connect(new StdioServerTransport());
