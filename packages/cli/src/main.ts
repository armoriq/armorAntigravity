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
  armorantigravity login [--backend <url>] [--force]
  armorantigravity status
  armorantigravity mcp            (the MCP server Antigravity starts; not for interactive use)

install    copies the binaries to ~/.armoriq/armorantigravity/bin, signs in to ArmorIQ, adds the
           armoriq hooks and MCP server to ~/.gemini/config, writes the always-on rule and starts
           armoriq-agd as a launchd agent (macOS) or systemd user unit (Linux). Safe to re-run.
uninstall  removes all of that and stops the daemon. --purge also deletes ~/.armoriq/armorantigravity
           (config, logs, queued uploads). The ArmorIQ login is kept unless --logout is given.
`;

const tty = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const color = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [green, yellow, red, bold, dim, cyan, purple] = [color("32"), color("33"), color("1;31"), color("1"), color("90"), color("38;2;0;229;204"), color("38;2;185;112;255")];
const ok = (s: string) => console.log(`${green(tty ? "✔" : "[ok]")} ${s}`);
const warn = (s: string) => process.stderr.write(`${yellow(tty ? "!" : "[warn]")} ${s}\n`);
const info = (s: string) => console.log(`${dim("-")} ${s}`);
const section = (s: string) => console.log(`\n${purple(bold(`${tty ? "┃ " : ""}${s}`))}`);

function banner(channel: string): void {
  console.log(`\n${cyan(bold("ARMORIQ"))}  ${bold("ArmorAntigravity")} ${dim(`v${pkg.version} (${channel})`)}`);
  console.log(dim("Intent capture, tool policies and audit logging\n"));
}

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

  if (process.env.ARMORANTIGRAVITY_INSTALLER_UI !== "1") banner(channel);
  section("Checking configuration");
  preflight(home);
  ok("Existing Antigravity settings can be preserved");

  section("Connect to ArmorIQ");
  info(`Backend: ${backend}`);
  if (values["skip-login"]) {
    warn("ArmorIQ sign-in was skipped");
  } else if (!values["force-login"] && hasLogin(backend)) {
    ok("Existing ArmorIQ login found. Sign-in skipped.");
  } else {
    info("Sign in to ArmorIQ, then authorize this installation once.");
    if (!(await deviceLogin(backend, Boolean(values["force-login"])))) {
      throw new Error(`ArmorIQ sign-in did not complete for ${backend}`);
    }
    ok("ArmorIQ connected");
  }

  section("Installing integration");
  installStarted = true;
  const result = await install({ home, sourceDir, version: pkg.version, channel: channel as Channel, backend }, deps);
  ok(result.changed.length === 0 ? "Integration is already up to date" : "Hooks, policy tools and intent rules configured");
  if (result.service) {
    if (result.daemonUp) ok("ArmorIQ service is ready");
    else warn(`armoriq-agd did not open ${layout(home).socket} yet; see ${path.join(layout(home).dataDir, "logs")}. agd-hook starts it on first use.`);
  }

  for (const file of result.notStrictJson) {
    warn(`${file} has comments or trailing commas. They were kept, but agy reads this file as strict JSON and skips all of it, so ArmorIQ's entries (and yours) do not load until they are removed.`);
  }

  const needsAttention = result.notStrictJson.length > 0 || (result.service !== null && !result.daemonUp);
  console.log(`\n${(needsAttention ? yellow : green)(bold(needsAttention ? "ArmorAntigravity is installed. Resolve the warnings above." : "ArmorAntigravity is installed."))}`);
  section("Quick start");
  console.log("  Restart Antigravity to load the integration.");
  if (values["skip-login"] && !hasLogin(backend)) {
    console.log("  Connect ArmorIQ to enable enforcement:");
    console.log(`  ${path.join(layout(home).binDir, "armorantigravity")} login`);
  }
  section("Manage anytime");
  console.log(`  ${path.join(layout(home).binDir, "armorantigravity")} status`);
  console.log(`  ${path.join(layout(home).binDir, "armorantigravity")} uninstall`);
  console.log(`  ${cyan("https://docs.armoriq.ai/armorantigravity")}\n`);
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
  const { values } = parseArgs({ args, options: { force: { type: "boolean" }, backend: { type: "string" } }, strict: true });
  const backend = normalizeBackend(values.backend || process.env.ARMORIQ_BACKEND_URL?.trim() || installedBackend() || DEFAULT_BACKENDS.stable);
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
