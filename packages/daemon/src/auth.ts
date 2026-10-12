import { clientHeaders, type ClientIdentity } from "@armoriq/sdk-dev/dist/client_identity.js";
import { getCredentialsPath, isReloginRequired, loadLoginContext } from "@armoriq/sdk-dev/dist/credentials.js";
import type { Mode } from "@armorantigravity/protocol";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import type { Log } from "./log.ts";
import { PRODUCT, type Env } from "./paths.ts";

export const DEFAULT_BACKEND = "https://api.armoriq.ai";
const RELOAD_DEBOUNCE_MS = 100;
const DIR_POLL_MS = 10_000;

export interface Login {
  readonly backend: string;
  readonly apiKey: string;
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
  readonly deviceId: string;
  readonly deviceName: string;
}

export type Refusal = "account_revoked" | "billing_blocked";

export type AuthState =
  | { readonly kind: "logged_out" }
  | { readonly kind: "active"; readonly login: Login }
  | { readonly kind: "relogin_required"; readonly login: Login }
  | { readonly kind: "refused"; readonly login: Login; readonly code: Refusal };

export interface Auth {
  readonly client: ClientIdentity;
  // X-ArmorIQ-Client for the plugin's own requests; pass `client` to the SDK for its requests.
  readonly headers: Readonly<Record<string, string>>;
  state(): AuthState;
  mode(): Mode;
  // Null while logged out or after relogin_required: audit, usage and trace pumps must stay idle.
  uploadLogin(): Login | null;
  // Call with every backend response a mint or upload gets; it applies the PRD 4a error rules.
  reportStatus(status: number, body: unknown, source: "mint" | "upload"): void;
  onChange(listener: (state: AuthState) => void): () => void;
  stop(): void;
}

type Identity = Pick<Login, "apiKey" | "userId" | "orgId" | "email">;

const envValue = (env: Env, key: string) => env[key]?.trim() || undefined;

export function clientIdentity(channel: Config["channel"]): ClientIdentity {
  return { product: channel === "dev" ? `${PRODUCT}-dev` : PRODUCT, version: pkg.version };
}

export function deviceIdentity(env: Env, armoriqDir: string): { deviceId: string; deviceName: string } {
  const deviceName = hostname().trim().slice(0, 120);
  try {
    const persisted = readFileSync(envValue(env, "ARMORIQ_DEVICE_ID_PATH") ?? path.join(armoriqDir, "device-id"), "utf8").trim();
    if (persisted) return { deviceId: persisted.slice(0, 128), deviceName };
  } catch {}
  return { deviceId: `dev_${createHash("sha256").update(deviceName).digest("hex").slice(0, 16)}`, deviceName };
}

function readProfile(backend: string): Identity | null {
  try {
    const profile = loadLoginContext({ backend, product: PRODUCT })?.profile;
    return profile ? { apiKey: profile.apiKey, userId: profile.userId, orgId: profile.orgId, email: profile.email } : null;
  } catch {
    return null;
  }
}

export function resolveBackend(env: Env, configured: string | null): string {
  return (envValue(env, "ARMORIQ_BACKEND_URL") ?? configured ?? DEFAULT_BACKEND).replace(/\/+$/, "");
}

export function readLogin(env: Env, configuredBackend: string | null): Login | null {
  const backend = resolveBackend(env, configuredBackend);
  const saved = readProfile(backend);
  const envKey = envValue(env, "ARMORIQ_API_KEY");
  const identity: Identity | null = envKey
    ? saved?.apiKey === envKey
      ? saved
      : { apiKey: envKey, userId: "", orgId: "", email: "" }
    : saved;
  if (!identity) return null;
  return { backend, ...identity, ...deviceIdentity(env, path.dirname(getCredentialsPath())) };
}

export const loginBinding = (login: Login) => createHash("sha256").update(`${login.backend}\n${login.apiKey}`).digest("hex").slice(0, 16);

// Reads credentials at startup and on directory change; state() never touches disk.
export function createAuth(log: Log, opts: { env: Env; config: Config; dataDir: string; pollMs?: number }): Auth {
  const { env, config, dataDir } = opts;
  const armoriqDir = path.dirname(getCredentialsPath());
  const client = clientIdentity(config.channel);
  const headers = clientHeaders(client);
  const listeners = new Set<(state: AuthState) => void>();
  const warned = new Set<string>();
  const markerPath = (login: Login) => path.join(dataDir, `relogin-required-${loginBinding(login)}`);
  let state = fromLogin(load());
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  function load(): Login | null {
    try {
      return readLogin(env, config.backendUrl);
    } catch (error) {
      log.error("credentials read failed", { error: String(error) });
      return null;
    }
  }

  function fromLogin(login: Login | null): AuthState {
    if (!login) return { kind: "logged_out" };
    return existsSync(markerPath(login)) ? { kind: "relogin_required", login } : { kind: "active", login };
  }

  function set(next: AuthState): void {
    if (sameState(state, next)) return;
    state = next;
    log.info("auth state", { kind: next.kind, ...(next.kind === "refused" ? { code: next.code } : {}) });
    for (const listener of listeners) listener(next);
  }

  function reload(): void {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const login = load();
      const current = "login" in state ? state.login : null;
      if (login && current && loginBinding(login) === loginBinding(current) && login.userId === current.userId) return;
      set(fromLogin(login));
    }, RELOAD_DEBOUNCE_MS);
    debounce.unref?.();
  }

  // The SDK replaces credentials.json by rename, so watch the directory rather than the file.
  function startWatch(): boolean {
    const watched = dirInode();
    if (watched === undefined) return false;
    try {
      watcher = watch(armoriqDir, { persistent: false }, () => {
        if (dirInode() !== watched) lost();
        reload();
      });
      watcher.on("error", lost);
      return true;
    } catch {
      return false;
    }
  }

  function dirInode(): number | undefined {
    try {
      return statSync(armoriqDir).ino;
    } catch {
      return undefined;
    }
  }

  // A watch on a deleted directory never fires again, even once the directory is recreated.
  function lost(): void {
    watcher?.close();
    watcher = null;
    startPolling();
  }

  function startPolling(): void {
    if (poll) return;
    poll = setInterval(() => {
      if (!startWatch()) return;
      clearInterval(poll);
      poll = undefined;
      reload();
    }, opts.pollMs ?? DIR_POLL_MS);
    poll.unref?.();
  }

  function markRelogin(login: Login): void {
    const binding = loginBinding(login);
    if (!warned.has(binding)) {
      warned.add(binding);
      log.warn(`ArmorIQ login expired; run \`armoriq login --product ${PRODUCT} --force\``);
    }
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(markerPath(login), "", { mode: 0o600 });
    } catch (error) {
      log.error("relogin marker write failed", { error: String(error) });
    }
    set({ kind: "relogin_required", login });
  }

  if (!startWatch()) startPolling();

  return {
    client,
    headers,
    state: () => state,
    mode: () => (state.kind === "logged_out" || config.forceMonitor ? "monitor" : "enforce"),
    uploadLogin: () => (state.kind === "active" || state.kind === "refused" ? state.login : null),

    reportStatus(status, body, source) {
      if (!("login" in state)) return;
      if (isReloginRequired(status, body)) return markRelogin(state.login);
      if (source !== "mint" || state.kind === "relogin_required") return;
      if (status === 401) set({ kind: "refused", login: state.login, code: "account_revoked" });
      else if (status === 402) set({ kind: "refused", login: state.login, code: "billing_blocked" });
      else if (status >= 200 && status < 300 && state.kind === "refused") set({ kind: "active", login: state.login });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop() {
      clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = null;
    },
  };
}

function sameState(a: AuthState, b: AuthState): boolean {
  if (a.kind !== b.kind) return false;
  if (!("login" in a) || !("login" in b)) return true;
  if (a.login !== b.login && loginBinding(a.login) !== loginBinding(b.login)) return false;
  return a.kind !== "refused" || b.kind !== "refused" || a.code === b.code;
}
