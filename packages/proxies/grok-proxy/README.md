# @gian/grok-proxy

Shared structured-runtime adapter for Grok Build's ACP server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.1`-`2.3`.
- a session-scoped child `grok [--deny <rules>...] --disallowed-tools search_tool,use_tool agent --no-leader stdio`:
  official ACP v1 via `@agentclientprotocol/sdk`. The Proxy process starts only
  after the Gian session cwd is known so `GROK_SANDBOX=workspace` matches that
  cwd.

## Native x.ai extension surface

The stdio `grok agent` registers administrative operations as `x.ai/*`
extension methods. The Proxy version-gates them against
`_meta.agentVersion` (see `runtime/grok-extensions.ts`) and reports
unsupported methods as `CAPABILITY_NOT_SUPPORTED` instead of faking success:

- `x.ai/interject` — mid-turn steer (`turn.steer`).
- `x.ai/session/fork` — native fork with head and exact-turn anchors
  (`targetPromptIndex`, 0-based inclusive); backs `session.fork` and Side
  Chat.
- `x.ai/session/rename` — native rename; method-not-found surfaces honestly.
- `x.ai/session/delete` — native delete, guarded: attached or
  Side-Chat-backed sessions and sessions missing from the native directory
  listing are never deleted.
- `x.ai/session/update_mcp_servers` — mid-session MCP swap for admitted Host
  servers.
- `x.ai/mcp/list`, `x.ai/skills/list`, `x.ai/hooks/list` — read-only
  inventory backing `customization.list`/`customization.detail`. Nothing is
  executed and no MCP server is contacted by the inventory paths.

Reverse requests from the agent (`x.ai/ask_user_question`,
`x.ai/exit_plan_mode`, `x.ai/mcp/elicit`) map to Gian `interaction.requested`
events; answers, partial answers, cancellations, and turn-end expiry all
settle the blocked agent request honestly.

## Host Streamable HTTP MCP injection

`session.create` accepts `hostServices` descriptors
(`{ id, protocol: 'mcp', transport: { type: 'streamable-http', url, headers } }`).
Only Streamable HTTP is admitted (stdio/SSE injection is rejected), and the
spawn-time isolation boundary switches from a blanket `--deny MCPTool(*)` to
per-name denies of every disk-configured MCP server the Host list does not
override. The effective server catalog is re-verified after attach and
unexpected entries are reported on the `mcpBoundary` session-update field.

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
