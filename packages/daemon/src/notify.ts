import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Log } from "./log.ts";
import type { Env } from "./paths.ts";

interface NotificationProcess {
  once(event: "error" | "exit", listener: () => void): unknown;
  unref(): void;
  kill(signal: "SIGKILL"): unknown;
}

interface NotificationOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Env;
  readonly spawn?: (file: string, args: string[], options: { detached: true; stdio: "ignore"; shell: false }) => NotificationProcess;
}

function notifySend(env: Env): string | null {
  if ((!env.DISPLAY && !env.WAYLAND_DISPLAY) || !env.PATH) return null;
  for (const dir of env.PATH.split(path.delimiter)) {
    const file = path.resolve(dir, "notify-send");
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch {}
  }
  return null;
}

export function desktopNotifier(log: Log, opts: NotificationOptions = {}): (message: string) => void {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const launch = opts.spawn ?? spawn;
  return (message) => {
    // Keep the complete text even when the desktop hides or rejects a notification.
    log.info(message);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const binary = platform === "darwin" ? "osascript" : platform === "linux" ? notifySend(env) : null;
      if (!binary) return;
      const args = platform === "darwin"
        ? ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "ArmorIQ"', "-e", "end run", message]
        : ["ArmorIQ", message];
      const child = launch(binary, args, { detached: true, stdio: "ignore", shell: false });
      const done = () => clearTimeout(timer);
      child.once("error", done);
      child.once("exit", done);
      timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      timer.unref?.();
      child.unref();
    } catch { clearTimeout(timer); }
  };
}
