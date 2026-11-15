import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CLIENT_ID } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

// Scanned rather than a trailing slash regex, which backtracks on a long run of slashes.
export function resolveBackend(env: Env, configured: string | null): string {
  const url = (env.ARMORIQ_BACKEND_URL?.trim() || undefined) ?? configured ?? "https://api.armoriq.ai";
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return end === url.length ? url : url.slice(0, end);
}

function configuredBackend(dataDir: string): string | null {
  try {
    const config: unknown = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
    if (config && typeof config === "object" && "backendUrl" in config && typeof config.backendUrl === "string") return config.backendUrl.trim() || null;
  } catch {}
  return null;
}

// Defaults let intent denial hints use the same formatter without depending on the daemon.
export function loginCommand(
  dataDir = path.join(process.env.ARMORIQ_HOME?.trim() || path.join(homedir(), ".armoriq"), CLIENT_ID),
  backend = resolveBackend(process.env, configuredBackend(dataDir)),
  force = false,
): string {
  const cli = path.join(dataDir, "bin", "armorantigravity");
  const backendArg = `'${backend.replaceAll("'", "'\\''")}'`;
  const command = existsSync(cli)
    ? `'${cli.replaceAll("'", "'\\''")}' login --backend ${backendArg}`
    : `armoriq login --product ${CLIENT_ID} --backend ${backendArg}`;
  return force ? `${command} --force` : command;
}
