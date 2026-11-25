import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rulesFileText } from "@armorantigravity/intent";
import type { Log } from "./log.ts";

// The installer's marker: only a rules file it wrote is ever rewritten.
const INSTALLED_MARKER = "ArmorIQ intent enforcement";

// agy reads the rule on every conversation, so it follows the mode: the plan instruction only in enforce.
export function syncRules(file: string, mode: "enforce" | "monitor", log: Log): void {
  let current: string;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const next = rulesFileText(mode);
  if (current === next || !current.includes(INSTALLED_MARKER)) return;
  // Through a symlink (dotfile managers) the target is replaced and the link kept.
  let target = file;
  try {
    target = realpathSync(file);
  } catch {}
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, next, { mode: statSync(target).mode & 0o777 });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    log.warn("rules file not updated", { file, error: String(error) });
  }
}
