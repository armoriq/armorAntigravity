# ArmorAntigravity

ArmorIQ intent assurance for Google Antigravity: the Antigravity 2.0 desktop app, the Antigravity IDE and its extensions, and the `agy` CLI.

Status: pre-implementation. The spec is [docs/PRD.md](docs/PRD.md); work is tracked in issues by phase milestone (P0 to P5).

## Install

```sh
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash
```

This installs the newest release for macOS or Linux, signs you in with ArmorIQ, adds the `armoriq` hooks, MCP server and rule to `~/.gemini/config`, and starts the `armoriq-agd` daemon. Re-run it to upgrade. `install_armorantigravity_dev.sh` installs the `dev-latest` build against staging.

```sh
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash -s -- --uninstall           # keeps your data and login
curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash -s -- --uninstall --purge   # also deletes ~/.armoriq/armorantigravity
```

`~/.armoriq/armorantigravity/bin/armorantigravity status` shows the login, the daemon and which Antigravity surfaces were found.
