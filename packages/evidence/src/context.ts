import type { Log, Login } from "@armorantigravity/core";
import type { ClientIdentity } from "@armoriq/sdk-dev";

// The slice of the daemon's Auth the pumps use, so this package never imports the daemon.
export interface Uploads {
  readonly client: ClientIdentity;
  readonly headers: Readonly<Record<string, string>>;
  // Null while logged out or after relogin_required; every pump stays idle then.
  login(): Login | null;
  // Every backend response goes here so the daemon applies one set of 401/403/402 rules.
  report(status: number, body: unknown): void;
}

export interface EvidenceDeps {
  readonly dataDir: string;
  readonly uploads: Uploads;
  readonly log: Log;
}

export const AGENT_ID = "antigravity";
export const PRODUCT = "armorantigravity";
export const TITLE_SOURCE = "antigravity-session-title";
