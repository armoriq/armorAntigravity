// Bundles armorantigravity and armoriq-agd for node, with the small shell wrappers that run them.
// They were `bun build --compile` binaries until the embedded runtime made the download 60 MB; see
// armoriq/armorAntigravity#165. agd-hook is the one thing still compiled, by scripts/build-hook.ts.
// Usage: bun scripts/build-js.ts [--cli] [--daemon] [--out dist]
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BUNDLES, wrapperText } from "../packages/cli/src/wrapper.ts";

const REPO = path.resolve(import.meta.dir, "..");

export function buildBundle(entry: string, outfile: string): void {
  mkdirSync(path.dirname(outfile), { recursive: true });
  const cmd = [process.execPath, "build", path.join(REPO, entry), "--target=node", "--minify", "--outfile", outfile];
  const result = Bun.spawnSync(cmd, { cwd: REPO, stdout: "ignore", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${result.exitCode}`);
}

export function writeWrapper(dir: string, wrapper: string, node: string | null): void {
  const file = path.join(dir, wrapper);
  writeFileSync(file, wrapperText(wrapper, node), { mode: 0o755 });
  chmodSync(file, 0o755);
}

export function buildAll(out: string, only?: "cli" | "daemon"): void {
  for (const bundle of BUNDLES) {
    if (only === "cli" && bundle.wrapper !== "armorantigravity") continue;
    if (only === "daemon" && bundle.wrapper !== "armoriq-agd") continue;
    buildBundle(bundle.entry, path.join(out, bundle.script));
    writeWrapper(out, bundle.wrapper, null);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, cli: { type: "boolean" }, daemon: { type: "boolean" } }, strict: true });
  const out = path.resolve(values.out ?? path.join(REPO, "dist"));
  const only = values.cli && !values.daemon ? "cli" : values.daemon && !values.cli ? "daemon" : undefined;
  buildAll(out, only);
  console.log(`built ${only ?? "cli and daemon"} in ${out}`);
}
