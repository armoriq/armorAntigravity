import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { install, layout, PAYLOAD, type Deps } from "../src/install.ts";
import contract from "../../daemon/test/fixtures/install-ping-v1.json";

const CLI = path.resolve(import.meta.dir, "../src/main.ts");
let root: string;
let home: string;
let source: string;
let lines: string[];
const marker = () => path.join(home, ".armoriq/reach/v1/armorantigravity/notice-shown");
const options = () => ({ home, sourceDir: source, version: "0.1.0", channel: "dev" as const, backend: "https://staging-api.armoriq.ai" });
const deps = (env: Record<string, string> = {}): Deps => ({
  env, run: () => ({ code: 0, output: "" }), platform: "win32", serviceLabel: null, log: (line) => { lines.push(line); },
});
beforeEach(() => {
  root = mkdtempSync("/tmp/agr-cli-");
  home = path.join(root, "O'Neil home"); source = path.join(root, "release"); lines = [];
  mkdirSync(home); mkdirSync(source);
  for (const name of PAYLOAD) writeFileSync(path.join(source, name), "// fixture\n", { mode: 0o755 });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("CLI installer prints the exact notice once per home and creates a private marker without an install id", async () => {
  await install(options(), deps());
  expect(lines.filter((line) => line === contract.notice)).toEqual([contract.notice]);
  expect(statSync(marker()).mode & 0o777).toBe(0o600);
  expect(existsSync(path.join(home, ".armoriq/install-id"))).toBe(false);
  await install(options(), deps());
  expect(lines.filter((line) => line === contract.notice)).toHaveLength(1);
});

for (const [key, values] of Object.entries(contract.optOut.env)) {
  for (const value of [...values.disablingValues, ...values.disablingValues.map((text) => ` ${text.toUpperCase()} `), "0", "false", "no", "unknown", ...(key === "DO_NOT_TRACK" ? ["yes"] : [])]) {
    test(`CLI installer persists ${key}=${value} with the contract truth table and keeps other keys`, async () => {
      const disabled = values.disablingValues.includes(value.trim().toLowerCase());
      const l = layout(home); mkdirSync(l.dataDir, { recursive: true });
      const original = { backendUrl: "https://old.example", mode: "monitor", extra: { keep: [1, "x"] }, signInReminder: true };
      writeFileSync(l.configFile, JSON.stringify(original));
      await install(options(), deps({ [key]: value }));
      expect(JSON.parse(readFileSync(l.configFile, "utf8"))).toEqual({ ...original, backendUrl: options().backend, channel: "dev", ...(disabled ? { usagePing: false } : {}) });
      expect(existsSync(marker())).toBe(!disabled);
      expect(lines.includes(contract.notice)).toBe(!disabled);
    });
  }
}
for (const value of ["1", "true", "yes", " TRUE ", " YeS ", "0", "false", "unknown"]) {
  test(`CLI installer persists reminder opt out ${value} independently and never re enables existing opt outs`, async () => {
    const l = layout(home); mkdirSync(l.dataDir, { recursive: true });
    writeFileSync(l.configFile, '{"mode":"monitor","usagePing":false}');
    const disabled = ["1", "true", "yes"].includes(value.trim().toLowerCase());
    await install(options(), deps({ ARMORIQ_SIGNIN_REMINDER_DISABLED: value }));
    const expected = { backendUrl: options().backend, channel: "dev", mode: "monitor", usagePing: false, ...(disabled ? { signInReminder: false } : {}) };
    expect(JSON.parse(readFileSync(l.configFile, "utf8"))).toEqual(expected);
    await install(options(), deps());
    expect(JSON.parse(readFileSync(l.configFile, "utf8"))).toEqual(expected);
    expect(existsSync(marker())).toBe(false); expect(lines.includes(contract.notice)).toBe(false);
  });
}
test("reminder opt out alone does not suppress installer notice", async () => {
  await install(options(), deps({ ARMORIQ_SIGNIN_REMINDER_DISABLED: "yes" }));
  expect(lines).toContain(contract.notice); expect(existsSync(marker())).toBe(true);
  expect(JSON.parse(readFileSync(layout(home).configFile, "utf8"))).toMatchObject({ signInReminder: false });
});

test("CLI installer does not claim a usage notice for a backend outside the contract", async () => {
  await install({ ...options(), backend: "https://custom.example" }, deps());
  expect(lines).not.toContain(contract.notice); expect(existsSync(marker())).toBe(false);
});

for (const settings of ['{"usagePing":false}', '{"usagePing":"false"}', "{", "null", "[]"]) {
  test(`CLI installer respects shared ping opt out ${settings}`, async () => {
    mkdirSync(path.join(home, ".armoriq"), { recursive: true });
    writeFileSync(path.join(home, ".armoriq/settings.json"), settings);
    await install(options(), deps());
    expect(lines).not.toContain(contract.notice); expect(existsSync(marker())).toBe(false);
  });
}

for (const source of ["settings", "config"]) {
  test(`CLI installer treats symlinked ${source} as unreadable and leaves it intact`, async () => {
    const file = source === "settings" ? path.join(home, ".armoriq/settings.json") : layout(home).configFile;
    mkdirSync(path.dirname(file), { recursive: true });
    const target = path.join(root, `${source}.json`);
    const contents = JSON.stringify({ backendUrl: options().backend, channel: "dev" });
    writeFileSync(target, contents);
    symlinkSync(target, file);
    await install(options(), deps());
    expect(lines).not.toContain(contract.notice);
    expect(existsSync(marker())).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(contents);
  });
}

async function cli(args: string[], env: Record<string, string> = {}) {
  const tools = path.join(root, "tools"); mkdirSync(tools, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) writeFileSync(path.join(tools, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root, env: { HOME: home, PATH: `${tools}:${process.env.PATH ?? ""}`, ARMORANTIGRAVITY_SERVICE_LABEL: "ai.armoriq.agd.reach.test", ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}
const command = (backend: string) => `'${path.join(layout(home).binDir, "armorantigravity").replaceAll("'", "'\\''")}' login --backend '${backend}'`;

test("--skip-login prints a quoted, executable command with the chosen backend and the installer notice", async () => {
  const l = layout(home); mkdirSync(l.dataDir, { recursive: true });
  const backend = "https://staging-api.armoriq.io";
  const result = await cli(["install", "--force", "--skip-login", "--backend", backend, "--from", source]);
  expect(result.code).toBe(0); expect(result.stdout).toContain(command(backend));
  expect(result.stdout).toContain(contract.notice); expect(existsSync(marker())).toBe(true);
  // Run the printed shell command from another directory and inspect its arguments.
  writeFileSync(path.join(source, "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(path.join(l.binDir, "cli.js"), readFileSync(path.join(source, "cli.js")));
  const proc = Bun.spawn(["/bin/sh", "-c", command(backend)], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(await new Response(proc.stdout).text())).toEqual(["login", "--backend", backend]);
}, 15000);

for (const backend of ["https://api.armoriq.ai", "https://staging-api.armoriq.io"]) {
  test(`status without a login prints the installed backend command for ${backend}`, async () => {
    await install({ ...options(), backend }, deps({ DO_NOT_TRACK: "1" }));
    const result = await cli(["status"]);
    expect(result.code).toBe(0); expect(result.stdout).toContain("login: no");
    expect(result.stdout).toContain(command(backend)); expect(result.stdout).not.toContain("--force");
  });
}
test("status login hint uses the effective environment override", async () => {
  await install(options(), deps({ DO_NOT_TRACK: "1" }));
  const result = await cli(["status"], { ARMORIQ_BACKEND_URL: "https://api.armoriq.ai/" });
  expect(result.code).toBe(0); expect(result.stdout).toContain(command("https://api.armoriq.ai"));
});

for (const issue of ["relogin-required", "login-refused"]) {
  test(`status reports ${issue} for a saved login and prints a forced command`, async () => {
    await install(options(), deps({ DO_NOT_TRACK: "1" }));
    const backend = options().backend;
    const apiKey = "test-saved-key";
    writeFileSync(path.join(home, ".armoriq/credentials.json"), JSON.stringify({
      version: 2,
      loginHistory: { "armorantigravity@staging-api.armoriq.ai": { id: crypto.randomUUID(), origin: "fresh", events: [{ sequence: 1, at: "2026-11-15T00:00:00.000Z", userId: "u" }] } },
      profiles: { "armorantigravity@staging-api.armoriq.ai": { apiKey, backend, product: "armorantigravity", userId: "u", orgId: "o", email: "test@example.com", loggedInAt: "2026-11-15T00:00:00.000Z", savedAt: "2026-11-15T00:00:00.000Z" } },
    }));
    const binding = createHash("sha256").update(`${backend}\n${apiKey}`).digest("hex").slice(0, 16);
    writeFileSync(path.join(layout(home).dataDir, `${issue}-${binding}`), "");
    const result = await cli(["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(issue === "relogin-required" ? "login: expired" : "login: refused");
    expect(result.stdout).not.toContain("login: yes");
    expect(result.stdout).toContain(`${command(backend)} --force`);
  });
}
test("CLI help documents every environment switch", async () => {
  const result = await cli(["--help"]);
  expect(result.code).toBe(0);
  for (const key of ["DO_NOT_TRACK", "ARMORIQ_USAGE_PING_DISABLED", "ARMORIQ_SIGNIN_REMINDER_DISABLED"]) expect(result.stdout).toContain(key);
});
