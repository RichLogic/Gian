# Gian

> Self-hosted workspace for Codex, Claude Code, and Kimi Code.

Gian is a single-user browser and desktop interface for local AI coding
tools. It wraps Codex, Claude Code, and Kimi Code in structured sessions with
real-time transcripts, approvals, message queues, tasks, worktrees, files,
bots, and a workspace terminal without replacing the underlying tools.

## Features

- **16 unified event types** rendered as structured cards in the Transcript:
  `assistant_text`, `reasoning`, `plan_update`, `command_execution`,
  `file_change`, `file_read`, `file_search`, `web_search`, `agent_spawn`,
  `approval_requested`, `approval_resolved`, `auto_classifier_denied`,
  `auto_circuit_breaker`, `turn_started`, `turn_completed`, `session_error`
- **Approval workflow** — default (risk-level gated) and auto modes; `Allow
  Once`, `Allow Session`, `Decline`; keyboard shortcuts A / ⇧A / D
- **Message queue** — queue messages while the AI is running; reorder, edit,
  Send Now, or Clear
- **Tasks and worktrees** — Manager-led subtasks, explicit approval gates,
  branch/worktree isolation, and merge/drop workflows
- **Files view** — Changed (session diff) and Tree views with unified diff
  rendering and "Open in new tab"
- **IM bridge** — Discord and Slack bots in read-only mirror or full-control
  mode
- **Workbench Terminal** — a workspace shell over the dedicated `term:*`
  protocol; it is independent of AI session execution
- **Command Palette** — ⌘⇧K fuzzy search across sessions, changed files, and
  commands
- **Spaces page** — workspace management with per-workspace approval risk
  levels
- **Settings panel** — theme (light / warm / dark), accent, density, locale,
  executor defaults, shortcuts, and auth settings
- **Daemon mode** — launchd (macOS) and systemd (Linux) user-service install
  scripts; crash-restart included

AI sessions are structured-only: Claude uses `claude -p`, Codex uses
app-server, and Kimi uses ACP. Session TTY modes were retired in ADR-0008;
the Workbench Terminal is Gian's only PTY.

## Architecture

Gian runs as a single Node.js process (the **Host**) that manages external
Proxy sub-processes for each executor. The Web UI is a React SPA that
communicates over a persistent WebSocket; IM adapters run inside the same Host
process.

```
Proxy (subprocess) ◁── stdio JSON-RPC ──▷ Host ◁── WebSocket ──▷ Web / Desktop
                                           │
                                           ├──▷ Discord (Bot API)
                                           └──▷ Slack (Bot API)
```

- **codex-proxy** — single shared process for all Codex sessions
- **cc-proxy** — one process per Claude Code session
- **kimi-proxy** — single shared ACP process for all Kimi sessions
- Host is the sole state owner; Web and IM are stateless consumers
- Electron is a thin shell over the independent Host
- Persistence: SQLite at `$GIAN_DATA_DIR/gian.db`

See [`docs/architecture.md`](docs/architecture.md) for full details including
the proxy protocol and data model.

## Installation

### Prerequisites

- **Node.js v22** — `better-sqlite3` native bindings break on Node v25; stay
  on v22 LTS until an upstream fix lands
- **pnpm 10+**
- All executor proxies are vendored under
  `packages/proxies/`; no separate install needed

### Steps

```bash
# 1. Clone
git clone https://github.com/your-org/gian.git
cd gian

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm build

# 4a. Daemon mode (auto-start at login, crash-restart)
./scripts/install.sh

# 4b. Dev mode (isolated host/web plus the GianDev desktop app)
pnpm dev
```

`pnpm dev` opens a separate **GianDev** Electron app after the development
host and web UI are ready on `8991` / `5191`. Use `pnpm dev:web` only when a
browser-only stack is preferable. Production `8990` / `5190` and the installed
Gian app are not touched.

> Daemon logs live at `~/.config/gian/logs/`. Run `./scripts/uninstall.sh` to
> remove the daemon (data is preserved; add `--purge` to delete everything).

## Configuration

Most settings are available at runtime in **Settings** from the Dock.
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
| `GIAN_KIMI_PROXY_ENTRY` | — | Absolute path to the kimi-proxy executable |
| `GIAN_CC_BIN` | system PATH | Claude Code CLI path |
| `GIAN_CODEX_BIN` | system PATH | Codex CLI path |

## Usage

1. **Create a workspace** — go to **Spaces**, add a local directory (e.g.
   `~/Coding/my-project`), set the default executor and per-category approval
   risk levels.

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

6. **Slash commands** — type `/` in the Composer to pop up the executor's
   native command list (`/clear`, `/compact`, etc.) for transparent
   pass-through.

7. **Workbench Terminal** — open Terminal from the session Workbench to run
   shell commands in that workspace.

8. **Command Palette** — ⌘⇧K to search sessions, changed files, and commands
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

Active development. API, protocol, and config schemas may change before v1.0.

## License

MIT — see [LICENSE](LICENSE)
