import { removeProfile, saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createAuth, loginBinding, readLogin, resolveBackend, type Auth, type AuthState } from "../src/auth.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { Log } from "../src/log.ts";
import { sandboxHome } from "./sandbox.ts";

const STAGING = "https://staging-api.armoriq.ai";
const quiet: Log = { info() {}, warn() {}, error() {} };
let sandbox: ReturnType<typeof sandboxHome>;
let auth: Auth | null = null;

beforeEach(() => {
  sandbox = sandboxHome();
});
afterEach(() => {
  auth?.stop();
  auth = null;
  sandbox.cleanup();
});

const save = (backend: string, product: string, apiKey: string) =>
  saveLoginProfile({ backend, product, apiKey, email: "dev@example.com", userId: "user-1", orgId: "org-1" });
const dataDir = () => path.join(sandbox.home, ".armoriq", "armorantigravity");
const start = (config: Partial<Config> = {}, env: Record<string, string> = {}) =>
  (auth = createAuth(quiet, { env, config: { ...DEFAULT_CONFIG, backendUrl: STAGING, ...config }, dataDir: dataDir(), pollMs: 50 }));
const nextChange = (a: Auth) => new Promise<AuthState>((resolve) => a.onChange(resolve));

test("backend order is ARMORIQ_BACKEND_URL, then config, then prod", () => {
  expect(resolveBackend({ ARMORIQ_BACKEND_URL: "http://localhost:3000/" }, STAGING)).toBe("http://localhost:3000");
  expect(resolveBackend({}, STAGING)).toBe(STAGING);
  expect(resolveBackend({ ARMORIQ_BACKEND_URL: "  " }, null)).toBe("https://api.armoriq.ai");
});

test("only the armorantigravity profile for the resolved backend counts", () => {
  save(STAGING, "armoropencode", "ak_opencode");
  save("https://api.armoriq.ai", "armorantigravity", "ak_prod");
  expect(readLogin({}, STAGING)).toBeNull();
  save(STAGING, "armorantigravity", "ak_staging");
  expect(readLogin({}, STAGING)).toMatchObject({ backend: STAGING, apiKey: "ak_staging", userId: "user-1", email: "dev@example.com" });
});

test("ARMORIQ_API_KEY overrides the stored key and keeps the profile only when it matches", () => {
  save(STAGING, "armorantigravity", "ak_staging");
  expect(readLogin({ ARMORIQ_API_KEY: "ak_staging" }, STAGING)).toMatchObject({ apiKey: "ak_staging", userId: "user-1" });
  expect(readLogin({ ARMORIQ_API_KEY: "ak_other" }, STAGING)).toMatchObject({ apiKey: "ak_other", userId: "", email: "" });
  rmSync(path.join(sandbox.home, ".armoriq", "credentials.json"));
  expect(readLogin({ ARMORIQ_API_KEY: "ak_env_only" }, STAGING)).toMatchObject({ apiKey: "ak_env_only" });
});

test("the client header carries the channel and the package version", () => {
  const stable = start();
  expect(stable.headers).toEqual({ "X-ArmorIQ-Client": `armorantigravity/${stable.client.version}` });
  stable.stop();
  expect(start({ channel: "dev" }).headers["X-ArmorIQ-Client"]).toMatch(/^armorantigravity-dev\/\d+\.\d+\.\d+$/);
});

test("login and logout through the SDK flip the mode within the debounce", async () => {
  mkdirSync(path.join(sandbox.home, ".armoriq"), { recursive: true });
  const a = start();
  expect(a.mode()).toBe("monitor");
  expect(a.uploadLogin()).toBeNull();

  const loggedIn = nextChange(a);
  save(STAGING, "armorantigravity", "ak_1");
  expect((await loggedIn).kind).toBe("active");
  expect(a.mode()).toBe("enforce");
  expect(a.uploadLogin()?.apiKey).toBe("ak_1");

  const loggedOut = nextChange(a);
  removeProfile(`armorantigravity@staging-api.armoriq.ai`);
  expect((await loggedOut).kind).toBe("logged_out");
  expect(a.mode()).toBe("monitor");
});

test("a login saved under the ARMORIQ_API_KEY already in use fills in the identity", async () => {
  mkdirSync(path.join(sandbox.home, ".armoriq"), { recursive: true });
  const a = start({}, { ARMORIQ_API_KEY: "ak_1" });
  expect(a.state()).toMatchObject({ kind: "active", login: { apiKey: "ak_1", userId: "" } });

  const identified = nextChange(a);
  save(STAGING, "armorantigravity", "ak_1");
  expect(await identified).toMatchObject({ kind: "active", login: { apiKey: "ak_1", userId: "user-1", orgId: "org-1" } });
});

test("a deleted ~/.armoriq falls back to polling and picks up a later login", async () => {
  const a = start();
  expect(a.state().kind).toBe("logged_out");
  const loggedIn = nextChange(a);
  save(STAGING, "armorantigravity", "ak_late");
  expect((await loggedIn).kind).toBe("active");
});

test("403 relogin_required writes the marker, pauses uploads, and survives a restart until the key changes", async () => {
  save(STAGING, "armorantigravity", "ak_1");
  const a = start();
  const login = a.uploadLogin();
  if (!login) throw new Error("expected a login");
  a.reportStatus(403, { error: "forbidden" }, "upload");
  expect(a.state().kind).toBe("active");

  a.reportStatus(403, { error: "relogin_required" }, "upload");
  expect(a.state().kind).toBe("relogin_required");
  expect(a.uploadLogin()).toBeNull();
  expect(a.mode()).toBe("enforce");
  expect(readdirSync(dataDir())).toEqual([`relogin-required-${loginBinding(login)}`]);

  a.stop();
  const restarted = start();
  expect(restarted.state().kind).toBe("relogin_required");

  const relogged = nextChange(restarted);
  save(STAGING, "armorantigravity", "ak_2");
  expect((await relogged).kind).toBe("active");
  expect(restarted.uploadLogin()?.apiKey).toBe("ak_2");
});

test("401 and 402 on mint refuse until a mint succeeds; uploads never refuse", () => {
  save(STAGING, "armorantigravity", "ak_1");
  const a = start();
  a.reportStatus(401, {}, "upload");
  expect(a.state().kind).toBe("active");
  a.reportStatus(401, {}, "mint");
  expect(a.state()).toMatchObject({ kind: "refused", code: "account_revoked" });
  a.reportStatus(402, {}, "mint");
  expect(a.state()).toMatchObject({ kind: "refused", code: "billing_blocked" });
  expect(a.uploadLogin()?.apiKey).toBe("ak_1");
  a.reportStatus(200, {}, "mint");
  expect(a.state().kind).toBe("active");
});

test("config mode monitor keeps a logged-in user in monitor", () => {
  save(STAGING, "armorantigravity", "ak_1");
  expect(start({ forceMonitor: true }).mode()).toBe("monitor");
});
