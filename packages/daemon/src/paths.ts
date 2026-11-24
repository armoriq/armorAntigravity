import { FALLBACK_DIR_NAME, MODE_FILE_NAME } from "@armorantigravity/protocol";
import { resolveArmoriqDir, resolveSocketPath } from "@armorantigravity/protocol/socket";
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
  // The agy rule the installer writes; the daemon keeps it in step with the mode.
  readonly rulesFile: string;
}

export function resolvePaths(env: Env): Paths {
  const armoriqDir = resolveArmoriqDir(env, homedir());
  const dataDir = path.join(armoriqDir, PRODUCT);
  const socket = resolveSocketPath(env, homedir());
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
    rulesFile: path.join(homedir(), ".gemini", "config", "rules", "armoriq.md"),
  };
}
