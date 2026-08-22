# @gian/grok-proxy

Shared structured-runtime adapter for Grok Build's ACP server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.0` only.
- a session-scoped child `grok --deny MCPTool(*) --disallowed-tools search_tool,use_tool agent --no-leader stdio`: official
  ACP v1 via `@agentclientprotocol/sdk`. The Proxy process starts only after
  the Gian session cwd is known so `GROK_SANDBOX=workspace` matches that cwd.

The child always receives `GROK_SANDBOX=workspace` and
`GROK_DISABLE_AUTOUPDATER=1`. Accordingly, the adapter accepts exactly the
session cwd as its writable workspace root (`workspace.roots` must be `[cwd]`).

The entry point requires an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --grok-bin /absolute/path/to/grok
```

Implemented host-facing methods are listed by `initialize`. Grok native
session IDs are routed to per-Gian proxy session IDs. `session.replay` imports
native load history when `nativeSession.history` is `replay`, then records
later live turn events with stable `eventId`s.

```sh
pnpm -F @gian/grok-proxy typecheck
pnpm -F @gian/grok-proxy test
```
