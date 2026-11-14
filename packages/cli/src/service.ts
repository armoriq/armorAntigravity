import plistTemplate from "@armorantigravity/daemon/service/ai.armoriq.armorantigravity.agd.plist" with { type: "text" };
import systemdTemplate from "@armorantigravity/daemon/service/armoriq-agd.service" with { type: "text" };
import path from "node:path";

export const DEFAULT_LABEL = "ai.armoriq.armorantigravity.agd";
export const DEFAULT_SYSTEMD_UNIT = "armoriq-agd";

export type Run = (cmd: readonly string[]) => { code: number; output: string };

export interface Service {
  readonly kind: "launchd" | "systemd";
  readonly label: string;
  readonly unitPath: string;
}

export function serviceFor(platform: NodeJS.Platform, home: string, label: string | null): Service | null {
  if (platform === "darwin") {
    const name = label ?? DEFAULT_LABEL;
    return { kind: "launchd", label: name, unitPath: path.join(home, "Library", "LaunchAgents", `${name}.plist`) };
  }
  if (platform === "linux") {
    const name = label ?? DEFAULT_SYSTEMD_UNIT;
    return { kind: "systemd", label: name, unitPath: path.join(home, ".config", "systemd", "user", `${name}.service`) };
  }
  return null;
}

export function renderUnit(service: Service, home: string, daemonBin: string): string {
  // The templates' instructions mention the placeholders, so they are dropped before filling.
  const fill = (template: string, escape: (s: string) => string) =>
    template
      .replaceAll("@LABEL@", () => escape(service.label))
      .replaceAll("@AGD_BIN@", () => escape(daemonBin))
      .replaceAll("@HOME@", () => escape(home));
  return service.kind === "launchd"
    ? fill(plistTemplate.replace(/<!--[\s\S]*?-->\n/, ""), xmlEscape)
    : fill(systemdTemplate.replace(/^(?:#.*\n)+/, ""), systemdEscape);
}

export function startService(service: Service, run: Run): void {
  if (service.kind === "launchd") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    run(["launchctl", "bootout", `${domain}/${service.label}`]);
    must(run(["launchctl", "bootstrap", domain, service.unitPath]), "launchctl bootstrap");
    return;
  }
  must(run(["systemctl", "--user", "daemon-reload"]), "systemctl --user daemon-reload");
  must(run(["systemctl", "--user", "enable", `${service.label}.service`]), "systemctl --user enable");
  must(run(["systemctl", "--user", "restart", `${service.label}.service`]), "systemctl --user restart");
}

// Best effort: the unit may never have been loaded.
export function stopService(service: Service, run: Run): void {
  if (service.kind === "launchd") {
    run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${service.label}`]);
    return;
  }
  run(["systemctl", "--user", "disable", "--now", `${service.label}.service`]);
}

export function reloadServices(service: Service, run: Run): void {
  if (service.kind === "systemd") run(["systemctl", "--user", "daemon-reload"]);
}

export const realRun: Run = (cmd) => {
  try {
    const result = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
  } catch (error) {
    return { code: 127, output: String(error) };
  }
};

function must(result: { code: number; output: string }, what: string): void {
  if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code})${result.output ? `: ${result.output}` : ""}`);
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// systemd splits ExecStart on whitespace and expands % specifiers and $VARS; quote and escape them.
function systemdEscape(s: string): string {
  const escaped = s.replaceAll("%", "%%").replaceAll("$", "$$$$");
  return /[\s"\\]/.test(s) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
}
