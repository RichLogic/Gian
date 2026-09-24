# Proxy Protocol Changelog

## 1.0.1

- Validate model-dependent Turn options against Session-scoped resolved Catalog
  drafts without replacing active configuration or leaking drafts across Sessions.
- Preserve resolved options across unrelated Catalog refreshes and invalidate
  them when the advertised configuration changes.
- Includes additive slash-command inventory metadata from the current consumer
  contract. Supported wire versions remain unchanged.

## 1.0.0

- First independently distributed JavaScript/TypeScript package from public Gian.
- Includes the existing `gian.proxy` 2.0, 2.1, 2.2 and 2.3 contracts, Manifest
  schemas, conformance validators, framing and runtime installation helpers.
- Exposes the root, `schemas`, `conformance` and Node-only `node` entry points.
- Package versions identify immutable implementation bytes; wire negotiation
  remains authoritative for Host/Proxy compatibility.
