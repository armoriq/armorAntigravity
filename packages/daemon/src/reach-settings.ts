import type { Env } from "./paths.ts";

export const REACH_NOTICE = "ArmorIQ sends an anonymous daily usage ping (a random install id, plugin and version, OS, signed in or not, and daily counts of plans and blocks); turn it off with ARMORIQ_USAGE_PING_DISABLED=1 or DO_NOT_TRACK=1.";

const ENVIRONMENTS = new Map<string, "production" | "staging">([
  ["https://api.armoriq.ai", "production"],
  ["https://staging-api.armoriq.ai", "staging"],
  ["https://staging-api.armoriq.io", "staging"],
]);
export const reachEnvironment = (origin: string) => ENVIRONMENTS.get(origin);

export const pingDisabled = (env: Env): boolean =>
  ["1", "true"].includes(env.DO_NOT_TRACK?.trim().toLowerCase() ?? "") ||
  ["1", "true", "yes"].includes(env.ARMORIQ_USAGE_PING_DISABLED?.trim().toLowerCase() ?? "");

export const reminderDisabled = (env: Env): boolean =>
  ["1", "true", "yes"].includes(env.ARMORIQ_SIGNIN_REMINDER_DISABLED?.trim().toLowerCase() ?? "");
