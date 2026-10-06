# @gian/grok-proxy

Shared structured-runtime adapter for Grok Build's ACP server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.1`-`2.3`.
- a session-scoped child `grok [--deny <rules>...] [--disallowed-tools search_tool,use_tool] agent --no-leader stdio`:
  official ACP v1 via `@agentclientprotocol/sdk`. The Proxy process starts only
  after the Gian session cwd and sandbox profile are known. The default profile
  is `workspace`. `search_tool` and `use_tool` stay disallowed unless Host MCP
  was admitted and `x.ai/mcp/list` proves that set before the session is used.

## Native x.ai extension surface

The stdio `grok agent` registers administrative operations as `x.ai/*`
extension methods. On the wire those names are `_x.ai/*`. The Proxy does not
treat `grokShell` or `agentVersion` as proof that a method exists. A
prefixed-wire `-32601` refutes it. `turn.steer` is advertised only after
`_x.ai/interject` answers `-32602` with `session not found` for a session
that was never created. Unsupported methods are
`CAPABILITY_NOT_SUPPORTED` instead of a fake success:

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
settle the blocked agent request honestly. Interrupt, close, runtime exit,
and the MCP boundary settle a parked permission or question exactly once with
a cancelled outcome before the native cancel. Plan bodies travel as
`context.subject` so the Host renders them; MCP elicitation schemas become
protocol form inputs (string, string enum, boolean, required) and the
response is the MCP `ElicitResult` envelope (`{ action, content? }`) with
typed content rebuilt from the flat protocol values. A schema that uses
anything else (numbers, arrays, nested objects) is declined natively instead
of being faked. Answered interactions accept an identical retried
`responseId` without re-executing natively; a reused `responseId` with a
different payload conflicts, even after the turn has ended.

Plan cancellation carries optional feedback back to `x.ai/exit_plan_mode`.
ACP permission selections return the exact advertised option id; its response
has no defined feedback field. A native rejection can end the prompt, with
revised instructions sent in the next user turn. The Proxy does not fabricate
an acknowledgement or inject an undocumented native feedback payload.

Known model/config bookkeeping notifications stay session-scoped. Sparse tool
updates and turn-end closure retain the original tool title and presentation;
Question cancellation resolves as cancelled on the Host wire.

Model and reasoning effort are per-session state. A fresh session starts at
the runtime default; a loaded/resumed session reports its model only once the
runtime proves it, and fork children inherit the parent's values at fork
time. The MCP disk scan and the child process resolve the same Provider Home
(`GIAN_AGENT_HOME`, then legacy `GROK_HOME`, then the default directory).

Native fork is never probed speculatively (a probe could create session
files): the first user-requested head fork doubles as the confirming call,
and exact-turn forks open only after that confirmation. Exact-turn forks use
the proven absolute native prompt index — imported history counts first, so a
turn after ten replayed prompts forks at index 10, and a `history:none`
resume whose positions cannot be proven refuses exact-turn forks with
`FORK_BOUNDARY_UNAVAILABLE`. Replay turn identity is positional
(`nativeSessionId` + absolute prompt ordinal); input hashes only verify a
binding, so repeated identical prompts never steal each other's identity, and
a history changed by compact/rewind invalidates the old bindings.

## Host Streamable HTTP MCP injection

`session.create` accepts `hostServices` descriptors
(`{ id, protocol: 'mcp', transport: { type: 'streamable-http', url, headers } }`).
Only Streamable HTTP is admitted (stdio/SSE injection is rejected), and the
spawn-time isolation boundary switches from a blanket `--deny MCPTool(*)` to
per-name denies of every disk-configured MCP server the Host list does not
override. With Host MCP, the session is inserted only after `x.ai/mcp/list`
shows that executable set and no other. A later `x.ai/mcp/servers_updated`
notification is the process-local and plugin catalog: it has no session id
and does not include Host MCP injected into a session. The proxy ignores
that body and reads `x.ai/mcp/list` again for each attached session. An
empty local catalog does not by itself remove Host MCP. A real mismatch
blocks later turns. The active turn is cancelled; if that cancel does not
finish, the child process is terminated before the turn is failed. With no
Host MCP, the blanket deny and the meta-tool disallow stay in place;
user-configured MCP is not opened.

The child receives `GROK_DISABLE_AUTOUPDATER=1` and `GROK_SANDBOX` set to the
requested profile (`workspace` by default, or `read-only`, `strict`, or an
explicit `off`). An inherited `GROK_SANDBOX` does not win. The profile is
fixed for that process. `off` widens filesystem and network access relative
to the sandboxed profiles and does not change approval mode. Enterprise
managed requirements can still override the process, so Gian reports the
requested profile rather than a confirmed effective sandbox.
`workspace.roots` must include the session cwd. The Host may also list the
session attachment directory; that path is not added to the sandbox.

The entry point requires an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --grok-bin /absolute/path/to/grok
```

Implemented host-facing methods are listed by `initialize`. Grok native
session IDs are routed to per-Gian proxy session IDs. `session.replay` imports
native load history when `nativeSession.history` is `replay`, then records
later live turn events with stable `eventId`s. Standard ACP v1 diff content
(`path`/`oldText`/`newText`) is rendered into the unified diffs Host displays;
a pre-rendered runtime `diff`/`unifiedDiff` payload is kept verbatim. Native
`refusal` and `max_turn_requests` stop reasons map to `refused` and
`limit_reached`; unknown reasons stay `other`.

```sh
pnpm -F @gian/grok-proxy typecheck
pnpm -F @gian/grok-proxy test
```
