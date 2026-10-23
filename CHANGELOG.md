# Changelog

All notable changes to ArmorAntigravity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow publishes `v<version>` with the
notes from the matching section, so add the section, with its date, in the release PR.

## [Unreleased]

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
