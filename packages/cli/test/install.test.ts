import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BINARIES, hooksValue, install, layout, mcpValue, uninstall, type Deps } from "../src/install.ts";
import { parseJsonc } from "../src/jsonc.ts";
import type { Run } from "../src/service.ts";

const LABEL = "ai.armoriq.armorantigravity.agd.test";
const HOOKS = `// hooks I wrote by hand
{
  "lint": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "lint.sh" }] }],
  },
}
`;
const MCP = `{
  /* keep me */
  "mcpServers": {
    "github": { "command": "gh-mcp" }, // personal
  },
}
`;

let root: string;
let home: string;
let source: string;
let calls: string[][];
let logs: string[];

const run: Run = (cmd) => {
  calls.push([...cmd]);
  if (cmd[0] === "ps") return realPs(cmd);
  return { code: 0, output: "" };
};
const realPs: Run = (cmd) => {
  const r = Bun.spawnSync([...cmd]);
  return { code: r.exitCode ?? 1, output: r.stdout.toString().trim() };
};
const deps = (over: Partial<Deps> = {}): Deps => ({ run, log: (l) => logs.push(l), platform: "darwin", serviceLabel: LABEL, socketWaitMs: 0, ...over });
const opts = (over: Partial<Parameters<typeof install>[0]> = {}) => ({ home, sourceDir: source, version: "0.1.0", channel: "stable" as const, backend: "https://api.armoriq.ai", ...over });
const L = () => layout(home);
const read = (file: string) => readFileSync(file, "utf8");
const seed = (hooks: string | null = HOOKS, mcp: string | null = MCP) => {
  mkdirSync(L().geminiConfig, { recursive: true });
  if (hooks !== null) writeFileSync(L().hooksFile, hooks);
  if (mcp !== null) writeFileSync(L().mcpFile, mcp);
};
const tree = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).map((p) => p.replaceAll("\\", "/")).sort() : [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agy-install-test-")));
  home = path.join(root, "home");
  source = path.join(root, "release");
  mkdirSync(home);
  mkdirSync(source);
  for (const name of BINARIES) writeFileSync(path.join(source, name), `#!/bin/sh\n# ${name}\n`, { mode: 0o755 });
  calls = [];
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install", () => {
  test("merges into existing JSONC files without touching the user's bytes", async () => {
    seed();
    await install(opts(), deps());

    const hooks = read(L().hooksFile);
    expect(hooks).toStartWith('// hooks I wrote by hand\n{\n  "armoriq": {\n');
    expect(hooks).toEndWith('\n  },\n  "lint": {\n    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "lint.sh" }] }],\n  },\n}\n');
    expect(parseJsonc(hooks)).toEqual({ lint: parseJsonc(HOOKS).lint ?? null, armoriq: hooksValue(L().binDir) });
    const mcp = parseJsonc(read(L().mcpFile));
    expect(mcp.mcpServers).toEqual({ github: { command: "gh-mcp" }, armoriq: mcpValue(L().binDir) });
    expect(read(L().mcpFile)).toStartWith('{\n  /* keep me */\n  "mcpServers": {\n    "armoriq": {');
    expect(read(L().mcpFile)).toEndWith('    },\n    "github": { "command": "gh-mcp" }, // personal\n  },\n}\n');
  });

  test("flags the files agy cannot read because they are not strict JSON", async () => {
    seed(HOOKS, '{\n  "mcpServers": {}\n}\n');
    expect((await install(opts(), deps())).notStrictJson).toEqual([L().hooksFile]);
    writeFileSync(L().hooksFile, '{"lint": {}}');
    expect((await install(opts(), deps())).notStrictJson).toEqual([]);
  });

  test("points every hook and the MCP server at the installed binaries", async () => {
    seed();
    await install(opts(), deps());
    const hook = path.join(L().binDir, "agd-hook");
    const value = hooksValue(L().binDir);
    expect(Object.keys(value)).toEqual(["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]);
    expect(JSON.stringify(value)).not.toContain("bun");
    expect(value.Stop).toEqual([{ type: "command", command: `${hook} Stop`, timeout: 30 }]);
    expect(value.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: `${hook} PreToolUse`, timeout: 30 }] }]);
    for (const name of BINARIES) expect(read(path.join(L().binDir, name))).toBe(read(path.join(source, name)));
    expect(mcpValue(L().binDir)).toEqual({ command: path.join(L().binDir, "armorantigravity"), args: ["mcp"] });
  });

  test("writes the rule, the daemon config and a launchd agent, then starts it", async () => {
    seed();
    const result = await install(opts({ channel: "dev", backend: "https://staging-api.armoriq.io/" }), deps());
    expect(read(L().rulesFile)).toStartWith("---\ntrigger: always_on\n---\n");
    expect(JSON.parse(read(L().configFile))).toEqual({ backendUrl: "https://staging-api.armoriq.io", channel: "dev" });
    const unitPath = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    expect(result.service).toEqual({ kind: "launchd", label: LABEL, unitPath });
    const plist = read(unitPath);
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain(`<string>${path.join(L().binDir, "armoriq-agd")}</string>`);
    expect(plist).toContain(`<key>HOME</key>\n    <string>${home}</string>`);
    expect(plist).not.toContain("@");
    const uid = process.getuid?.() ?? 0;
    expect(calls.filter((c) => c[0] === "launchctl").at(-1)).toEqual(["launchctl", "bootstrap", `gui/${uid}`, unitPath]);
  });

  test("keeps settings the user added to the daemon config", async () => {
    mkdirSync(L().dataDir, { recursive: true });
    writeFileSync(L().configFile, JSON.stringify({ backendUrl: "https://old.example", mode: "monitor" }));
    await install(opts(), deps());
    expect(JSON.parse(read(L().configFile))).toEqual({ backendUrl: "https://api.armoriq.ai", mode: "monitor", channel: "stable" });
  });

  test("is idempotent", async () => {
    seed();
    await install(opts(), deps());
    const snapshot = Object.fromEntries([L().hooksFile, L().mcpFile, L().rulesFile, L().configFile].map((f) => [f, read(f)]));
    const second = await install(opts(), deps());
    expect(second.changed).toEqual([]);
    for (const [file, text] of Object.entries(snapshot)) expect(read(file)).toBe(text);
  });

  test("refuses a config it cannot parse and changes nothing", async () => {
    seed('{ "lint": { ', MCP);
    await expect(install(opts(), deps())).rejects.toThrow("hooks.json cannot be edited safely");
    expect(read(L().hooksFile)).toBe('{ "lint": { ');
    expect(read(L().mcpFile)).toBe(MCP);
    expect(existsSync(L().dataDir)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("replaces and then removes an existing armoriq entry that follows a line comment", async () => {
    seed(HOOKS, '{"mcpServers": { // mine\n  "armoriq": {"command": "old"}}}');
    await install(opts(), deps());
    await uninstall({ home, purge: false }, deps());
    expect(read(L().mcpFile)).toBe('{"mcpServers": { // mine\n}}');
  });

  test("restores a rule file of the same name that the user wrote", async () => {
    mkdirSync(path.dirname(L().rulesFile), { recursive: true });
    writeFileSync(L().rulesFile, "my own armoriq notes\n");
    await install(opts(), deps());
    expect(read(L().rulesFile)).toContain("ArmorIQ intent enforcement");
    await uninstall({ home, purge: false }, deps());
    expect(read(L().rulesFile)).toBe("my own armoriq notes\n");
  });

  test("refuses an mcpServers that is not an object", async () => {
    seed(HOOKS, '{"mcpServers": []}');
    await expect(install(opts(), deps())).rejects.toThrow('"mcpServers" is not an object');
  });

  test("takes over a dev-install: replaces its entries and drops its manifest", async () => {
    const devHooks = { armoriq: { Stop: [{ type: "command", command: "ARMORANTIGRAVITY_DAEMON='/repo/dist/armoriq-agd' '/repo/dist/agd-hook' Stop", timeout: 30 }] }, lint: { Stop: [] } };
    seed(`${JSON.stringify(devHooks, null, 2)}\n`, `${JSON.stringify({ mcpServers: { armoriq: { command: "/usr/local/bin/bun", args: ["/repo/packages/mcp/src/main.ts"] } } }, null, 2)}\n`);
    mkdirSync(L().dataDir, { recursive: true });
    writeFileSync(path.join(L().dataDir, "dev-install.json"), "{}");

    await install(opts(), deps());
    expect(parseJsonc(read(L().hooksFile)).armoriq).toEqual(hooksValue(L().binDir));
    expect(parseJsonc(read(L().mcpFile)).mcpServers).toEqual({ armoriq: mcpValue(L().binDir) });
    expect(existsSync(path.join(L().dataDir, "dev-install.json"))).toBe(false);

    await uninstall({ home, purge: false }, deps());
    expect(parseJsonc(read(L().hooksFile))).toEqual({ lint: { Stop: [] } });
    expect(parseJsonc(read(L().mcpFile))).toEqual({});
  });
});

describe("uninstall", () => {
  test("restores the user's files byte for byte and removes what install added", async () => {
    seed();
    writeFileSync(path.join(L().geminiConfig, "rules-other.md"), "mine");
    mkdirSync(path.join(home, ".armoriq"), { recursive: true });
    writeFileSync(path.join(home, ".armoriq", "credentials.json"), '{"profiles":{}}');
    await install(opts(), deps());
    await install(opts(), deps());
    calls = [];

    expect(await uninstall({ home, purge: false }, deps())).toEqual([
      `restored ${L().hooksFile}`,
      `restored ${L().mcpFile}`,
      `removed ${path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`)}`,
      `removed ${L().rulesFile}`,
      `removed ${L().manifestFile}`,
      `removed ${L().binDir}`,
    ]);
    expect(read(L().hooksFile)).toBe(HOOKS);
    expect(read(L().mcpFile)).toBe(MCP);
    expect(existsSync(L().rulesFile)).toBe(false);
    expect(existsSync(path.dirname(L().rulesFile))).toBe(false);
    expect(existsSync(L().binDir)).toBe(false);
    expect(existsSync(L().manifestFile)).toBe(false);
    expect(existsSync(path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
    expect(calls).toContainEqual(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
    expect(read(path.join(home, ".armoriq", "credentials.json"))).toBe('{"profiles":{}}');
    expect(existsSync(L().configFile)).toBe(true);
  });

  test("keeps edits the user made after install", async () => {
    seed();
    await install(opts(), deps());
    writeFileSync(L().hooksFile, read(L().hooksFile).replace('"lint": {', '"fmt": { "Stop": [] },\n  "lint": {'));
    await uninstall({ home, purge: false }, deps());
    const hooks = read(L().hooksFile);
    expect(Object.keys(parseJsonc(hooks))).toEqual(["fmt", "lint"]);
    expect(hooks).toStartWith("// hooks I wrote by hand\n");
  });

  test("restores an empty mcp_config.json and deletes files it created", async () => {
    seed(null, "");
    await install(opts(), deps());
    expect(parseJsonc(read(L().hooksFile))).toEqual({ armoriq: hooksValue(L().binDir) });
    await uninstall({ home, purge: false }, deps());
    expect(read(L().mcpFile)).toBe("");
    expect(existsSync(L().hooksFile)).toBe(false);
  });

  test("--purge removes the data directory and keeps the login", async () => {
    mkdirSync(path.join(home, ".armoriq", "armoropencode"), { recursive: true });
    writeFileSync(path.join(home, ".armoriq", "credentials.json"), "{}");
    await install(opts(), deps());
    mkdirSync(path.join(L().dataDir, "logs"), { recursive: true });
    writeFileSync(path.join(L().dataDir, "logs", "agd.log"), "x");

    await uninstall({ home, purge: true }, deps());
    expect(existsSync(L().dataDir)).toBe(false);
    expect(tree(home)).toEqual([".armoriq", ".armoriq/armoropencode", ".armoriq/credentials.json"]);
  });

  test("on a fresh home, install then uninstall --purge leaves nothing behind", async () => {
    await install(opts(), deps());
    await uninstall({ home, purge: true }, deps());
    expect(tree(home)).toEqual([]);
  });

  test("stops a running armoriq-agd and leaves an unrelated pid alone", async () => {
    await install(opts(), deps());
    const fakeDaemon = path.join(root, "armoriq-agd");
    copyFileSync("/bin/sleep", fakeDaemon);
    chmodSync(fakeDaemon, 0o755);
    const daemon = Bun.spawn([fakeDaemon, "60"]);
    const other = Bun.spawn(["/bin/sleep", "60"]);
    try {
      writeFileSync(L().lockFile, `${other.pid}\n`);
      await uninstall({ home, purge: false }, deps());
      expect(other.killed || other.exitCode !== null).toBe(false);

      await install(opts(), deps());
      writeFileSync(L().lockFile, `${daemon.pid}\n`);
      await uninstall({ home, purge: false }, deps());
      expect(await daemon.exited).not.toBe(0);
      expect(logs).toContain(`stopped armoriq-agd (pid ${daemon.pid})`);
    } finally {
      daemon.kill();
      other.kill();
    }
  });
});

test("installs a systemd user unit on Linux", async () => {
  await install(opts(), deps({ platform: "linux", serviceLabel: null }));
  const unit = path.join(home, ".config", "systemd", "user", "armoriq-agd.service");
  expect(read(unit)).toContain(`ExecStart=${path.join(L().binDir, "armoriq-agd")}\n`);
  expect(calls.filter((c) => c[0] === "systemctl")).toEqual([
    ["systemctl", "--user", "disable", "--now", "armoriq-agd.service"],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "armoriq-agd.service"],
    ["systemctl", "--user", "restart", "armoriq-agd.service"],
  ]);
  calls = [];
  await uninstall({ home, purge: false }, deps({ platform: "linux", serviceLabel: null }));
  expect(existsSync(unit)).toBe(false);
  expect(calls.filter((c) => c[0] === "systemctl")).toEqual([
    ["systemctl", "--user", "disable", "--now", "armoriq-agd.service"],
    ["systemctl", "--user", "daemon-reload"],
  ]);
});
