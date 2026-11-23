import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { DEFAULT_SOCKET_PATH, SOCKET_PATH_ENV } from "./index.ts";

// Below sun_path on macOS (104) and Linux (108); libuv silently truncates a longer path.
export const MAX_SOCKET_PATH_BYTES = 100;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveArmoriqDir(env: Env, home: string): string {
  return env.ARMORIQ_HOME?.trim() || path.join(home, ".armoriq");
}

// The one place the daemon, the CLI and the MCP server agree on where agd listens; agd-hook
// (socket_path in agd-hook.c) reads the same variables in the same order.
export function resolveSocketPath(env: Env, home: string): string {
  const socket = env[SOCKET_PATH_ENV]?.trim() || DEFAULT_SOCKET_PATH.replace("~/.armoriq", resolveArmoriqDir(env, home));
  return socket === "~" || socket.startsWith("~/") ? path.join(home, socket.slice(1)) : socket;
}

export function dialSocket(socketPath: string): Socket {
  if (Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH_BYTES) return createConnection(socketPath);
  // A path too long for sun_path is dialed from its own directory, the way agd-hook does
  // (dial_from_directory). Node connects a pipe synchronously inside connect(), so the cwd is restored at once.
  const cwd = process.cwd();
  process.chdir(path.dirname(socketPath));
  try {
    return createConnection(path.basename(socketPath));
  } finally {
    process.chdir(cwd);
  }
}
