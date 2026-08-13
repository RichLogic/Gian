# @gian/grok-proxy

Shared structured-runtime adapter for Grok Build's ACP server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/1` only.
- a managed child `grok agent --no-leader --no-auto-update stdio`: official
  ACP v1 via `@agentclientprotocol/sdk`.

The child always receives `GROK_SANDBOX=workspace` and
`GROK_DISABLE_AUTOUPDATER=1`. Accordingly, the V1 adapter accepts exactly the
session cwd as its writable workspace root and rejects broader Host policies.

The entry point requires an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --grok-bin /absolute/path/to/grok
```

Implemented host-facing methods are listed by `initialize`. Grok native
session IDs are routed to per-Gian proxy session IDs; load replay is returned
with `session.create` so the host can persist the Gian row and history
atomically.

```sh
pnpm -F @gian/grok-proxy typecheck
pnpm -F @gian/grok-proxy test
```
