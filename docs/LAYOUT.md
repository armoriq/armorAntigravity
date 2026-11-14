# Layout and ownership

Bun workspace. Each package has one owner thread while v1 is built in parallel; edit another package only through a PR its owner reviews.

| Path | Contents | Issues |
|---|---|---|
| `packages/protocol` | Hook payload, decision and socket types shared by everything | contract, change first |
| `packages/core` | Decision core shared with armorOpenCode: decide, policy, intent, built-in rules, sanitize, outbox | #9, #10 |
| `packages/adapter` | Antigravity event parsing, tool mapping, surface detection, shell lexer, MCP gate | #13 to #19, #28 |
| `packages/hook` | `agd-hook` native client | #11, #21 |
| `packages/daemon` | `armoriq-agd`: socket server, sessions, auth watcher, lifecycle | #12, #20 |
| `packages/intent` | Plan registry keyed by surface plus `conversationId`, registration rules, token mint, refresh and revoke pump, drift decision text, subagent inheritance; loaded by the daemon | #23, #25, #26, #27, #29, #30 |
| `packages/mcp` | Intent and trust MCP server and the plan directive | #22, #24 |
| `packages/evidence` | Audit, usage, traces, history pumps | #31 to #42 |
| `packages/cli` | `armorantigravity` CLI: install, uninstall, login, status, and the `mcp` entry point the installed MCP config runs | #49 |
| `install_armorantigravity.sh` | curl installer: downloads the release archive, checks SHA256SUMS, runs `armorantigravity install` | #49, #53 |
| `scripts/build-release.ts`, `.github/workflows/release.yml` | release archives and the stable and `dev-latest` releases | #53 |
| `spike/` | P0 findings and captured payloads | #1 to #8 |

Branches: work stacks on `feat/workspace-skeleton` until `dev` exists (#9), then retargets to `dev`.
