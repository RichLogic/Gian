# Gian Proxies Changelog

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
