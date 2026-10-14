import { readFileSync, statSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { backendRequest, type BackendAccess, type Fetch } from "./backend-http.ts";
import type { CompiledPolicy, CompileResult, Log } from "./core-contract.ts";
import { isRecord } from "./tools.ts";

export type PolicyOrigin = "backend" | "file" | "default" | "fail_closed";

export type ActivePolicy = {
  readonly policy: CompiledPolicy;
  readonly origin: PolicyOrigin;
  // activeVersion from GET /policies/profiles/active; null unless origin is "backend".
  readonly backendVersion: number | null;
};

export type RefreshOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "applied"; version: number; hash: string }
  | { kind: "unchanged"; version: number }
  | { kind: "no_backend_policy" }
  | { kind: "failed"; reason: string };

export interface PolicySource {
  current(): ActivePolicy;
  // Pulls the org policy. Called at session start and on a timer; never on the hook path.
  refresh(): Promise<RefreshOutcome>;
  stop(): void;
}

export type PolicySourceOptions = {
  readonly path: string;
  readonly compile: (raw: unknown) => CompileResult;
  // Used when the file is missing: the core's DEFAULT_POLICY_SOURCE.
  readonly defaultSource: unknown;
  // Null while logged out, which drops the org policy (monitor mode).
  readonly access: () => BackendAccess | null;
  readonly log: Log;
  readonly fetch?: Fetch;
  readonly pollMs?: number;
  readonly refreshMs?: number;
};

// Used only when the file exists but never compiled. Falling back to the
// all-allow default would let a corrupted policy file disable enforcement.
const FAIL_CLOSED_SOURCE = { schemaVersion: "armor.policy.v1", defaults: { decision: "deny" }, statements: [] };

type Loaded = { kind: "missing" } | { kind: "ok"; policy: CompiledPolicy } | { kind: "invalid"; error: string };

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function fingerprint(s: Stats | null): string {
  return s ? `${s.ino}:${s.size}:${s.mtimeMs}` : "missing";
}

// Local file layer ported from armorOpenCode src/state/policy-source.ts; the
// backend layer from armorClaude syncActivePolicyFromBackend. The org policy,
// when the backend has a confirmed one, wins over the file. A failed or
// invalid pull keeps whatever was enforced before; it never loosens.
export function createPolicySource(options: PolicySourceOptions): PolicySource {
  const { path, compile, log } = options;

  const mustCompile = (raw: unknown): CompiledPolicy => {
    const result = compile(raw);
    if (!result.ok) throw new Error(`built-in policy failed to compile: ${result.error}`);
    return result.policy;
  };
  const compileText = (text: string): Loaded => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { kind: "invalid", error: `policy is not valid JSON: ${String(error)}` };
    }
    const result = compile(raw);
    return result.ok ? { kind: "ok", policy: result.policy } : { kind: "invalid", error: result.error };
  };
  const statOrNull = (): Stats | null => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  };

  const fallback = mustCompile(options.defaultSource);
  let local: ActivePolicy;
  let remote: ActivePolicy | null = null;

  // The baseline is taken before the read, so an edit racing setup shows up
  // as a change on the first poll instead of being folded into the baseline.
  let seen = fingerprint(statOrNull());
  let initial: Loaded;
  try {
    initial = compileText(readFileSync(path, "utf8"));
  } catch (error) {
    initial = isMissing(error) ? { kind: "missing" } : { kind: "invalid", error: String(error) };
  }
  if (initial.kind === "ok") local = { policy: initial.policy, origin: "file", backendVersion: null };
  else if (initial.kind === "missing") local = { policy: fallback, origin: "default", backendVersion: null };
  else {
    log.error("policy rejected at startup; denying all tools until it is fixed", { path, error: initial.error });
    local = { policy: mustCompile(FAIL_CLOSED_SOURCE), origin: "fail_closed", backendVersion: null };
  }

  let polling = false;
  let stopped = false;
  // Editors that save by delete-and-recreate leave the file briefly absent;
  // only a second missing poll counts as a deletion.
  let missingPolls = 0;

  const applyLocal = (next: Loaded): void => {
    if (next.kind === "invalid") {
      log.warn("policy change rejected; keeping the last good policy", { path, error: next.error, hash: local.policy.hash });
      return;
    }
    const policy = next.kind === "ok" ? next.policy : fallback;
    if (policy.hash !== local.policy.hash || policy.intentRequired !== local.policy.intentRequired || local.origin === "fail_closed") {
      local = { policy, origin: next.kind === "ok" ? "file" : "default", backendVersion: null };
      log.info("policy reloaded", { path, hash: policy.hash, source: next.kind });
    }
  };

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const current = await stat(path).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      const print = fingerprint(current);
      if (print === seen) return;
      if (current === null && missingPolls++ === 0) return;
      missingPolls = 0;
      seen = print;
      let next: Loaded;
      try {
        next = current === null ? { kind: "missing" } : compileText(await readFile(path, "utf8"));
      } catch (error) {
        next = isMissing(error) ? { kind: "missing" } : { kind: "invalid", error: String(error) };
      }
      if (!stopped) applyLocal(next);
    } catch (error) {
      log.error("policy poll failed", { path, error: String(error) });
    } finally {
      polling = false;
    }
  };

  let inFlight: Promise<RefreshOutcome> | null = null;

  const pull = async (): Promise<RefreshOutcome> => {
    const access = options.access();
    if (!access) {
      if (remote) log.info("logged out; dropping the org policy");
      remote = null;
      return { kind: "skipped", reason: "not logged in" };
    }
    const res = await backendRequest(access, {
      method: "GET",
      path: "/policies/profiles/active",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // A pull that finishes after logout or a key change must not install the old org's policy.
    if (stopped || options.access()?.login.apiKey !== access.login.apiKey) return { kind: "skipped", reason: "login changed" };
    if (!res.ok) {
      log.warn("org policy pull failed; keeping the current policy", { reason: res.reason });
      return { kind: "failed", reason: res.reason };
    }
    const body = isRecord(res.data) ? res.data : {};
    const version = typeof body.version === "number" ? body.version : 0;
    // conmap-auto returns policy:null until an admin confirms one; the local policy then applies.
    if (body.policy === null || body.policy === undefined) {
      if (remote) log.info("org has no confirmed policy any more; using the local policy");
      remote = null;
      return { kind: "no_backend_policy" };
    }
    const compiled = compile(body.policy);
    if (!compiled.ok) {
      log.warn("org policy rejected; keeping the current policy", { error: compiled.error, version });
      return { kind: "failed", reason: `invalid org policy: ${compiled.error}` };
    }
    if (remote && remote.policy.hash === compiled.policy.hash && remote.policy.intentRequired === compiled.policy.intentRequired) {
      remote = { ...remote, backendVersion: version };
      return { kind: "unchanged", version };
    }
    remote = { policy: compiled.policy, origin: "backend", backendVersion: version };
    log.info("org policy applied", { version, hash: compiled.policy.hash });
    return { kind: "applied", version, hash: compiled.policy.hash };
  };

  const pollTimer = setInterval(() => void poll(), options.pollMs ?? 500);
  pollTimer.unref?.();
  const refresh = (): Promise<RefreshOutcome> => (inFlight ??= pull().finally(() => (inFlight = null)));
  const refreshTimer = setInterval(() => void refresh(), options.refreshMs ?? 5 * 60_000);
  refreshTimer.unref?.();

  return {
    current: () => remote ?? local,
    refresh,
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(refreshTimer);
    },
  };
}
