import { describe, expect, test } from "bun:test";
import { checkGuard, guardPaths, shellWritesGuard, type GuardContext } from "../src/guard.ts";
import { mapToolCall } from "../src/tools.ts";

const home = "/Users/dev";
const ctx: GuardContext = { home, protectedPaths: guardPaths(home), workspace: "/Users/dev/src/shop-api" };
const HOOKS = "/Users/dev/.gemini/config/hooks.json";
const RULE = "/Users/dev/.gemini/config/rules/armoriq.md";
const MCP = "/Users/dev/.gemini/config/mcp_config.json";
const PLUGIN = "/Users/dev/.gemini/config/plugins/armoriq";

const shell = (command: string, cwd: string | null = ctx.workspace) => shellWritesGuard(command, cwd, ctx);

describe("run_command writes to guard files are blocked", () => {
  test.each([
    ["redirect", "echo '{}' > ~/.gemini/config/hooks.json", HOOKS],
    ["append redirect", "echo x >> $HOME/.gemini/config/rules/armoriq.md", RULE],
    ["clobber redirect", "echo x >| /Users/dev/.gemini/config/mcp_config.json", MCP],
    ["&> redirect", "true &> ~/.gemini/config/hooks.json", HOOKS],
    ["rm", "rm ~/.gemini/config/hooks.json", HOOKS],
    ["rm -rf plugin dir", "rm -rf ~/.gemini/config/plugins/armoriq", PLUGIN],
    ["rm of a file inside the plugin dir", "rm ~/.gemini/config/plugins/armoriq/hooks.json", PLUGIN],
    ["rm -rf parent directory", "rm -rf ~/.gemini", HOOKS],
    ["rm with glob", "rm ~/.gemini/config/*.json", HOOKS],
    ["rm -rf glob over parent", "rm -rf ~/.gemini/*", HOOKS],
    ["mv away", "mv ~/.gemini/config/hooks.json /tmp/h.json", HOOKS],
    ["mv over", "mv /tmp/evil.json ~/.gemini/config/mcp_config.json", MCP],
    ["mv into dir", "mv /tmp/hooks.json ~/.gemini/config/", HOOKS],
    ["cp over", "cp /tmp/x.json /Users/dev/.gemini/config/hooks.json", HOOKS],
    ["sed -i", "sed -i '' 's/armoriq//' ~/.gemini/config/hooks.json", HOOKS],
    ["sed -i with -e", "sed -i -e 's/a/b/' ~/.gemini/config/rules/armoriq.md", RULE],
    ["sed --in-place", "sed --in-place 's/a/b/' ~/.gemini/config/mcp_config.json", MCP],
    ["tee", "echo {} | tee ~/.gemini/config/hooks.json", HOOKS],
    ["truncate", "truncate -s 0 ~/.gemini/config/hooks.json", HOOKS],
    ["dd", "dd if=/dev/null of=/Users/dev/.gemini/config/hooks.json", HOOKS],
    ["chmod", "chmod 000 ~/.gemini/config/hooks.json", HOOKS],
    ["relative after cd", "cd ~/.gemini/config && rm hooks.json", HOOKS],
    ["relative from workdir", "rm hooks.json", HOOKS],
    ["second segment", "npm test && rm ~/.gemini/config/hooks.json", HOOKS],
    ["bash -c", `bash -c "rm -f ~/.gemini/config/hooks.json"`, HOOKS],
    ["sudo", "sudo rm ~/.gemini/config/hooks.json", HOOKS],
    ["env", "env A=1 rm ~/.gemini/config/hooks.json", HOOKS],
    ["xargs", "echo ~/.gemini/config/hooks.json | xargs rm", HOOKS],
    ["command substitution", `echo "$(rm ~/.gemini/config/hooks.json)"`, HOOKS],
    ["interpreter", `node -e "require('fs').writeFileSync('${HOOKS}', '{}')"`, HOOKS],
    ["python with tilde", `python3 -c "open('~/.gemini/config/mcp_config.json','w')"`, MCP],
    ["unparseable mention", `echo "x > ~/.gemini/config/hooks.json`, HOOKS],
  ])("%s", (label, command, expected) => {
    expect(shell(command, label === "relative from workdir" ? "/Users/dev/.gemini/config" : ctx.workspace)).toBe(expected);
  });
});

describe("run_command that does not modify guard files is allowed", () => {
  test.each([
    ["reading hooks.json", "cat ~/.gemini/config/hooks.json"],
    ["copying hooks.json away", "cp ~/.gemini/config/hooks.json /tmp/backup.json"],
    ["grep in config", "grep -r armoriq ~/.gemini/config"],
    ["writing a sibling", "echo x > ~/.gemini/config/settings.json"],
    ["writing another plugin", "rm -rf ~/.gemini/config/plugins/other"],
    ["workspace hooks.json elsewhere", "rm /Users/dev/src/shop-api/hooks.json"],
    ["redirect to fd", "make 2>&1"],
    ["sed without -i", "sed 's/a/b/' ~/.gemini/config/hooks.json"],
    ["ordinary build", "npm ci && npm test -- --watch=false"],
  ])("%s", (_label, command) => {
    expect(shell(command)).toBeNull();
  });
});

describe("checkGuard on mapped tool calls", () => {
  const check = (name: string, args: Record<string, unknown>) => checkGuard(mapToolCall({ name, args }), ctx);

  test.each([
    ["write_to_file", { TargetFile: HOOKS, CodeContent: "{}" }],
    ["replace_file_content", { TargetFile: RULE, ReplacementChunks: [] }],
    ["multi_replace_file_content", { TargetFile: MCP }],
    ["write_to_file", { TargetFile: `${PLUGIN}/plugin.json`, CodeContent: "{}" }],
    ["Write", { file_path: "~/.gemini/config/hooks.json", content: "{}" }],
  ])("%s on a guard file is denied", (name, args) => {
    const v = check(name, args);
    expect(v?.reason).toContain(`${name} may not modify ArmorIQ's guard files`);
  });

  test("run_command uses its own working directory", () => {
    expect(check("run_command", { CommandLine: "rm hooks.json", Cwd: "/Users/dev/.gemini/config" })?.path).toBe(HOOKS);
    expect(check("run_command", { CommandLine: "rm hooks.json", Cwd: "/Users/dev/src/shop-api" })).toBeNull();
  });

  test("reading a guard file is allowed", () => {
    expect(check("view_file", { AbsolutePath: HOOKS })).toBeNull();
    expect(check("grep_search", { SearchPath: "/Users/dev/.gemini/config", Query: "armoriq" })).toBeNull();
  });

  test("writes elsewhere are allowed", () => {
    expect(check("write_to_file", { TargetFile: "/Users/dev/src/shop-api/hooks.json", CodeContent: "{}" })).toBeNull();
    expect(check("write_to_file", { TargetFile: "src/cart.ts", CodeContent: "" })).toBeNull();
  });

  test("an MCP or unknown tool whose argument is a guard path is denied", () => {
    expect(check("call_mcp_tool", { ServerName: "filesystem", ToolName: "write_file", Arguments: { path: HOOKS, content: "{}" } })?.path).toBe(HOOKS);
    expect(check("mcp__filesystem__move_file", { source: MCP, destination: "/tmp/x" })?.path).toBe(MCP);
    expect(check("some_new_tool", { target: "~/.gemini/config/plugins/armoriq" })?.path).toBe(PLUGIN);
  });

  test("an MCP argument that only mentions a guard file in prose is allowed", () => {
    expect(
      check("call_mcp_tool", {
        ServerName: "github",
        ToolName: "create_issue",
        Arguments: { title: "hooks", body: "Antigravity reads ~/.gemini/config/hooks.json at start" },
      }),
    ).toBeNull();
  });
});
