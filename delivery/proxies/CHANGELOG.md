# Gian Proxies Changelog

## Claude Proxy 0.3.8 - 2026-10-18

- Target the current official Claude Code 2.1.302 Runtime, promoted to the
  /latest channel, npm latest and GitHub latest on 2026-10-16; the
  darwin-arm64 checksum and size match the official 2.1.302 manifest.
- Review the upstream 2.1.302 changelog: no wire-protocol or spawn-surface
  changes affect the adapter; the flag surface was re-verified on the new
  binary. The gian.proxy wire contract is unchanged.

## Grok Proxy 0.3.11 - 2026-10-18

- Target the managed Grok CLI 1.0.62 Runtime, promoted to stable on x.ai/cli,
  the official GCS mirror and npm `@xai-official/grok` latest; bytes from
  x.ai and GCS are identical.
- Verify the spawn surface and the ACP initialize contract on the new binary
  (`agentVersion` 1.0.62, `grokShell`, unchanged capability shape; raw
  handshake evidence preserved). Per-version upstream notes for
  1.0.53–1.0.62 are NOT_OBSERVED in the accessible official changelog, whose
  latest entry remains 1.0.52 — recorded honestly instead of blocking the
  promoted stable channel.
- Known limitation unchanged: native approval cards under
  auto/always_approve snapshots remain unverified — the permission wire path
  requires an authenticated session, which this release does not exercise.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.7 - 2026-10-17

- Target the current official Claude Code 2.1.301 Runtime, promoted to the
  /latest channel, npm latest and GitHub latest on 2026-10-15; the
  darwin-arm64 checksum and size match the official 2.1.301 manifest.
- Review the upstream 2.1.301 changelog: no wire-protocol or spawn-surface
  changes affect the adapter; the flag surface was re-verified on the new
  binary. The gian.proxy wire contract is unchanged.

## Codex Proxy 0.3.6 - 2026-10-17

- Target the managed Codex CLI 0.163.0 Runtime (first stable of the 0.163
  line, published 2026-10-15), up from 0.162.1; the archive SHA-256 matches
  the official `rust-v0.163.0` GitHub asset metadata.
- Protocol review against exact old/new app-server schema files: every
  Proxy-used surface is additive-only (optional `excludedThreadIds`,
  `retain`, read-state notifications, response-item fields); ServerRequest
  is byte-identical and no method the Proxy calls was removed or changed
  (unrelated realtime voice enums also changed; the Proxy does not use
  them). Live no-credential `initialize` handshakes succeed identically on
  0.162.1 and 0.163.0.
- The gian.proxy wire contract is unchanged.

## Grok Proxy 0.3.10 - 2026-10-17

- Target the managed Grok CLI 1.0.60 Runtime, promoted to stable on x.ai/cli,
  the official GCS mirror and npm `@xai-official/grok` latest; bytes from
  x.ai and GCS are identical.
- Verify the spawn surface and the ACP initialize contract on the new binary
  (`agentVersion` 1.0.60, `grokShell`, unchanged capability shape);
  version-specific upstream notes for 1.0.53–1.0.60 are NOT_OBSERVED in the
  accessible official changelog, which currently shows 1.0.52 as its latest
  entry — recorded honestly instead of blocking the promoted stable channel.
- Known limitation unchanged: native approval cards under
  auto/always_approve snapshots remain unverified — the permission wire path
  requires an authenticated session, which this release does not exercise.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.6 - 2026-10-15

- Target the current official Claude Code 2.1.300 Runtime, up from 2.1.296;
  the darwin-arm64 checksum and size match the official 2.1.300 manifest.
- Review the upstream 2.1.297–2.1.300 changelog: no wire-protocol or
  spawn-surface changes affect the adapter; `--effort`, `--permission-mode`,
  `--output-format stream-json`, `--session-id`/`--resume` and
  `--no-session-persistence` are all present on the new binary.
- The gian.proxy wire contract is unchanged. The previous 2.1.296 Runtime
  and all existing published artifacts remain immutable.

## Codex Proxy 0.3.5 - 2026-10-15

- Target the managed Codex CLI 0.162.1 Runtime, up from the 0.161.0 pin
  published with Codex Proxy 0.3.4; the archive SHA-256 matches the official
  `rust-v0.162.1` GitHub asset metadata.
- Upstream 0.162.0/0.162.1 changes are additive for the app-server surface
  the Proxy bridges; the adapter and the gian.proxy wire contract are
  unchanged.

## Kimi Proxy 0.4.7 - 2026-10-15

- Target the Kimi Code CLI 2.2.0 Runtime, up from the 2.1.1 pin published
  with Kimi Proxy 0.4.6; the archive SHA-256 matches the official
  `@moonshot-ai/kimi-code@2.2.0` GitHub asset metadata.
- The published server-api reference diff from 2.1.1 to 2.2.0 is purely
  additive (new Remote Control endpoints, optional request fields), and a
  live 2.2.0 `/openapi.json` + `/asyncapi.json` probe confirmed every REST
  route and WebSocket message type this Proxy uses. The adapter and the
  gian.proxy wire contract are unchanged.

## Grok Proxy 0.3.9 - 2026-10-15

- Target the managed Grok CLI 1.0.52 Runtime, up from the 1.0.46 pin
  published with Grok Proxy 0.3.8; the bytes are identical from `x.ai/cli`
  and the official GCS mirror.
- Verify the spawn surface on the new binary (`agent stdio`, `--no-leader`,
  `--deny`, `--disallowed-tools`, `GROK_SANDBOX`) and the ACP initialize
  contract (`grokShell`, model/reasoning catalog); extension methods stay
  lazily confirmed per attach.
- Known limitation: native approval cards observed for compound shell
  commands under 1.0.46 despite `auto`/`always_approve` snapshots remain
  unverified on 1.0.52 — the permission wire path requires an authenticated
  session, which this release does not exercise. No behavior fix is claimed.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.5 - 2026-10-12

- Resolve model defaults before checking conditional effort support, so an
  effort-only creation draft can use the configured default model.
- Omit disabled effort defaults and retain the resolved model-specific
  catalog for validation of the first turn.
- Target the current official Claude Code 2.1.296 Runtime. The previous
  2.1.285 Runtime and all existing published artifacts remain immutable.
- Owner-selected direct publication; all tests, Runtime probes and archive
  self-tests are NOT_RUN.

## Claude Proxy 0.3.4 - 2026-10-11

- Read Claude Code's native model catalog through a metadata-only initialize
  handshake, including native variants and each model's effort levels.
- A configured default such as `opus` no longer hides the rest of `/model`.
  Preserve existing model configuration ids and explicit gateway menus.
- Bound the discovery process and clean it up on timeout or Proxy shutdown;
  discovery disables hooks, MCP, tools and transcript persistence and sends
  no user message.
- Owner-selected direct publication. Tests, Runtime probes and archive
  self-tests were not run. Retain the existing Claude Code 2.1.285 Runtime.

## Claude Proxy 0.3.3 - 2026-10-11

- Target the managed Claude Code 2.1.285 Runtime, up from the 2.1.280 pin
  published with Claude Proxy 0.3.2.
- Keep the Claude session across an interrupt and resume it on the next turn
  with the current model and effort; resume waits for the CLI session init
  instead of passing an id Claude never created.
- A CLI exit during an active turn fails the turn with the exit code, signal
  and streamed length; unexpected exits are retryable, while provider errors
  such as authentication failure stay not retryable.
- Discover the model catalog from the wrapper's own HOME and settings; the
  gian.proxy wire contract is unchanged.

## Codex Proxy 0.3.4 - 2026-10-11

- Target the managed Codex CLI 0.161.0 Runtime, up from the 0.159.2 pin
  published with Codex Proxy 0.3.3.
- Page long native histories through disk with pinned Fork ancestry, stable
  event identity, immutable cursors and bounded incremental reads; replay
  failures stay isolated to their attachment generation.
- Report the actual Proxy package version to the Runtime instead of a stale
  hardcoded value. The gian.proxy wire contract is unchanged.

## Kimi Proxy 0.4.6 - 2026-10-11

- Preserve turns across Runtime disconnects: notification counters reset on a
  new stream binding, event delivery resumes from durable cursors, and only a
  child process exit is treated as runtime-down.
- Declare the native cancel action on confirmation prompts, keeping valueless
  cancellation explicit for input gating. Keep the Kimi Code 2.1.1 Runtime pin
  and gian.proxy wire versions unchanged.

## Grok Proxy 0.3.8 - 2026-10-11

- Target the managed Grok CLI 1.0.46 Runtime, up from the 1.0.41 pin published
  with Grok Proxy 0.3.7.
- Catalog inspection no longer delays shutdown: successful model metadata
  inspections are reused, failed cleanup and empty snapshots are retried, and
  only inspection children are force-stopped — live sessions keep their
  graceful shutdown.
- Declare native cancellation action IDs so valueless cancellation stays
  explicit in the Host/Web input gating. The gian.proxy wire contract is
  unchanged.

## DeepSeek Harness Proxy 0.3.5 - 2026-10-11

- Target the DeepSeek Harness 0.2.0-rc.2 Runtime with Bridge 0.1.6, reading
  session logs as format 4; the published 0.3.3 pinned Runtime 0.1.5-rc.3
  (0.3.4 was prepared but never published).
- Add Side Chat with idle-only anchors, a sealed resume reference persisted
  across Proxy restarts, and a close barrier that terminalizes the active
  turn; native session.fork with a verified seed prefix and structured
  attachment/skill input.
- Replace a saved model the Runtime no longer advertises with the advertised
  default before turn.start, and carry a reselect notice on the turn. The
  gian.proxy wire contract is unchanged.

## Kimi Proxy 0.4.5 - 2026-10-07

- Materialize native cold Side Chat children before subscribing and reject
  failed subscription acknowledgements. Keep child events and terminal state
  bound to the actual child turn.
- Forward Stop to the native Runtime and settle interrupted turns without
  requiring Host fencing; preserve follow-up turns and interaction cancellation.
- Keep the Kimi Code 2.1.1 Runtime pin and gian.proxy wire versions unchanged.

## Catalog 1.19.0 - 2026-09-30

- Select the published Kimi Proxy 0.4.4 release and its unchanged Kimi Code 2.1.1 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.18.0, including Codex Proxy 0.3.3 / Codex CLI 0.159.2. No App release.

## Catalog 1.18.0 - 2026-09-30

- Select the published Codex Proxy 0.3.3 and its Codex CLI 0.159.2 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.17.0. No App release.

## Codex Proxy 0.3.3 - 2026-09-30

- Target the managed Codex CLI 0.159.2 Runtime with the existing app-server adapter.
- Retain the gian.proxy wire contract and the previously published Codex Proxy and Runtime for rollback.

## Kimi Proxy 0.4.4 - 2026-09-30

- Show assistant prose as its own text stream on each step. Thinking stays reasoning, also split per step, and tool results keep command, file, and search presentation.
- Enable fork and side chat after a completed turn while the session is idle. Forking from a specific turn stays unavailable.
- Accept volatile frames that reuse the current sequence, and include the turn prompt id on usage events.
- This release does not change the Proxy wire protocol or the Kimi Code 2.1.1 Runtime pin.

## Grok Proxy 0.3.7 - 2026-10-07

- Bind model and reasoning effort to the turn. Permission mode stays session-bound.
- Require `workspace.roots` to include the session directory. The Host may also list the session attachment directory; that path is not added to the sandbox.
- Hold turn events that arrive before `turn.started`, and drop usage deltas after the turn ends.
- Normalize native interaction IDs across tool metadata and interaction events;
  retain first-turn ordering and configuration validation during model changes.
- Refresh the Grok Build logos and show the default permission mode as Default.
- This release does not change the Proxy wire protocol or the Grok CLI 1.0.41 Runtime pin.

## Catalog 1.17.0 - 2026-09-28

- Select the published Kimi Proxy 0.4.3 release and its Kimi Code 2.1.1 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.16.0. No App release.

## Kimi Proxy 0.4.3 - 2026-09-28

- Keep previously returned Catalog revisions valid while the underlying Kimi
  model catalog is unchanged, so switching models can refresh the available
  reasoning efforts without an erroneous revision rejection.
- Require a new `catalog.list` when the underlying model catalog changes.
  This release does not change the Proxy wire protocol or the Kimi 2.1.1 Runtime pin.

## Published Catalog history restored - 2026-09-28

- Restore the Catalog source that shipped without being merged to main. Grok
  0.3.6 is an official Catalog plugin, and the authored histories match Catalog
  1.16: Claude 0.3.2, Codex 0.3.2, Kimi 0.4.2, DeepSeek 0.3.3, ZCode 0.4.2, and
  Grok 0.3.6.
- DeepSeek Proxy 0.3.4 and ZCode Proxy 0.4.3 on main already match those
  published local builds. Source may stay ahead of the last signed snapshot.
- ZCode qualification uses a short macOS temporary directory so the Runtime
  socket fits `sun_path`, and keeps a redacted stderr tail when the catalog
  probe exits early.

## Catalog 1.10.0 - 2026-09-24

- Select the certified Claude 0.3.2, Codex 0.3.2, Kimi 0.3.3 and DeepSeek 0.3.2
  releases with their verified Runtime combinations; DeepSeek includes Bridge 0.1.4.
- Refresh Chinese and English version histories from the actual published assets.
- Retain ZCode 0.3.2 and its complete executable/certificate coordinates unchanged.
  Grok remains excluded. Existing Proxy archives are not rebuilt.

## 2026-09-24 - CLI compatibility update

- Claude Proxy 0.3.2 targets Claude Code 2.1.280 and preserves inherited Fork
  turn identities and idempotent Side Chat resume.
- Codex Proxy 0.3.2 targets Codex CLI 0.156.1, reads modern/lazy Fork history
  from the selected CODEX_HOME, and cleans up Runtime descendants on shutdown.
  Text translation uses fresh isolated threads; closing those threads no longer
  attempts to read their unsupported ephemeral history.
- Kimi Proxy 0.3.3 targets Kimi Code 2.1.0, fixes model-dependent thinking and
  replay identities, and does not consume a history ordinal for rejected turns.
  Native rename is no longer falsely advertised; Gian-local naming is unchanged.
- DeepSeek Proxy 0.3.2 bundles Bridge 0.1.4 and targets DSH 0.1.5-rc.3,
  forwarding transient stream chunks and accepting repeated Session close.
- Use public Proxy Protocol 1.0.1. Model-resolved Host validation requires the
  updated Host implementation; no App release or wire-version change is implied.
- Retain ZCode's existing signed combination unchanged; Grok remains excluded.

## Catalog 1.9.0 - 2026-09-23

- Add Chinese and English descriptions, nine-chapter tutorials and version
  histories for all five shipping Proxies. Compatible Gian clients follow
  their selected UI language; older clients retain the original documents.
- Bind localized metadata and documents to the signed asset manifest without
  changing the strict Catalog v1 index.
- Retain every Proxy, Runtime and certification coordinate from Catalog 1.8.0.
  No executable rebuild, Proxy version bump or App package is included.

## Catalog 1.8.0 - 2026-09-21

- Publish complete nine-chapter tutorials for the five shipping Integrations.
- Publish per-Proxy version histories with immutable release evidence and explicit
  gaps where historical feature notes cannot be recovered.
- Preserve Catalog v1 compatibility: tutorials occupy setup/usage/troubleshooting;
  overview carries the version history. The dedicated App history view remains
  a separate consumer change. Basic state examples are not installed-state data.
- Proxy versions, Runtime combinations, signing identity and executable archives
  are unchanged. No Proxy re-release or App upgrade is included.

## 2026-09-20 - Independent Delivery

Versions follow the individual Proxy packages on GianDev main:

| Proxy | Version |
| --- | --- |
| Claude | 0.3.1 |
| Codex | 0.3.1 |
| DSH | 0.3.1 |
| Kimi | 0.3.2 |
| ZCode | 0.3.2 |

The unified 0.4.0 releases and tags were withdrawn and replaced by the individual
versions above. Repository separation does not assign a shared Proxy version.

- Publish official Proxy packages and their signed Catalog from Gian-Proxies.
- Consume the immutable public Gian Proxy Protocol 1.0.0 package.
- Include DSH Bridge in the DSH Proxy archive, independent of the App bundle.
- Preserve per-Proxy versions, immutable release artifacts and signed Catalog
  anti-rollback sequencing. Existing App installations are not modified.
- ZCode keeps its standalone-startup diagnostics and remains subject to the
  upstream external-App limitations; this release does not restore missing models.
