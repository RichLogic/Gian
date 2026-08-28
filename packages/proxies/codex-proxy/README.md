# @gian/codex-proxy

Shared structured-runtime adapter for Codex app-server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.1` only (JSON-RPC, string ids).
- stdin/stdout facing one shared Codex app-server child for all attached Gian
  sessions (`--listen stdio://`, JSONL with the `jsonrpc` header omitted).

Codex CLI 0.100.0 is the minimum version with the umbrella
`codex app-server --listen stdio://` form. Gian's managed Proxy manifest
currently recommends 0.146.0, so no version recommendation bump is required.

The entry point may take an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --codex-bin /absolute/path/to/codex
```

Implemented host-facing methods are listed by `initialize`. Process scope is
`shared`. Native list/adopt/replay, rename, steer, and interaction (approvals
plus `requestUserInput`) are advertised. `session.native.delete` and
`integration.mcp.streamableHttp` are not.

```sh
pnpm -F @gian/codex-proxy typecheck
pnpm -F @gian/codex-proxy test
```
