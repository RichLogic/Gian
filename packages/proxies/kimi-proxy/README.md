# @gian/kimi-proxy

Shared Gian Proxy for Kimi Code, driven by the **Kimi local server API**
(`kimi web` HTTP REST + `/api/v1/ws` WebSocket). The previous ACP transport
(`kimi acp` over `@agentclientprotocol/sdk`) is retired.

The process has two newline-delimited JSON protocols:

- stdin/stdout facing the Gian host: the same request/notification envelope
  used by the other Gian proxies (`gian.proxy/2.1–2.3`).
- HTTP + WebSocket facing a supervised child `kimi web --no-open` process.

The entry point requires an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --kimi-bin /absolute/path/to/kimi
```

## Runtime baseline

- Kimi Code CLI `2.1.x` (verified against the installed `2.1.1`; the manifest
  records `2.1.0` pending a real-acceptance bump). Evidence baseline: the
  server's own OpenAPI 3.0.3 (`/openapi.json`) and AsyncAPI 3.1.0
  (`/asyncapi.json`) documents, plus `packages/kap-server` sources embedded in
  the official binary (`protocol/error-codes.ts`, `transport/ws/*`,
  `middleware/*`).
- The proxy spawns its own dedicated server instance on a proxy-chosen free
  port (loopback only, `--no-open --log-level silent`). The bearer token comes
  from `$KIMI_CODE_HOME/server/server.token` (persisted by the CLI; rotated
  via `kimi web rotate-token`). A crashed server is detected via the child
  exit promise and surfaced as retryable `runtime.error`.
- Sessions live in the shared Kimi store (`~/.kimi-code/sessions`); the proxy
  is a client, never the owner of history.

## Architecture

```
src/cli/spawn.ts            outer NDJSON loop, task queue (session-serial +
                            pipelined scans), drain-on-EOF/shutdown
src/protocol/v2-adapter.ts  gian.proxy surface, idempotency ledgers, catalog
src/core/service.ts         orchestration: session lifecycle, turns,
                            interactions, fork/sidechat, diff fetch
src/core/projector.ts       per-session WS frame → gian notification
                            projection (native IDs, seq-guard dedup)
src/core/replay.ts          persisted messages → replay events (identity
                            shared with the live stream)
src/core/diff.ts            LCS unified diff from file-history checkpoints
src/core/input.ts           outer input items → prompt content blocks
src/core/customization.ts   read-only skills/mcp/hooks/rules inventory scan
src/runtime/server-supervisor.ts  spawns/stops `kimi web`, token discovery
src/runtime/rest-client.ts  envelope client + numeric error codes
src/runtime/kimi-server.ts  WS facade: subscribe/cursors/reconnect/resync
src/runtime/ws.ts           minimal RFC 6455 client (text frames)
```

Deleted with ACP: the proxy-owned tool-terminal service (~900 lines +
drain/fence machinery), the turn-identity persistence, the replay capture
window, the hidden `/usage`–`/status` capture turns, and the ACP SDK
dependency.

## Capability map

### Supported (all evidenced against the 2.1.1 server surface)

| Capability | Mechanism |
|---|---|
| `input.text` | `POST /sessions/{id}/prompts` content `{type:"text"}`. |
| `input.localImage` | Content part `{type:"image", source:{kind:"path", path}}` — the server reads the local file itself (OpenAPI image source union). Validated (absolute path, regular file) before submission; no staging, nothing to roll back. |
| `input.localFile` | Content part `{type:"file", path, name?, media_type?}` (same union). |
| `input.skill` | Prompt-level `skills: [{name, args?}]` — the native per-turn activation (REST analogue of the `/<skill>` slash command). |
| `turn.start` | `POST prompts` with a client-derived deterministic `prompt_id`; `PROMPT_ID_CONFLICT` (40927) makes retries idempotent. Turn config (model/thinking/permission_mode) rides the prompt as server-native turn-scoped overrides. A `queued` status means the server already had an active prompt → `SESSION_BUSY` instead of a silently queued turn. |
| Turn events | `turn.started/ended` (native numeric turnId), `assistant.delta`/`thinking.delta` (volatile), `tool.call.started` (args + structured display), `tool.result`, `agent.status.updated` usage. Terminal is finalized deterministically by the projector: open content completes, pending interactions resolve `turn_ended`, final session usage (bounded REST) attaches, then exactly one `turn.completed`/`turn.failed`. |
| `turn.interrupt` | `POST prompts/{prompt_id}:abort` → `{aborted, at_seq}`; accepted aborts map `turn.ended(cancelled)` → `stopReason:"interrupted"`. A settle watchdog (15 s) fails the turn if the server never ends it. |
| `turn.steer` | Queue a prompt (`prompt_id` deterministic; 40927 ⇒ identical replay) then `POST prompts:steer {prompt_ids}`. Without a running turn the proxy fails with `TURN_NOT_FOUND` before submitting (upstream would silently queue). `prompt.steered` surfaces as a notice activity; the steered turn keeps its identity and terminal. |
| `interaction` (permissions) | `event.approval.requested` → `interaction.requested` (`Allow`/`Deny`), `POST /approvals/{id} {decision, feedback?}`; expiry/foreign resolution → honest `interaction.resolved(cancelled)`; 40902/41001 → `INTERACTION_NOT_FOUND`. |
| `interaction` (structured questions) | `event.question.requested` keeps every question/header/options/multi_select/allow_other as gian `inputs`; accept posts the native `answers` map (+`note`), decline posts `:dismiss`. responseId ledger replays duplicates and CONFLICTs on reuse with different content. |
| `session.rename` | `POST /sessions/{id}/profile {title}` — native rename. |
| `session.fork` (head) | `POST /sessions/{id}/children` (the upstream head fork); child adopted (resume + subscribe), origin anchored on the last completed native turn. |
| `session.fork.atTurn` | **Unsupported**: the engine `forkSessionOptionsSchema` has `turnIndex`, but the REST surface exposes no turn boundary (only head children). Refused with `FORK_BOUNDARY_UNAVAILABLE` naming the evidence. |
| `sidechat.*` | Create = head child of the parent with an opaque encrypted resume ref (`OpaqueSidechatResumeStore`, GIAN_PLUGIN_DATA_DIR key); resume reattaches the child; close detaches + tombstones the ref, `providerDataDeleted:false` (child `:delete` permanence unverified). |
| `session.native.list` | `GET /sessions` (cursor pagination mapped to the outer cursor; busy sessions excluded — they are not adoptable; owned sessions filtered). |
| `session.native.delete` | `POST /sessions/{id}:delete` (`{deleted:true}`). Attached sessions refuse with `SESSION_BUSY`. |
| `session.replay` + adoption | `GET /messages` (cursor-paged) → replay events keyed by native `prompt_id`; terminal eventIds shared with the live projector, so attach-replay and `session.replay` name identical facts. `nativeSession.history:"replay"` projects the transcript onto the fresh stream in the create response barrier. |
| `event.plan` | Native `tool.call.started display.kind:"todo_list"` items → `plan.updated` (status map done→completed); `plan_review` displays carry the plan text. Fingerprint-deduped. |
| `event.diff` | Per-turn `GET /file-history/changes?turn_id` (path/status/additions/deletions) + before/after `file-history/content` checkpoints rendered as a bounded LCS unified diff. All facets bounded (3 s) — a wedged REST call skips the facet instead of stalling the terminal. |
| Subagent/task activity | `subagent.spawned/started/completed/failed/cancelled` and `task.*`/`background.task.*` → `activity.updated` with `presentation.type:"agent"`, stable identity = `subagentId`/`taskId`, `parentToolCallId` preserved. Subagent streams (non-main agentId) do not pollute the main transcript. |
| `event.usage` | `agent.status.updated.usage.total` (by-model tokens) live; final session usage attached at the terminal. |
| `catalog.list/resolve` | `GET /models` (provider aliases, `support_efforts`, `default_effort`, `max_context_size`) + `GET /config` default model. Model/thinking/approval options; switching models drops stale thinking values. |
| `customization.list/detail` (2.3) | Read-only filesystem inventory (skills/mcp/hooks/rules), unchanged from the ACP generation. Hooks stay scan-only: the server API has no hook enumeration either. |

### Unsupported (with upstream evidence)

| Capability | Reason |
|---|---|
| Host MCP injection (`hostServices`) | `POST /api/v1/sessions` accepts no inline MCP servers: the engine's ephemeral per-session `mcpServers` (`klient` createSessionOptionsSchema) never crossed to the REST surface, and `POST /v2/mcp/servers` writes the user-level `mcp.json`, which exceeds Gian's "never modify user config" boundary. Refused with `CAPABILITY_NOT_SUPPORTED` naming the evidence. |
| `session.fork.atTurn` | See above: no REST turn boundary. |
| MCP elicitation | Not present in the server API (no elicitation route or ws event); Kimi's question channel is the agent's own AskUserQuestion, which the proxy already surfaces. |

## Error mapping

Numeric business codes (`kap-server/src/protocol/error-codes.ts`) map to gian
DomainCodes in `normalizeKimiError`: 40001/40002/40409/41301 → `INVALID_PARAMS`,
40401 → `SESSION_NOT_FOUND`, 40901 → `SESSION_BUSY`, 40402 → `TURN_NOT_FOUND`,
40404/40405/40902/40909/41001/41002 → `INTERACTION_NOT_FOUND`, 40927 →
`CONFLICT`, 40110–40113 → `RUNTIME_AUTH_REQUIRED`, 40926 → retryable
`RUNTIME_ERROR`. WS `error` events map by string code
(`auth.*` → `RUNTIME_AUTH_REQUIRED`, `context.overflow` → `SESSION_ERROR`,
`loop.max_steps_exceeded` completes with `limit_reached`).

## Restart semantics

A server exit marks every attached session `stale`, fails the active turn
(retryable), and emits `runtime.error`. The next `session.create` with the
same native id rebinds (GET-then-subscribe; no second native session is
created), and a proxy restart rebinding is driven by the Host's persisted
native session id. WS reconnects resubscribe with the last delivered
`{seq, epoch}` cursor; `resync_required` fails an in-flight turn honestly and
re-anchors on the session's `last_seq`.

## Verification

- `pnpm -F @gian/kimi-proxy test` — 46 deterministic tests against a fake
  local server (REST envelope + WS frames + journal seq/epoch semantics),
  driving the real proxy CLI end to end: supervisor/token discovery, prompt
  payloads, event projection and barrier ordering, steering, abort/interrupt,
  approvals/questions round-trips, plan/subagent/diff facts, fork/sidechat
  lifecycle, native list/rename/delete, history-replay identity parity,
  crash-stale-rebind, error-code mapping, catalog resolution, and Host
  schema conformance (`proxyNotificationSchema`) for projected streams.
- `pnpm -F @gian/kimi-proxy typecheck`.
- NOT RUN: real-server acceptance (`KIMI_BIN` against a logged-in
  `kimi web 2.1.1`). The fake encodes the researched upstream surface, but
  steer-into-active-turn timing, `:delete` permanence for child sessions, and
  `blocked` prompt admission deserve a real-server pass before shipping.
