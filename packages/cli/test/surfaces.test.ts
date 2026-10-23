import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderUnit, serviceFor } from "../src/service.ts";
import { detectSurfaces } from "../src/surfaces.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agy-surfaces-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bundle = (dir: string, name: string, version: string) => {
  mkdirSync(path.join(dir, name, "Contents"), { recursive: true });
  writeFileSync(
    path.join(dir, name, "Contents", "Info.plist"),
    `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict></plist>\n`,
  );
};
const executable = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
};

test("reports the 2.0 app, the IDE and agy on macOS", () => {
  const apps = path.join(root, "Applications");
  const userApps = path.join(root, "home", "Applications");
  bundle(apps, "Antigravity.app", "2.22.0");
  bundle(userApps, "Antigravity IDE.app", "2.5.5");
  executable(path.join(root, "bin"), "agy");

  const found = detectSurfaces({ platform: "darwin", home: path.join(root, "home"), PATH: path.join(root, "bin"), appDirs: [apps, userApps] });
  expect(found).toEqual([
    { id: "app", name: "Antigravity 2.0", where: path.join(apps, "Antigravity.app"), version: "2.22.0" },
    { id: "ide", name: "Antigravity IDE", where: path.join(userApps, "Antigravity IDE.app"), version: "2.5.5" },
    { id: "cli", name: "agy CLI", where: path.join(root, "bin", "agy"), version: null },
  ]);
});

test("reports each missing surface", () => {
  const found = detectSurfaces({ platform: "darwin", home: root, PATH: "", appDirs: [root] });
  expect(found.map((s) => [s.id, s.where])).toEqual([["app", null], ["ide", null], ["cli", null]]);
});

test("finds agy in ~/.local/bin when it is not on PATH", () => {
  executable(path.join(root, ".local", "bin"), "agy");
  const [, , cli] = detectSurfaces({ platform: "linux", home: root, PATH: "", linuxRoots: [] });
  expect(cli?.where).toBe(path.join(root, ".local", "bin", "agy"));
});

test("finds Linux installs by directory or launcher", () => {
  mkdirSync(path.join(root, "opt", "Antigravity"), { recursive: true });
  executable(path.join(root, "bin"), "antigravity-ide");
  const [app, ide] = detectSurfaces({ platform: "linux", home: root, PATH: path.join(root, "bin"), linuxRoots: [path.join(root, "opt")] });
  expect(app?.where).toBe(path.join(root, "opt", "Antigravity"));
  expect(ide?.where).toBe(path.join(root, "bin", "antigravity-ide"));
});

test("escapes paths in the generated units", () => {
  const home = "/Users/a&b <c>";
  const launchd = serviceFor("darwin", home, null);
  const systemd = serviceFor("linux", home, null);
  if (!launchd || !systemd) throw new Error("no service");
  expect(launchd.label).toBe("ai.armoriq.armorantigravity.agd");
  expect(renderUnit(launchd, home, `${home}/bin/armoriq-agd`)).toContain("<string>/Users/a&amp;b &lt;c&gt;/bin/armoriq-agd</string>");
  expect(renderUnit(systemd, home, "/home/x y/100%/armoriq-agd")).toContain('ExecStart="/home/x y/100%%/armoriq-agd"\n');
  expect(renderUnit(systemd, home, "/home/a$USER/armoriq-agd")).toContain("ExecStart=/home/a$$USER/armoriq-agd\n");
  expect(renderUnit(launchd, "/Users/a$&b", "/x")).toContain("<string>/Users/a$&amp;b</string>");
  expect(renderUnit(launchd, home, "/x")).not.toContain("<!--");
  expect(renderUnit(systemd, home, "/x")).toStartWith("[Unit]\n");
  expect(serviceFor("win32", home, null)).toBeNull();
});
