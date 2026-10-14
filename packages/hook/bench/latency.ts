import type { HookEvent } from "@armorantigravity/protocol";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// PRD section 6. A budget is enforced only with at least MIN_SAMPLES samples.
const BUDGETS: Partial<Record<HookEvent, { p50: number; p95: number }>> = {
  PreToolUse: { p50: 8, p95: 30 },
  PostToolUse: { p50: 8, p95: 30 },
  PreInvocation: { p50: 15, p95: 50 },
  Stop: { p50: 15, p95: 50 },
};
const MIN_SAMPLES = 20;
const EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];

const pkgDir = path.join(import.meta.dir, "..");
const { values } = parseArgs({
  options: {
    client: { type: "string", default: path.join(pkgDir, "dist/agd-hook") },
    daemon: { type: "string", default: path.join(pkgDir, "../daemon/dist/armoriq-agd") },
    samples: { type: "string", default: "100" },
    warmup: { type: "string", default: "10" },
  },
});
const samples = Number(values.samples);
const warmup = Number(values.warmup);

const home = mkdtempSync(path.join(tmpdir(), "agd-bench-"));
const env = { ...process.env, HOME: home, ARMORANTIGRAVITY_DAEMON: values.daemon };
const socket = path.join(home, ".armoriq", "armorantigravity", "agd.sock");
// Shaped like the documented hook payload (https://antigravity.google/docs/hooks/) until the P0 spike captures real ones.
const base = { conversationId: "bench-conv", workspacePaths: [home], transcriptPath: `${home}/.gemini/antigravity-cli/brain/bench-conv/.system_generated/logs/transcript.jsonl`, modelName: "bench" };
const tool = { toolCall: { name: "run_command", args: { CommandLine: "git status", Cwd: home } }, stepIdx: 0 };
const payloads: Record<HookEvent, string> = {
  PreToolUse: JSON.stringify({ ...base, ...tool }),
  PostToolUse: JSON.stringify({ ...base, ...tool }),
  PreInvocation: JSON.stringify(base),
  PostInvocation: JSON.stringify(base),
  Stop: JSON.stringify(base),
};

async function time(cmd: string[], stdin: string): Promise<{ ms: number; out: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "ignore", env });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  const ms = performance.now() - t0;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return { ms, out };
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
const fmt = (n: number) => n.toFixed(1);

const daemon = Bun.spawn([values.daemon], { env, stdio: ["ignore", "ignore", "inherit"] });
try {
  const deadline = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (Date.now() > deadline) throw new Error("daemon did not open its socket in 10 s");
    await Bun.sleep(10);
  }

  const floor: number[] = [];
  for (let i = 0; i < samples; i++) floor.push((await time(["/usr/bin/true"], "")).ms);
  floor.sort((a, b) => a - b);

  const rows: string[] = [];
  let failed = false;
  for (const event of EVENTS) {
    for (let i = 0; i < warmup; i++) await time([values.client, event], payloads[event]);
    const ms: number[] = [];
    let last = "";
    for (let i = 0; i < samples; i++) {
      const r = await time([values.client, event], payloads[event]);
      ms.push(r.ms);
      last = r.out.trim();
    }
    if (event === "PreToolUse" && !last.includes('"decision"')) throw new Error(`unexpected PreToolUse output ${last}`);
    ms.sort((a, b) => a - b);
    const p50 = pct(ms, 50);
    const p95 = pct(ms, 95);
    const budget = BUDGETS[event];
    const enforced = budget && ms.length >= MIN_SAMPLES;
    const ok = !enforced || (p50 <= budget.p50 && p95 <= budget.p95);
    if (!ok) failed = true;
    const verdict = !budget ? "no budget" : !enforced ? `not enforced (<${MIN_SAMPLES} samples)` : ok ? "pass" : "FAIL";
    rows.push(`| ${event} | ${ms.length} | ${fmt(p50)} | ${fmt(p95)} | ${fmt(ms[ms.length - 1] ?? NaN)} | ${budget ? `${budget.p50} / ${budget.p95}` : "-"} | ${verdict} |`);
  }

  const summary = [
    `### agd-hook latency (${process.platform}/${process.arch})`,
    "",
    `Wall time per hook: spawn the compiled client, socket round trip to a live armoriq-agd, exit. Stub decision handler. Spawn floor (\`/usr/bin/true\`): p50 ${fmt(pct(floor, 50))} ms, p95 ${fmt(pct(floor, 95))} ms.`,
    "",
    "| Hook | Samples | p50 ms | p95 ms | max ms | Budget p50 / p95 | Result |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.exitCode = failed ? 1 : 0;
} finally {
  daemon.kill("SIGTERM");
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
}
