import { armoriqPlugins } from "./armoriq.ts";
import { AlreadyRunning, RestartRequired, startDaemon } from "./daemon.ts";
import { RESTART_EXIT_CODE } from "./update.ts";

try {
  const daemon = await startDaemon({
    env: process.env,
    plugins: armoriqPlugins(),
    onRestartRequired: () => void daemon.stop().then(() => process.exit(RESTART_EXIT_CODE)),
  });
  const shutdown = () => void daemon.stop().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  // launchd and systemd restart only on failure, so a second instance exits cleanly.
  if (error instanceof AlreadyRunning) process.exit(0);
  if (error instanceof RestartRequired) {
    process.stderr.write(`armoriq-agd: ${error.message}\n`);
    process.exit(RESTART_EXIT_CODE);
  }
  process.stderr.write(`armoriq-agd: ${String(error)}\n`);
  process.exit(1);
}
