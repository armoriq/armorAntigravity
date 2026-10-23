import pkg from "@armorantigravity/daemon/package.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BACKENDS, install, layout, normalizeBackend, preflight, uninstall, waitForSocket, type Channel, type Deps } from "./install.ts";
import { deviceLogin, hasLogin, logout } from "./login.ts";
import { realRun } from "./service.ts";
import { detectSurfaces } from "./surfaces.ts";

const HELP = `armorantigravity ${pkg.version}: ArmorIQ intent assurance for Google Antigravity

Usage:
  armorantigravity install [--channel stable|dev] [--backend <url>] [--force-login] [--skip-login]
  armorantigravity uninstall [--purge] [--logout]
  armorantigravity login [--force]
  armorantigravity status
  armorantigravity mcp            (the MCP server Antigravity starts; not for interactive use)

install    copies the binaries to ~/.armoriq/armorantigravity/bin, signs in to ArmorIQ, adds the
           armoriq hooks and MCP server to ~/.gemini/config, writes the always-on rule and starts
           armoriq-agd as a launchd agent (macOS) or systemd user unit (Linux). Safe to re-run.
uninstall  removes all of that and stops the daemon. --purge also deletes ~/.armoriq/armorantigravity
           (config, logs, queued uploads). The ArmorIQ login is kept unless --logout is given.
`;

const tty = process.stdout.isTTY;
const color = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [green, yellow, red, bold, dim] = [color("32"), color("33"), color("1;31"), color("1"), color("90")];
const ok = (s: string) => console.log(`${green("[ok]")} ${s}`);
const warn = (s: string) => console.error(`${yellow("[warn]")} ${s}`);
const info = (s: string) => console.log(`${dim("-")} ${s}`);
const section = (s: string) => console.log(`\n${bold(s)}`);

const home = homedir();
let installStarted = false;
const deps: Deps = {
  run: realRun,
  log: info,
  platform: process.platform,
  serviceLabel: process.env.ARMORANTIGRAVITY_SERVICE_LABEL?.trim() || null,
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "install":
      return cmdInstall(rest);
    case "uninstall":
      return cmdUninstall(rest);
    case "login":
      return cmdLogin(rest);
    case "status":
      return cmdStatus();
    case "mcp":
      await import("@armorantigravity/mcp/main");
      return -1;
    case "--version":
    case "version":
      console.log(pkg.version);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function cmdInstall(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      channel: { type: "string" },
      backend: { type: "string" },
      "force-login": { type: "boolean" },
      "skip-login": { type: "boolean" },
      from: { type: "string" },
    },
    strict: true,
  });
  const channel = values.channel ?? "stable";
  if (channel !== "stable" && channel !== "dev") throw new Error(`--channel must be stable or dev, got ${channel}`);
  const backend = normalizeBackend(values.backend || DEFAULT_BACKENDS[channel]);
  const sourceDir = path.resolve(values.from ?? path.dirname(process.execPath));

  console.log(bold(`ArmorAntigravity ${pkg.version} installer`) + dim(` (${channel}, ${backend})`));
  section("Checking");
  preflight(home);
  ok(`existing ~/.gemini/config files can be merged`);

  section("Connecting to ArmorIQ");
  if (values["skip-login"]) {
    warn(`skipping sign-in; armoriq-agd runs in monitor mode until you run: ${path.join(layout(home).binDir, "armorantigravity")} login`);
  } else if (!values["force-login"] && hasLogin(backend)) {
    ok(`ArmorIQ login for ${PRODUCT_AT(backend)} found, skipping sign-in`);
  } else if (await deviceLogin(backend, Boolean(values["force-login"]))) {
    ok(`signed in to ArmorIQ (${backend})`);
  } else {
    throw new Error(`ArmorIQ sign-in did not complete for ${backend}`);
  }

  section("Installing");
  installStarted = true;
  const result = await install({ home, sourceDir, version: pkg.version, channel: channel as Channel, backend }, deps);
  for (const file of result.changed) info(`wrote ${file}`);
  if (result.changed.length === 0) ok("already up to date");
  if (result.service) {
    if (result.daemonUp) ok(`armoriq-agd is running (${result.service.kind} ${result.service.label})`);
    else warn(`armoriq-agd did not open ${layout(home).socket} yet; see ${path.join(layout(home).dataDir, "logs")}. agd-hook starts it on first use.`);
  }

  for (const file of result.notStrictJson) {
    warn(`${file} has comments or trailing commas. They were kept, but agy reads this file as strict JSON and skips all of it, so ArmorIQ's entries (and yours) do not load until they are removed.`);
  }

  section("Antigravity surfaces");
  reportSurfaces();
  console.log(`\n${green(bold("ArmorAntigravity is installed."))} Restart Antigravity (2.0, IDE or agy) to load the hooks.`);
  info(`uninstall: ${path.join(layout(home).binDir, "armorantigravity")} uninstall [--purge]`);
  return 0;
}

async function cmdUninstall(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { purge: { type: "boolean" }, logout: { type: "boolean" } }, strict: true });
  const backend = installedBackend();
  section("Uninstalling ArmorAntigravity");
  const removed = await uninstall({ home, purge: Boolean(values.purge) }, deps);
  for (const line of removed) info(line);
  if (values.logout) {
    const name = backend ? logout(backend) : null;
    if (name) ok(`signed out: removed profile ${name}`);
    else info("no ArmorAntigravity login to remove");
  }
  ok(`ArmorAntigravity uninstalled.${values.logout ? "" : " Your ArmorIQ login was kept (uninstall --logout removes it)."}`);
  return 0;
}

async function cmdLogin(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { force: { type: "boolean" } }, strict: true });
  const backend = installedBackend() ?? DEFAULT_BACKENDS.stable;
  return (await deviceLogin(backend, Boolean(values.force))) ? 0 : 1;
}

async function cmdStatus(): Promise<number> {
  const l = layout(home);
  const backend = installedBackend();
  console.log(bold(`ArmorAntigravity ${pkg.version}`));
  info(`installed: ${existsSync(l.manifestFile) ? "yes" : "no"}`);
  info(`backend: ${backend ?? "not configured"}`);
  info(`login: ${backend && hasLogin(backend) ? `yes (${PRODUCT_AT(backend)})` : "no"}`);
  info(`daemon: ${(await waitForSocket(l.socket, 0)) ? `listening on ${l.socket}` : "not running"}`);
  reportSurfaces();
  return 0;
}

function reportSurfaces(): void {
  for (const s of detectSurfaces({ platform: process.platform, home, PATH: process.env.PATH ?? "" })) {
    if (s.where) ok(`${s.name}${s.version ? ` ${s.version}` : ""}: ${s.where}`);
    else info(`${s.name}: not found`);
  }
}

function installedBackend(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(layout(home).configFile, "utf8"));
    const url = typeof raw === "object" && raw !== null && "backendUrl" in raw ? raw.backendUrl : null;
    return typeof url === "string" ? normalizeBackend(url) : null;
  } catch {
    return null;
  }
}

const PRODUCT_AT = (backend: string) => `armorantigravity@${new URL(backend).host}`;

try {
  const code = await main(Bun.argv.slice(2));
  if (code >= 0) process.exit(code);
} catch (error) {
  console.error(`${red("[error]")} ${error instanceof Error ? error.message : String(error)}`);
  if (Bun.argv[2] === "install") {
    console.error(red(installStarted ? "\nArmorAntigravity install did not finish. Re-run it, or run uninstall to remove what it wrote." : "\nArmorAntigravity was NOT installed. Nothing was changed."));
  }
  process.exit(1);
}
