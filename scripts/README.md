# Gian — Daemon install scripts

These scripts register the Gian host process as a user-level daemon so it
starts automatically at login and restarts on crash.

| Platform | Mechanism | Unit location |
|---|---|---|
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.gian.host.plist` |
| Linux | systemd user service | `~/.config/systemd/user/gian.service` |

The daemon runs as _you_ (not root), logs to `~/.config/gian/logs/`, and
stores its SQLite database at `~/.config/gian/gian.db`.

## Prerequisites

- **Node v22+** — required for the `better-sqlite3` native binding. Node v25
  breaks the binding; stay on v22 LTS until an upstream fix lands.
- Packages must be built before installing.

## Build

```bash
pnpm install
pnpm -F @gian/shared build
pnpm -F @gian/host build
```

## Install

```bash
./scripts/install.sh
```

If Gian is already installed and you want to apply an updated build:

```bash
./scripts/install.sh --force
```

The installer:

1. Detects macOS or Linux.
2. Resolves the repo root and the absolute path to `node`.
3. Creates `~/.config/gian/logs/` if it does not exist.
4. Substitutes `{{INSTALL_DIR}}`, `{{NODE_BIN}}`, and `{{HOME}}` into the
   platform template and writes the unit file.
5. Registers and starts the daemon immediately.

## Uninstall

```bash
./scripts/uninstall.sh
```

This stops the daemon and removes the unit file. Your data and logs are left
intact in `~/.config/gian/`.

To also delete all data (sessions, workspaces, bots, logs — **irreversible**):

```bash
./scripts/uninstall.sh --purge
```

## View logs

```bash
tail -f ~/.config/gian/logs/host.out
tail -f ~/.config/gian/logs/host.err
```

## Manual service control

**macOS**

```bash
# Stop
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.gian.host.plist

# Start
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.gian.host.plist
```

**Linux**

```bash
systemctl --user stop gian.service
systemctl --user start gian.service
systemctl --user status gian.service
```

## First-run configuration

After installing, open `http://localhost:8990` in your browser.

- Tunnel mode (Cloudflare / Tailscale / reverse proxy) is configured via
  **Settings → Remote**.
- Authentication is opt-in; set `GIAN_AUTH_REQUIRED=true` in
  `EnvironmentVariables` (plist) or `Environment=` (service unit) and restart
  the daemon.
