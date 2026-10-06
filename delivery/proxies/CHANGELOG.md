# Gian Proxies Changelog

## Kimi Proxy 0.4.5 - Unreleased

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

## Grok Proxy 0.3.7 - Unreleased

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
