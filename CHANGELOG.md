# Changelog

All notable changes to ArmorAntigravity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow publishes `v<version>` with the
notes from the matching section, so add the section, with its date, in the release PR.

## [Unreleased]

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
