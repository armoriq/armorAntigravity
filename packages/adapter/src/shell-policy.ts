import type { CompiledPolicy, CoreToolCall, PolicyEffect } from "./core-contract.ts";
import { parseShell, segmentText } from "./shell.ts";

const SEVERITY: Record<PolicyEffect, number> = { permit: 0, require_approval: 1, forbid: 2 };

// The core judges a shell call on its first program. This judges every
// segment `parseShell` finds as its own call and keeps the most severe result,
// the way the core already treats each file of a multi-file edit.
export function segmentedPolicy(
  policy: CompiledPolicy,
  options: { isShell: (call: CoreToolCall) => boolean; home: string },
): CompiledPolicy {
  return {
    hash: policy.hash,
    intentRequired: policy.intentRequired,
    evaluate(call) {
      const whole = policy.evaluate(call);
      const command = call.args.command;
      if (whole.effect === "forbid" || !options.isShell(call) || typeof command !== "string") return whole;
      const workdir = typeof call.args.workdir === "string" ? call.args.workdir : null;
      const parsed = parseShell(command, { cwd: workdir, home: options.home });
      // The lexer is narrower than bash, so a line it cannot split may still
      // run; its later segments are unknown, so a person decides.
      if (!parsed.ok) {
        return whole.effect === "permit"
          ? { effect: "require_approval", ruleId: "shell-unparsed", reason: "ArmorIQ could not split this command into its parts to check each one" }
          : whole;
      }
      let worst = whole;
      for (const segment of parsed.segments) {
        const v = policy.evaluate({ ...call, args: { ...call.args, command: segmentText(segment) } });
        if (SEVERITY[v.effect] > SEVERITY[worst.effect]) worst = v;
        if (v.effect === "forbid") break;
      }
      return worst;
    },
  };
}
