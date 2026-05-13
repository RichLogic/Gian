# Gian

> Self-hosted Web UI for Codex and Claude Code.

Gian is a single-user, self-hosted browser front-end that lets you drive
[Codex](https://github.com/openai/codex) and
[Claude Code](https://github.com/anthropics/claude-code) from any device.
It wraps your local AI coding tools in a structured session interface —
real-time event cards, an approval workflow for sensitive operations, a message
queue, Job Mode for multi-turn autonomous runs, Discord/Slack bots, and remote
access via Cloudflare Tunnel or Tailscale Funnel — without replacing the
underlying CLI tools.

## Features

- **12 unified event types** rendered as structured cards in the Transcript:
  `assistant_text`, `command_execution`, `file_change`, `file_read`,
  `file_search`, `web_search`, `agent_spawn`, `approval_requested`,
  `approval_resolved`, `turn_completed`, `session_error`, `thinking`
- **Approval workflow** — default (risk-level gated) and auto modes; `Allow
  Once`, `Allow Session`, `Decline`; keyboard shortcuts A / ⇧A / D
- **Job Mode** — set turns > 1 to run multi-turn autonomous tasks; global
  progress bar with stop button
- **Message queue** — queue messages while the AI is running; reorder, edit,
  Send Now, or Clear
- **Files Tab** — Changed (session diff) and Tree views with unified diff
  rendering and "Open in new tab"
- **IM bridge** — Discord and Slack bots in read-only mirror or full-control
  mode; guided slash commands (`/new`, `/switch`, `/alter`, `/stop`,
  `/status`)
- **Command Palette** — ⌘K fuzzy search across sessions, changed files, and
  commands
- **Spaces page** — workspace management with per-workspace approval risk
  levels
- **Settings panel** — theme (light / warm / dark), accent, density, locale,
  remote access, all at runtime; no restart required
- **Daemon mode** — launchd (macOS) and systemd (Linux) user-service install
  scripts; crash-restart included
- **Remote access** — Cloudflare Tunnel, Tailscale Funnel, or reverse-proxy;
  opt-in HTTP basic auth

## Architecture

Gian runs as a single Node.js process (the **Host**) that manages external
Proxy sub-processes for each executor. The Web UI is a React SPA that
communicates over a persistent WebSocket; IM adapters run inside the same Host
process.

```
Proxy (subprocess) ◁── stdio JSON-RPC ──▷ Host ◁── WebSocket ──▷ Web (Browser)
                                           │
                                           ├──▷ Discord (Bot API)
                                           └──▷ Slack (Bot API)
```

- **codex-proxy** — single shared process for all Codex sessions
- **cc-proxy** — one process per Claude Code session
- Host is the sole state owner; Web and IM are stateless consumers
- Persistence: SQLite at `$GIAN_DATA_DIR/gian.db`

See [`doc/architecture.md`](doc/architecture.md) for full details including
the proxy protocol and data model.

## Installation

### Prerequisites

- **Node.js v22** — `better-sqlite3` native bindings break on Node v25; stay
  on v22 LTS until an upstream fix lands
- **pnpm 10+**
- Both `cc-proxy` and `codex-proxy` are vendored under
  `packages/proxies/`; no separate install needed
- Optional: `cloudflared` or `tailscale` for remote access

### Steps

```bash
# 1. Clone
git clone https://github.com/your-org/gian.git
cd gian

# 2. Install dependencies
pnpm install

# 3. Build packages (order matters)
pnpm -F @gian/shared build
pnpm -F @gian/host build
pnpm -F @gian/web build

# 4a. Daemon mode (auto-start at login, crash-restart)
./scripts/install.sh

# 4b. Dev mode (hot-reload frontend)
pnpm dev
```

Open **http://localhost:5190** in your browser.

> Daemon logs live at `~/.config/gian/logs/`. Run `./scripts/uninstall.sh` to
> remove the daemon (data is preserved; add `--purge` to delete everything).

## Configuration

Most settings are available at runtime in **Settings** (gear icon, top-right).
Boot-time values can be set via environment variables before starting the
daemon.

| Variable | Default | Description |
|---|---|---|
| `GIAN_HOST` | `127.0.0.1` | Host bind address |
| `GIAN_PORT` | `8990` | Host listen port |
| `GIAN_DATA_DIR` | `~/.config/gian/` | SQLite + logs directory |
| `GIAN_AUTH_REQUIRED` | — | Set to `true` to enable login |
| `GIAN_AUTH_USERNAME` | — | Login username |
| `GIAN_AUTH_PASSWORD` | — | Login password (hashed at startup) |
| `GIAN_SECRET` | — | AES-256-GCM key seed for bot token encryption |
| `GIAN_CC_PROXY_ENTRY` | — | Absolute path to the cc-proxy executable |
| `GIAN_CODEX_PROXY_ENTRY` | — | Absolute path to the codex-proxy executable |
| `GIAN_CC_BIN` | system PATH | Claude Code CLI path |
| `GIAN_CODEX_BIN` | system PATH | Codex CLI path |

## Usage

1. **Create a workspace** — go to **Spaces**, add a local directory (e.g.
   `~/Coding/my-project`), set the default executor (Codex or Claude Code) and
   per-category approval risk levels.

2. **Create a session** — click **+ New** in the Coding tab, pick a workspace
   and executor, optionally name the session.

3. **Send a message** — type in the Composer, press Enter. The Transcript
   shows live event cards as the AI works: text streaming, commands running,
   files changing.

4. **Handle approvals** — when the AI hits a medium/high-risk operation a
   highlighted card appears. Press **A** (Allow Once), **⇧A** (Allow
   Session), or **D** (Decline).

5. **Queue messages** — while the AI is running, type your next message and
   it is queued. Reorder with ↑↓, remove, or hit **Send Now** to flush
   immediately.

6. **Job Mode** — switch Composer to AUTO and set turns > 1. The AI runs
   autonomously until the task is complete, the turn limit is reached, or you
   hit **Stop**.

7. **Slash commands** — type `/` in the Composer to pop up the executor's
   native command list (`/clear`, `/compact`, etc.) for transparent
   pass-through.

8. **Command Palette** — ⌘K to search sessions, changed files, and commands
   from anywhere.

## Known limits

- **Single-user by design** — no multi-user support planned
- **Codex `web_search`** — not surfaced as a live event (proxy limitation;
  cc-only for now)
- **IM bot tokens** — encrypted at rest with AES-256-GCM derived from
  `GIAN_SECRET`; if `GIAN_SECRET` is unset a dev fallback key is used with a
  one-time warning at startup
- **Theme flash** — a brief flash may occur on first load before
  `systemConfig` arrives; cosmetic only, flagged for follow-up

## Status

**Phase 2 vertical slice** — all 6 milestones complete (M0 → M5 + M6 polish).
Not yet released; API and config schema may change before v1.0.

## License

MIT — see [LICENSE](LICENSE)
