# Gian

> One local app for all your coding agents.

Use Codex, Claude Code, and Kimi Code at the same time through one consistent
desktop interface for sessions, approvals, tasks, worktrees, files, and
changes.

[Download the latest macOS release](https://github.com/RichLogic/Gian/releases/latest)

Gian is currently an early macOS Apple Silicon release. The App and Gian
proxies are distributed through GitHub Releases. Agent CLIs still come from
their official vendors and keep their own login, subscription, configuration,
and session data.

## Why Gian

- Run Codex, Claude Code, and Kimi Code from one App.
- Keep multiple agent sessions visible without juggling terminals.
- Review commands, file changes, approvals, queues, and worktrees through one
  shared interaction model.
- Work locally: Gian stores its database and logs on your Mac and does not use
  a Gian cloud service.
- Keep the native tools: Gian connects to the official CLIs instead of
  replacing their authentication or billing.

## Install

1. Download `Gian-<version>-arm64.dmg` from
   [GitHub Releases](https://github.com/RichLogic/Gian/releases/latest).
2. Drag Gian into Applications and open it.
3. Sign in with GitHub to initialize Gian on this Mac.
4. Open **Settings → Executors** and set up the agents you want.

For each agent, Gian first detects an existing CLI and lets you provide a
custom executable path. If it is missing, Gian can run the vendor's official
installer. The matching Gian proxy is downloaded separately from the same
Gian GitHub Release and verified before activation.

End users do not need Node.js, pnpm, a cloned repository, or a separately
installed Gian service.

## Supported agents

| Agent | Runtime source | Gian integration |
|---|---|---|
| Codex | OpenAI official CLI | Codex app-server proxy |
| Claude Code | Anthropic official CLI | Claude structured-session proxy |
| Kimi Code | Moonshot AI official CLI | ACP proxy |

## Main capabilities

- Provider-native chat events with UI projections: Claude Code, Codex, and
  Kimi event names and payloads stay intact; Gian classifies them only as
  Message, Activity, Plan, Agent, Interaction, or State for display.
- Structured live transcripts for assistant output, plans, commands, file
  changes, searches, approvals, and errors.
- Approval controls, queued follow-up messages, interruption, and steering.
- Manager-led tasks and isolated Git worktrees.
- Changed-files, tree, diff, and workspace terminal surfaces.
- Native session discovery and resume.
- Optional Discord and Slack bridges.

## How it works

```text
Official Agent CLI ⇄ Gian Proxy ⇄ Gian Host ⇄ Electron App
                                      │
                                      └── local SQLite data
```

The Electron App starts and supervises its bundled Gian Host automatically.
Production access is Electron-only. The local Host is bound to loopback and
uses a per-launch desktop credential, so ordinary web pages cannot operate its
API or terminal WebSocket.

Gian-owned proxy packages are independently installed under Gian's local data
directory. CLI executables remain vendor-owned: an existing or configured path
is preferred, and otherwise the official installer is used.

## Build from source

Requirements: Node.js 22 and pnpm 10.

```bash
git clone https://github.com/RichLogic/Gian.git
cd Gian
pnpm install
pnpm build
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm dev
```

Useful release commands:

```bash
# Build the three versioned proxy assets and SHA-256 files.
pnpm release:proxies

# Build a local macOS Apple Silicon App, DMG, and ZIP.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm desktop:dmg
```

Create a GitHub OAuth App, enable Device Flow, and use its public Client ID.
No client secret is embedded in Gian. The login requests no OAuth scopes, so
it reads only the authenticated user's public profile.

Tagged versions are built, signed, notarized, checked, and published by
`.github/workflows/release.yml`. Maintainers must configure the documented
Apple signing and notarization secrets before pushing a `v<version>` tag.

### Publish a release

Configure these GitHub Actions repository secrets once:

- `MAC_CSC_LINK`: exported Developer ID Application certificate (`.p12`), as
  Base64 or a GitHub-downloadable private URL.
- `MAC_CSC_KEY_PASSWORD`: password for that certificate.
- `APPLE_ID`: Apple ID used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that Apple ID.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

Also configure the repository variable `GIAN_GITHUB_CLIENT_ID` with the public
Client ID of a GitHub OAuth App that has Device Flow enabled.

Keep the root and workspace package versions aligned, commit the release, then
push the matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs all checks, builds the three proxy archives, creates the
signed and notarized arm64 DMG/ZIP, verifies the App with macOS tools, and
publishes every artifact plus SHA-256 checksums to one GitHub Release. No Gian
server is involved.

## Local data

By default Gian stores its database, downloaded proxies, and logs under:

```text
~/.config/gian/
```

Agent credentials and subscriptions are managed by the corresponding official
CLI. Gian does not provide a hosted account or proxy model traffic through a
Gian server.

The GitHub login token is encrypted with macOS secure storage and kept in the
Gian application profile. It is not sent to a Gian server.

## Project status

Gian is in active early development. v0.1 targets macOS Apple Silicon and its
public APIs and plugin contracts may change before v1.0. The future
multi-agent orchestrator called Gian Agent is not part of the current release.

See [the architecture documentation](docs/architecture.md) and
[contribution guide](CONTRIBUTING.md) for development details. The native
event/UI relationship and its smoke-test layers are documented in
[`docs/chat-event-display.md`](docs/chat-event-display.md).

## License

MIT — see [LICENSE](LICENSE).
