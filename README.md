# ArmorAntigravity

ArmorIQ intent assurance for Google Antigravity: the Antigravity 2.0 desktop app, the Antigravity IDE and its extensions, and the `agy` CLI.

Status: pre-implementation. The spec is [docs/PRD.md](docs/PRD.md); work is tracked in issues by phase milestone (P0 to P5).

## Install

```sh
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash
```

This installs the newest release for macOS or Linux, signs you in with ArmorIQ, adds the `armoriq` hooks, MCP server and rule to `~/.gemini/config`, and starts the `armoriq-agd` daemon. It needs **node 22 or newer** on your PATH, which the installer checks before it downloads anything: the CLI and the daemon are node bundles, and the download is under a megabyte rather than the 60 MB of compiled binaries it used to be. The hook that runs on every tool call is a native binary and needs no runtime. Re-run it to upgrade. `install_armorantigravity_dev.sh` installs the `dev-latest` build against staging.

```sh
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash -s -- --uninstall           # keeps your data and login
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash -s -- --uninstall --purge   # also deletes ~/.armoriq/armorantigravity
```

`~/.armoriq/armorantigravity/bin/armorantigravity status` shows the login, the daemon, the update state and which Antigravity surfaces were found.

## Workspace mode

Signed in, ArmorAntigravity follows the mode your workspace picks under **Tool calls in the chat** on the Monitor page of ArmorIQ Tools. The daemon reads it with the workspace policy at every session start and every five minutes, and keeps the last answer in `~/.armoriq/armorantigravity/org-mode.json`; until it has one, it runs Quiet.

| Mode | A call your policy, the file guard or the MCP gate would stop | What Antigravity shows |
|---|---|---|
| Quiet (the default) | Runs, and is listed under Would have blocked on the Monitor page | Nothing from ArmorIQ |
| Show in chat | Runs, and is listed on the Monitor page | Nothing yet: Antigravity's hooks have no way to show the user a message on a call that runs, so this works like Quiet here |
| Block | Is blocked, a held call waits for a workspace approval, an unapproved MCP server asks | The block reason |

In Quiet and Show in chat no approval request is filed and an unreachable backend blocks nothing; the audit row of each call records what Block would have done (`would_be`, `would_be_code`, `would_be_reason`). `ARMORIQ_ORG_MODE=enforce` in the daemon's environment makes one machine block whatever the workspace says.

Signed in, plans work the same in every mode: the model is asked to register a plan, the plan is sent with its kind, prompt id and request id, its token is refreshed while the prompt is open, and it is retired at the next prompt or revoked as in Block. Audit rows then carry the plan id. In Quiet and Show in chat the plan only records intent: a missing plan, a call outside the plan or a failed plan request never blocks a call, a failed request is still recorded, and the plan request and replies never say a call would be blocked or held. Signed out, a plan is recorded locally and nothing is sent.

## Updates

`armoriq-agd` updates itself. Every six hours it asks GitHub for the newest release on its channel:
stable installs follow `releases/latest`, dev installs follow the rolling `dev-latest` prerelease. A
newer archive is verified against that release's `SHA256SUMS` and staged. The daemon applies it once
no Antigravity session is open, or at its next start, and exits so launchd or systemd starts the new
binaries. A failed or unreachable check is never fatal and never interrupts a session.

Only an install made by the installer (it leaves `~/.armoriq/armorantigravity/release.sha256`) is
updated. Set `ARMORANTIGRAVITY_NO_AUTO_UPDATE=1` to keep updates manual; the daemon then makes no
network call for updates and applies nothing that is already staged. Re-running the installer still
upgrades. `ARMORANTIGRAVITY_UPDATE_API_URL` points the check at a mirror of the repository releases API.

Set `ARMORIQ_INTENT_VALIDITY_SECONDS` in the daemon's environment to an integer from 180 to 3600
seconds (default 3600). The daemon reads it at startup and refuses to start if the value is invalid.
Only an open, active prompt refreshes its token. Pending registration requests are saved in
`intent-state.json` and reuse the same request id when you retry the same plan.


Run reporting is on by default. To turn it off, set `"runReportingEnabled": false` in `~/.armoriq/armorantigravity/config.json` or `ARMORIQ_RUN_REPORTING_ENABLED=false` in the daemon environment, and restart the daemon. The environment overrides the file. Once either is set, only the exact value `true` keeps reporting on; any other value turns it off. The installer preserves the file setting during upgrades. Authenticated monitor runs are included. Runs started while logged out are never uploaded. Delivery uses the login fixed at prompt start, pauses while logged out or on a 404, and keeps queued reports locally. `armorantigravity status` shows pending reports, undeliverable reports (waiting for their original login or a paused endpoint), dead letters and whether delivery is paused.

An `org_required` response holds health and run uploads locally without discarding rows or pausing authentication. Retries wait 5, 10, 20, 40 and then 60 minutes, including after a failed probe. The schedule survives a restart, and a successful send lifts the hold.
