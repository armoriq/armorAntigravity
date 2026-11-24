# Changelog

All notable changes to ArmorAntigravity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow publishes `v<version>` with the
notes from the matching section, so add the section, with its date, in the release PR.

## [Unreleased]

### Added
- Workspace Monitor. Signed in, the daemon follows the mode set on the Tools Monitor page, read with the workspace policy and kept in `org-mode.json`: Quiet (the default) and Show in chat run every call, including ones the file guard, a policy, a v2 hold or the MCP gate would stop, and record on the audit row what Block would have done (`would_be`, `would_be_code`, `would_be_reason`); Block enforces as before. In Monitor no plan directive is injected, no approval request is filed and a backend outage blocks nothing. `ARMORIQ_ORG_MODE=enforce` forces Block on one machine. Requests send `X-ArmorIQ-Monitor-Aware: 1`, so the backend sends the real policy instead of the Monitor stand-in.

### Changed

- Run reporting can be enabled in `config.json`, with the daemon environment as an override.
- Plans now belong to individual user prompts. Registration replies include the confirmed plan id,
  kind and token expiry, and local plans are explicitly marked as unregistered.
- Pending requests and prompt state are saved in `intent-state.json` so retries reuse the original
  request. Signing out, changing credentials or changing mode retires the current plan.
- `ARMORIQ_INTENT_VALIDITY_SECONDS` sets token validity from 180 to 3600 seconds (default 3600).
  Invalid values stop daemon startup.

### Fixed

- C hook fallback decisions are retained for daemon ingestion, with incomplete records kept locally.
- Plan requests can retry with the same idempotency key after their original reporting deadline.
- Health and run reporting failures preserve registration replies and hook decisions. Temporary
  delivery failures retain reports, and an organization requirement is shown as a local hold.
  Hold retries back off from five minutes to one hour and resume delivery after a successful send.
- Open runs continue across daemon restarts, and tool checkpoints store only changes.
- Registering the same plan after retirement in one prompt requests a new backend plan.
- Opening another root conversation after a subagent spawn gives it a prompt id.
- Revoke, delegate and reanchor use the current token after a refresh, while revisions keep the
  counted plan as their parent.
- Invalid intent state files are preserved beside the original path and reported before the
  daemon starts with empty state. Children retain their parent link when its session closes.

## [0.2.1] - 2026-11-17

### Changed

- No functional changes. This release exists so every 0.2.0 install, the first with a self-updating
  daemon, moves to a newer release by itself, which proves the update path on real installs.

## [0.2.0] - 2026-11-16

### Changed

- The curl installer lives in armoriq/armorIQ-landing only, at
  `public/install_armorantigravity.sh`, which is the copy armoriq.ai serves. This repo kept a second
  copy that nothing referenced from the site; the two drifted 115 lines apart, and a fix applied here
  reached nobody. Its tests moved to that repo with it, and run in its installer CI.

### Added

- `armoriq-agd` updates itself. It checks every six hours for a newer release on its channel
  (`releases/latest` for stable, `dev-latest` for dev), verifies the archive against `SHA256SUMS`,
  stages it, and applies it once no session is open or at its next start.
  `ARMORANTIGRAVITY_NO_AUTO_UPDATE=1` opts out before any network call.
- `armorantigravity status` reports the last update check and any staged version.
- `armorantigravity install` refuses to run when no Antigravity installation is found: not the
  Antigravity 2.0 app, the Antigravity IDE, or the `agy` CLI on PATH. Installing into
  `~/.gemini/config` on a machine with no Antigravity to read it leaves hooks that never fire and a
  daemon with nothing to guard. `--force` installs anyway, for an Antigravity somewhere this does not
  look. When one is found, the install prints which.

### Changed

- The install downloads about 0.5 MB rather than 60 MB, which needs **node 22 or newer** on the
  machine. `armorantigravity` and `armoriq-agd` are node bundles behind a shell wrapper instead of
  compiled binaries carrying their own runtime; the installer checks for node before downloading, and
  `armorantigravity install` writes the wrappers with the absolute interpreter that ran it, so launchd
  and systemd find the same node a version manager put on your PATH. The daemon's instance lock is a
  pid file with a liveness check, because node cannot call `flock(2)`: a daemon that is killed outright
  now leaves a lock that the next start takes over, rather than one the kernel released.
- The install downloads about 2 MB instead of 60 MB on macOS and Linux alike. `agd-hook` is now a
  34 KB C binary rather than a Bun-compiled one, which was 69 MB of embedded runtime around 3 KB of
  logic. It is also faster: measured back to back on an M-series Mac, PreToolUse went from a p50 of
  12.6 ms to 2.5 ms against the same daemon.
- `armoriq-agd` publishes the answer each hook event gets while it is unreachable, one file per
  event in `~/.armoriq/armorantigravity/fallback`, beside the mode file it already wrote. The hook
  client reads one of those files instead of building the response itself, and a request that
  arrives in the client's own frame is answered with the response on a line of its own. A missing
  or unreadable file still denies the tool call.

### Fixed

- The dev channel installed against `staging-api.armoriq.io`, which is not the
  hostname the rest of ArmorIQ uses. Credential profiles are keyed on the backend
  host, so the stray spelling split the namespace, and under `ARMORIQ_ENV=production`
  the SDK could not pair the backend to its dashboard and refused to open the
  approval page. The dev default is now `staging-api.armoriq.ai`. Existing dev
  installs keep the old host until their next install and sign in once more then.

## [0.1.0]

### Added

- `agd-hook`, the compiled hook client Antigravity runs for PreToolUse, PostToolUse,
  PreInvocation, PostInvocation and Stop.
- `armoriq-agd`, the local daemon that decides each tool call against the conversation's intent
  plan and the org policy, and uploads audit, usage, trace and history records to ArmorIQ.
- The `armoriq` MCP server and always-on rule that register the intent plan.
- `armorantigravity`, the CLI that installs, upgrades and uninstalls all of the above
  (`install_armorantigravity.sh` downloads it), signs in with the ArmorIQ device login, starts the
  daemon under launchd or systemd, and reports which Antigravity surfaces are present.
