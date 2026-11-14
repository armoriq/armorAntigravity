import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SurfaceReport {
  readonly id: "app" | "ide" | "cli";
  readonly name: string;
  readonly where: string | null;
  readonly version: string | null;
}

export interface DetectOptions {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly PATH: string;
  // Defaults to /Applications and ~/Applications on macOS.
  readonly appDirs?: readonly string[];
  // Linux install roots; defaults to /opt, /usr/share and ~/.local/share.
  readonly linuxRoots?: readonly string[];
}

// The agy binary is only located, never run: running it can trigger its self-updater.
export function detectSurfaces(opts: DetectOptions): SurfaceReport[] {
  const { platform, home, PATH } = opts;
  const which = (cmd: string) => Bun.which(cmd, { PATH }) ?? null;
  const agy = which("agy") ?? firstExisting([path.join(home, ".local", "bin", "agy")]);
  const cli: SurfaceReport = { id: "cli", name: "agy CLI", where: agy, version: null };

  if (platform === "darwin") {
    const dirs = opts.appDirs ?? ["/Applications", path.join(home, "Applications")];
    const bundle = (name: string) => firstExisting(dirs.map((d) => path.join(d, name)));
    const app = bundle("Antigravity.app");
    const ide = bundle("Antigravity IDE.app");
    return [
      { id: "app", name: "Antigravity 2.0", where: app, version: app && bundleVersion(app) },
      { id: "ide", name: "Antigravity IDE", where: ide, version: ide && bundleVersion(ide) },
      cli,
    ];
  }
  const roots = opts.linuxRoots ?? ["/opt", "/usr/share", path.join(home, ".local", "share")];
  const app = firstExisting(roots.flatMap((r) => [path.join(r, "Antigravity"), path.join(r, "antigravity")])) ?? which("antigravity");
  const ide = firstExisting(roots.flatMap((r) => [path.join(r, "Antigravity IDE"), path.join(r, "antigravity-ide")])) ?? which("antigravity-ide");
  return [
    { id: "app", name: "Antigravity 2.0", where: app, version: null },
    { id: "ide", name: "Antigravity IDE", where: ide, version: null },
    cli,
  ];
}

function firstExisting(paths: readonly string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

function bundleVersion(bundle: string): string | null {
  try {
    const plist = readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}
