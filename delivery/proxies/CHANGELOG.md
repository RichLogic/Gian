# Gian Proxies Changelog

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
