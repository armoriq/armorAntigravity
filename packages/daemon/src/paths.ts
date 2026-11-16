import { DEFAULT_SOCKET_PATH, FALLBACK_DIR_NAME, MODE_FILE_NAME, SOCKET_PATH_ENV } from "@armorantigravity/protocol";
import { homedir } from "node:os";
import path from "node:path";

export const PRODUCT = "armorantigravity";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  readonly armoriqDir: string;
  readonly dataDir: string;
  readonly binDir: string;
  readonly socket: string;
  readonly modeFile: string;
  readonly fallbackDir: string;
  readonly lockFile: string;
  readonly configFile: string;
  readonly sessionsDir: string;
  readonly logFile: string;
}

export function resolvePaths(env: Env): Paths {
  const armoriqDir = env.ARMORIQ_HOME?.trim() || path.join(homedir(), ".armoriq");
  const dataDir = path.join(armoriqDir, PRODUCT);
  const socket = expandHome(env[SOCKET_PATH_ENV]?.trim() || DEFAULT_SOCKET_PATH.replace("~/.armoriq", armoriqDir));
  return {
    armoriqDir,
    dataDir,
    binDir: path.join(dataDir, "bin"),
    socket,
    modeFile: path.join(path.dirname(socket), MODE_FILE_NAME),
    fallbackDir: path.join(path.dirname(socket), FALLBACK_DIR_NAME),
    lockFile: `${socket}.lock`,
    configFile: path.join(dataDir, "config.json"),
    sessionsDir: path.join(dataDir, "sessions"),
    logFile: path.join(dataDir, "logs", "agd.log"),
  };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
}
