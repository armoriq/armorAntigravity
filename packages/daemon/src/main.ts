import { armoriqPlugins } from "./armoriq.ts";
import { AlreadyRunning, startDaemon } from "./daemon.ts";

try {
  const daemon = await startDaemon({ env: process.env, plugins: armoriqPlugins() });
  const shutdown = () => void daemon.stop().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  // launchd and systemd restart only on failure, so a second instance exits cleanly.
  if (error instanceof AlreadyRunning) process.exit(0);
  process.stderr.write(`armoriq-agd: ${String(error)}\n`);
  process.exit(1);
}
