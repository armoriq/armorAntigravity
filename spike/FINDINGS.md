# P0 spike findings

Captured on 2026-10-12 with `agy` CLI 1.3.3 on macOS (Apple M5), signed in, in a sandbox HOME
(`/tmp/agspike/home`). Hooks were registered in three places at once: global
(`~/.gemini/config/hooks.json`), a plugin (`~/.gemini/config/plugins/agspike/hooks.json`) and, for r5,
the workspace (`<workspace>/.agents/hooks.json`). The logger is `spike/hooks/logger.py`; setup is
`spike/hooks/setup.sh`. All evidence paths below are relative to `spike/payloads/cli/`.

Only the CLI was exercised. Antigravity 2.0 (2.22.0) and Antigravity IDE are installed in
`/Applications` but neither would start from an agent shell (see "Not verified").

## Payload facts that apply to every issue

- stdin is one JSON object. It has **no event name**: the hook only knows its event from the command
  line it was registered with, so `agd-hook <Event>` must pass the event itself.
- Fields per event (all observed on every capture):

  | Event | Fields |
  |---|---|
  | all | `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` |
  | PreToolUse | `stepIdx`, `toolCall {name, args}` |
  | PostToolUse | `stepIdx`, `toolCall`, `error` (always present, `""` on success). No tool output. |
  | PreInvocation, PostInvocation | `invocationNum`, `initialNumSteps` |
  | Stop | `executionNum`, `fullyIdle`, `terminationReason` (only `NO_TOOL_CALL` seen), `error` |

- `transcriptPath` points at `<brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl`.
- The hook process env adds only `ANTIGRAVITY_CONVERSATION_ID` (`env-sample.json`). Its cwd is the
  directory holding the `hooks.json` that registered it.
- Registrations for one event run one after another, never in parallel. Order is not stable: the
  workspace hook ran first in r5, global usually ran before plugin, but `ft-crash1` ran plugin first.
  A PreToolUse deny or failure, or a Stop `continue`, skips the remaining registrations
  (`failure-modes/ft-crash1`, `ft-crash2`, `ft-deny`, `ft-stopcont`). A PostToolUse failure does not
  (`ft-postcrash` reports both).
- `--dangerously-skip-permissions` does not skip hooks (r3, r4, every `ft-*` without `-noskip`).

## #1 Install all surfaces and capture payloads

- CLI: installed with the official script into a sandbox HOME, signed in, all five events captured
  (r1 to r5).
- 2.0 app and IDE: installed (notarized, Google LLC, team EQHXZ8M8AV), but the 2.0 app exits right
  after launch when started from the agent shell (`task_name_for_pid: (os/kern) failure (5)`), with
  and without the sandbox HOME. Nothing captured. Needs a person to launch it from Finder and sign in.

## #2 MCP tool calls in PreToolUse

Answer: user MCP servers arrive as one tool, `call_mcp_tool`:

```json
{"name": "call_mcp_tool",
 "args": {"ServerName": "agspike-global", "ToolName": "echo", "Arguments": {"text": "mcp-ping"},
          "toolAction": "...", "toolSummary": "..."}}
```

- A plugin's MCP server is named `<plugin>_<server>` (`agspike_agspike-plugin`) (r3).
- The built-in Chrome DevTools server used by the browser subagent does **not** go through
  `call_mcp_tool`. Each tool is its own name: `mcp_chrome_devtools_navigate_page`,
  `mcp_chrome_devtools_evaluate_script` and so on (`r4-subagent-browser.jsonl`).
- In hook payloads `Arguments` is an object; in `transcript.jsonl` every arg value is a JSON string
  (see #5).

Evidence: `r3-shell-write-read-web-mcp.jsonl`, `r4-subagent-browser.jsonl`.

## #3 Subagent and browser subagent coverage

Answer: covered. Every hook fires inside children, including the browser subagent.

- Both kinds are started by `invoke_subagent`; `args.Subagents[].TypeName` is `self` or `browser`
  (with `Role`, `Prompt`, `Model: "inherit"`, `Workspace: "inherit"`). No `browser_subagent` tool
  call was emitted even though it is listed in the init tool list.
- A child has its own `conversationId`. The hook payload has **no parent field**.
- How to link a child to its parent:
  1. `conversation_summaries.db` (`~/.gemini/antigravity-cli/`) has `parent_conversation_id`,
     `nesting_depth` and `agent_name` (`self` / `browser`) for children
     (`transcripts/conversation_summaries-sample.json`).
  2. The child reports back with a `send_message` tool call whose `args.Recipient` is the parent's
     conversationId, and the parent replies with `send_message` to the child id. Both pass PreToolUse.
  3. The parent's `Stop` fires with `fullyIdle: false` while children still run.
- Child transcripts live in their own brain dir (`transcripts/b82464e5-*`).

Evidence: `r4-subagent-browser.jsonl`, `r4-subagents.stream.jsonl`.

## #4 Crash, timeout, invalid JSON, deny reason, ask/force_ask, skip-permissions

Each test runs one `touch`, so the filesystem shows whether the tool ran. Files in
`failure-modes/`.

| PreToolUse hook does | Tool ran | What the model gets |
|---|---|---|
| exit 1 or 2 (`ft-crash1`, `ft-crash2`) | no | `JSON hook "jsonhook__<name>_PreToolUse_0_0" failed: command failed: exit status N, stderr: ...` |
| hangs past `timeout` (`ft-hang`) | no | `... failed: command failed: signal: killed` |
| prints invalid JSON (`ft-invalid`) | no | `failed to unmarshal result from hook ... via protojson: ...` |
| prints `{}` (`ft-emptyobj`, r1) | no | `tool call denied by pre-tool hook: ` (empty reason) |
| prints nothing (`ft-empty`) | yes | normal result |
| `{"decision":"deny","reason":R}` (`ft-deny`) | no | `tool call denied by pre-tool hook: R`, verbatim |

- PreToolUse fails **closed** on crash, timeout and invalid output. `{}` is a deny. Empty stdout is
  the only "no opinion".
- PreInvocation crash is ignored and the tool still runs (`ft-preinvcrash`). PostToolUse crash happens
  after the tool ran, and the model sees the hook error text as the tool result (`ft-postcrash`).
- The deny reason reaches the model verbatim in both print mode and the TUI.
- `ask` / `force_ask`:
  - TUI: native prompt shows `Reason: <reason>`, the command, and options `1. Yes, run command`,
    `2. Yes, and always allow in this conversation ...`, ..., `4. No, cancel` (`tui-ask.jsonl`).
    After choosing option 2, a later `ask` runs without a prompt; `force_ask` still prompts.
    Choosing "No, cancel" gives the model `User declined the tool call` and interrupts the turn.
  - With `--dangerously-skip-permissions`: both auto-approve and the tool runs (`ft-ask`,
    `ft-forceask`).
  - Headless print mode without that flag: auto-denied, `no output produced` on stderr
    (`ft-ask-noskip`).
- `allow` never widens permissions. In headless print mode without skip-permissions, `allow`, with
  `permissionOverrides: ["command(touch)"]` or the exact command, is still auto-denied
  (`ft-allowoverride-noskip`, `ft-allowexact-noskip`). Hooks only narrow.
- `--dangerously-skip-permissions` keeps every hook, and a hook deny still blocks (`ft-deny`).

## #5 transcript.jsonl schema, token counts, model ids, titles

Two files per conversation in `<brain>/<id>/.system_generated/logs/`, same lines:
`transcript.jsonl` (every tool arg value JSON-encoded as a string) and `transcript_full.jsonl`
(typed args; this is the one `transcriptPath` names). One line per step:

| Field | Notes |
|---|---|
| `step_index`, `type`, `source`, `status`, `created_at` | type: `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` (tool result), `SYSTEM_MESSAGE`, `EPHEMERAL_MESSAGE` |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | on every `PLANNER_RESPONSE` |
| `thinking`, `content`, `tool_calls[] {name, args}`, `error`, `truncated_fields[]` | when present |

- No model id and no title in the transcript. No thinking tokens either.
- Model id: `modelName` on every hook payload (`gemini-3.8-flash-high`). `agy models` lists ids and
  display names (`transcripts/agy-models.txt`).
- Title: `conversation_summaries.db` column `title`, and
  `cache/conversation_metadata.json` `.conversations[id].summary.Title`. Children have an empty title.
- Per-turn totals including `thinking_tokens` are in the `--output-format stream-json` `result`
  event `usage` (print mode only).

Evidence: `transcripts/`.

## #6 Plugin hooks and global MCP config

CLI only:

- Global `~/.gemini/config/hooks.json`, plugin `~/.gemini/config/plugins/<p>/hooks.json` and
  workspace `<ws>/.agents/hooks.json` all fire (r3, r5). `/hooks` in the TUI lists the plugin as
  "(workspace)".
- Global `~/.gemini/config/mcp_config.json` and the plugin's `mcp_config.json` both load (r3).
- The config root is `~/.gemini/config/`, separate from the CLI's data dir
  `~/.gemini/antigravity-cli/`. Whether 2.0 and the IDE read the same `~/.gemini/config/` is **not
  verified** (blocked, see #1).

## #7 Hook client benchmark

`spike/bench/run.sh 300`, three variants interleaved, spawned through `sh -c` like Antigravity,
real PreToolUse payload, unix socket round trip to a stub server. Results in
`spike/bench/results-macos.txt`:

| Variant | p50 | p95 |
|---|---|---|
| bare `sh` echo | 9.7 to 11.3 ms | 16.7 to 25.8 ms |
| Go (2.6 MB) | 10.3 to 11.9 ms | 17.3 to 26.7 ms |
| Bun compiled (70.9 MB) | 30.2 to 34.8 ms | 44.3 to 83.4 ms |

Go adds about 0.5 ms over the shell floor and meets the 30 ms p95 target. Bun misses it. The machine
was loaded by other work; Linux was not measured (Docker not running).

## #8 Session end signal

- `Stop` fires at the end of every agent execution in a turn, with `terminationReason: NO_TOOL_CALL`.
  `fullyIdle: true` means the conversation and its subagents are all done; a parent shows `false`
  while children run.
- `Stop` returning `{"decision":"continue","reason":R}` starts another execution with R; it caps at
  ten in a row (`executionNum` 0 to 10, `ft-stopcont`).
- No hook fires for `/exit`, `/clear`, Ctrl-C mid-turn (not even PostToolUse for the interrupted
  tool), or deleting a conversation from `/resume` (F4). Deleting removes its brain dir and summary
  row (`tui-interrupt.jsonl`, observed in the TUI).

## Changes made in `packages/protocol/src/index.ts` (separate commit)

- `HookPayload`: `event` is documented as coming from argv; `artifactDirectoryPath` and `modelName`
  are required; added `invocationNum` / `initialNumSteps`, the Stop fields and a required
  `error` on PostToolUse.
- `HookResponse`: `{}` removed (it denies); `null` added for "print nothing". Stop uses
  `{decision: "continue", reason}` instead of `{continue: boolean}`.
- Added `MCP_TOOL_NAME`, `McpToolArgs`, `SUBAGENT_TOOL_NAME` and `CONVERSATION_ID_ENV`.

## Not verified

- 2.0 app and IDE: no captures at all (#1, #6). They need a person to launch them and sign in.
- `injectSteps` responses were not tested.
- Linux latency (#7).
