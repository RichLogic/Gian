# @gian/codex-proxy

Shared structured-runtime adapter for Codex app-server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.1` only (JSON-RPC, string ids).
- stdin/stdout facing one shared Codex app-server child for all attached Gian
  sessions (`--listen stdio://`, JSONL with the `jsonrpc` header omitted).

Codex CLI 0.100.0 is the minimum version with the umbrella
`codex app-server --listen stdio://` form. Gian's managed Proxy manifest
verifies 0.159.2. Other CLI versions are not certified by this release.

The entry point may take an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --codex-bin /absolute/path/to/codex
```

Implemented host-facing methods are listed by `initialize`. Process scope is
`shared`. Native list/adopt/replay, rename, steer, and interaction (approvals
plus `requestUserInput`) are advertised. `session.native.delete` and
`integration.mcp.streamableHttp` are not.

Native rollout replay is chunk-read and disk-paged, including exact pinned Fork
ancestry. Total history size is not capped at 64 MiB; individual records and
wire pages remain bounded. Appends reuse the committed read offset, and replay
cursors retain immutable snapshots through file rewrites or attachment close.
Derived replay files are private, disposable caches under the plugin data
directory (or private system temporary storage), never replacements for native
rollouts. Normal attachment/process shutdown removes them; restart rebuilds
history rather than trusting a cache left by an unclean exit.

```sh
pnpm -F @gian/codex-proxy typecheck
pnpm -F @gian/codex-proxy test
```
