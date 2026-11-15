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

To sign in later, use the command for your backend:

```sh
# Production
~/.armoriq/armorantigravity/bin/armorantigravity login --backend https://api.armoriq.ai
# Staging
~/.armoriq/armorantigravity/bin/armorantigravity login --backend https://staging-api.armoriq.ai
```

If you installed with a different backend, replace the origin after `--backend` with that origin. `armorantigravity status` also prints the command when you are not signed in.

## Privacy

On the first session or hook event of each UTC day, ArmorAntigravity makes at most one anonymous usage ping attempt, whether you are signed in or not. It sends a random install id, the plugin and its version, the host agent and its version when available, your OS, whether you are signed in, the production or staging environment, and daily counts of plans, blocked actions and actions held for approval from up to seven previous days. Local counts are collected only while you are not signed in. The install id is separate from sign in and the device id, and is never sent with signed in activity. Only the listed ArmorIQ production and staging backends receive the ping.

The ping never includes prompts, plan contents, tool names or arguments, file paths, repository names, hostnames, emails, keys, device ids or IP addresses. Google Cloud's request logs record the sender's IP address at the infrastructure level, although ArmorIQ's app never stores it.

Any of these switches turns the ping off:

* `DO_NOT_TRACK=1` or `true`.
* `ARMORIQ_USAGE_PING_DISABLED=1`, `true` or `yes`.
* `"usagePing": false` in `~/.armoriq/settings.json` or `~/.armoriq/armorantigravity/config.json`.

Environment values ignore case and surrounding spaces. A malformed or unreadable shared settings file also disables the ping. A present `usagePing` value in that file must be a boolean.

When you are not signed in, the first session of a UTC day may show a desktop notification with the sign in command, at most once that day per environment. When the ping is enabled, the first session also shows the usage notice once per ArmorIQ home. Each message is saved as one entry in `~/.armoriq/armorantigravity/logs/agd.log`. Notifications use macOS notifications or Linux `notify-send` when it is on PATH and `DISPLAY` or `WAYLAND_DISPLAY` is set. Without a working desktop notifier, the log and the command in `armorantigravity status` remain available.

To hide the reminder, set `ARMORIQ_SIGNIN_REMINDER_DISABLED=1`, `true` or `yes`, or set `"signInReminder": false` in either settings file above. A malformed or unreadable shared file, or a non boolean `signInReminder` value in that file, suppresses the reminder. The reminder makes no network request and never creates an install id. Ping switches, including `DO_NOT_TRACK`, do not hide the reminder.

A daemon started by launchd or systemd does not see variables from your shell. The reliable switches are the shared settings file, the plugin's `config.json`, or running the installer again with the variable set. The CLI installer saves recognised opt outs as `usagePing: false` or `signInReminder: false` in `config.json`, keeps other keys, and restarts the service. Running it later without those variables keeps your saved opt outs.
