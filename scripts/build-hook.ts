// Compiles packages/hook/src/agd-hook.c. The hook is C because it runs on every tool call and because a
// compiled Bun runtime for it alone was 69 MB of the 60 MB download; see armoriq/armorAntigravity#165.
// Usage: bun scripts/build-hook.ts [--target darwin-arm64] [--out packages/hook/dist/agd-hook]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO = path.resolve(import.meta.dir, "..");
const SOURCE = path.join(REPO, "packages", "hook", "src", "agd-hook.c");
// gnu11, not c11: under glibc, strict ISO mode hides the POSIX declarations this needs (clock_gettime,
// readlink, nanosleep, PATH_MAX). Apple's headers expose them either way, so c11 built only on macOS.
const COMMON = ["-std=gnu11", "-O2", "-Wall", "-Wextra", "-o"];

export type HookTarget = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export const hostTarget = (): HookTarget => `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}` as HookTarget;

// Every target is built by a compiler the runner already has: Apple's cc emits both macOS slices from one
// SDK, and ubuntu's archive carries the aarch64 cross gcc. Linux binaries are static so they do not inherit
// the build runner's glibc version. A target needing a toolchain the host lacks is an error, not a silent skip.
export function hookCompiler(target: HookTarget): string[] {
  const host = hostTarget();
  const hostOs = host.split("-")[0];
  if (!target.startsWith(`${hostOs}-`)) throw new Error(`agd-hook for ${target} cannot be built on ${host}; build it on a ${target.split("-")[0]} runner`);
  if (hostOs === "darwin") return ["cc", "-arch", target === "darwin-arm64" ? "arm64" : "x86_64"];
  if (target === host) return ["cc", "-static"];
  return [target === "linux-arm64" ? "aarch64-linux-gnu-gcc" : "x86_64-linux-gnu-gcc", "-static"];
}

export function compileHook(target: HookTarget, outfile: string, opts: { dev?: boolean } = {}): void {
  mkdirSync(path.dirname(outfile), { recursive: true });
  const cmd = [...hookCompiler(target), ...(opts.dev ? ["-DAGD_DEV_OVERRIDES"] : []), ...COMMON, outfile, SOURCE];
  const result = Bun.spawnSync(cmd, { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${result.exitCode}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: "string" }, out: { type: "string" }, dev: { type: "boolean" } }, strict: true });
  const target = (values.target ?? hostTarget()) as HookTarget;
  const out = path.resolve(values.out ?? path.join(REPO, "packages", "hook", "dist", "agd-hook"));
  try {
    compileHook(target, out, { dev: values.dev === true });
    console.log(`built ${out} (${target}${values.dev ? ", dev overrides" : ""})`);
  } catch (error) {
    console.error(`build-hook: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
