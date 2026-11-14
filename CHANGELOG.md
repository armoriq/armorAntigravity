# Changelog

All notable changes to ArmorAntigravity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow publishes `v<version>` with the
notes from the matching section, so add the section, with its date, in the release PR.

## [Unreleased]

### Changed

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
