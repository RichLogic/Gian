# @gian/kimi-proxy

Shared structured-runtime adapter for Kimi Code's ACP server.

The process has two newline-delimited JSON protocols:

- stdin/stdout facing Gian host: the same request/notification envelope used
  by the other Gian proxies.
- a managed child `kimi acp`: official ACP v1 via
  `@agentclientprotocol/sdk`.

The entry point requires an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --kimi-bin /absolute/path/to/kimi
```

Implemented host-facing methods are listed by `initialize`. Kimi native
session IDs are routed to per-Gian proxy session IDs; load replay is returned
with `session.create` so the host can persist the Gian row and history
atomically.

This package is intentionally isolated from host/shared/web integration while
those layers are being migrated to executor-native configuration.

```sh
pnpm -F @gian/kimi-proxy typecheck
pnpm -F @gian/kimi-proxy test
```
