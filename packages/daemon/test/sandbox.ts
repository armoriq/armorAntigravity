import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Bun fixes homedir() at startup, so `bun run test` launches bun test under a temp HOME. This
// refuses to run otherwise, so the developer's real ~/.armoriq is never read or written.
export function sandboxHome(): { home: string; cleanup(): void } {
  const home = homedir();
  if (!realpathSync(home).startsWith(realpathSync(tmpdir()))) throw new Error(`refusing to run outside a sandbox HOME (${home}); use \`bun run test\``);
  const reset = () => rmSync(path.join(home, ".armoriq"), { recursive: true, force: true });
  reset();
  mkdirSync(home, { recursive: true });
  return { home, cleanup: reset };
}
