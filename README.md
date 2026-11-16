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
