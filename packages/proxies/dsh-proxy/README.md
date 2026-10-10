# @gian/dsh-proxy

`ai.deepseek.harness` — shared-scope Gian Proxy speaking `gian.proxy/2.1+`
(JSON-RPC 2.0 / NDJSON / stdio) and supervising one shared DSH Host that runs
the `gian` profile with `@gian/dsh-bridge`.

## Layout

- `manifest.json` — Manifest v4 (`id: ai.deepseek.harness`, `process.scope:
  shared`, protocol range `>=2.2 <3.0`, verified runtime `0.2.0-rc.2`).
- `src/core/service.ts` — session/turn projection, stable `sourceTurnId` /
  `stepId` / `eventId` identity, terminal-state enforcement, runtime-exit
  terminalization.
- `src/protocol/v2-adapter.ts` — `gian.proxy` dispatcher and capability
  narrowing from verified bridge facts.
- `src/runtime/bridge-client.ts` — bridge/1.0 JSON-RPC client + DSH child
  supervisor (start/request timeouts, POSIX process-group shutdown, exit
  fan-out).
- `src/cli/spawn.ts` — stdio entry.

## Runtime baseline

The production Bridge targets `@deepseek-ai/dsh@0.2.0-rc.2` (npm `latest`,
upstream tag `dsh-v0.2.0-rc.2`, commit
`639ed015397290b3745d163aafe02ffee4aa3f84`, session format 4). Capabilities
are advertised only when the connected Bridge reports the corresponding native
boundary; everything else fails closed with `CAPABILITY_NOT_SUPPORTED`.

## Capability matrix

| Capability | Status | Native evidence |
|---|---|---|
| `input.localFile` / `input.localImage` | supported | `ctx.attachments.saveFile/saveImages` → durable `FileAttachmentRef`/`ImageAttachmentRef` content blocks; admission before turn acceptance |
| `input.skill` | supported | `ctx.skills.get` + runtime `renderSkillContent`; native `skill-invocation` instructions-form injection |
| `turn.steer` | supported | `agent.steer` consumed at the open turn's next step boundary; active-turn-only, retry-idempotent |
| `session.fork` / `session.fork.atTurn` | supported | `agents.create` with `parentSession`/`isSeeded`/verified seed prefix; atTurn cuts at the durable `turn/end` seq; unverifiable boundaries → `FORK_BOUNDARY_UNAVAILABLE` |
| `session.native.list` | supported | `ctx.sessionPersistence.list()` metadata (read-only; subagent and fork-lineage children excluded) |
| `session.resume` / replay | supported (Gian-owned) | `AgentRegistry.resume` behind the per-process Host binding proof; unattested native adoption fails closed (no ownership identity in the storage contract) |
| `event.plan` | supported | `todo/write` → `plan.updated` (stable `planId`, content-derived step ids); `plan/mode` stays a generic activity (different semantics, documented) |
| `event.diff` | supported | `tool/result` `FsDiffMeta` hunks → per-file `diff.updated` with stable `diffId`; no meta → no diff, never guessed from tool arguments |
| `interaction` | supported | approvals + structured user questions (select/multi/text/plan-review), `responseId` idempotency with `CONFLICT` on changed answers, `turn_ended`/`runtime_ended` settlement |
| subagent activity | partial | `subagent/start`/`end` and attributed child tool activity project to agent activities with native runIds; child events are not in the parent durable log, so replay does not re-project them |
| `event.reasoning` / `usage` / `step` / `request` | supported | durable `assistant/message` blocks, per-step usage, step boundaries, request headers |
| `session.rename` | unsupported | `SessionHeader` has no title; `SessionTitleService.rename` exists in 0.2.0-rc.2 and is not connected |
| `session.native.delete` | unsupported | `SessionPersistence` contract exposes create/open/flush/stat/list only — no delete |
| `sidechat` | supported at idle turn boundaries | a native fork creates a transient child with an opaque sealed resume reference; `resume` reattaches it, while `close` detaches and tombstones the reference without claiming Provider data deletion. Active-input anchors remain unavailable. |
| `integration.mcp.streamableHttp` | unsupported | MCP servers are static profile plugin instances with no session isolation boundary; Host MCP injection fails loud (`hostServices` rejected) |
| `customization.list` | partial | `skill` kind inventories `ctx.skills` read-only (`provider_api`, stable `ci1_` ids); `mcp`/`hook`/`rule` answer `provider_unsupported` — no enumeration API in this build |
| Agent Presets vs approval mode | distinct | Agent Presets stay session-bound (`agent_preset`); approval maps to real `ctx.permissionPresets` presets (`permission_preset`) |

Catalog Provider, model, and reasoning selections are applied through DSH's
per-Agent request waterfalls (still the 0.2.0-rc.2 mechanism); per-model reasoning
choices regenerate on model switch and a stale inherited effort is cleared.
Catalog input descriptors mirror the runtime-truth attachment/skill surfaces.

## Identity and replay

`sourceTurnId` (`nativeSessionId:turn:N`), `stepId`, `contentId`, `planId`,
and `diffId` derivations are identical in live projection and replay, and
replay `eventId`s reuse the live hash inputs over the durable native seq — a
Host can reconcile both streams without duplicates. Transient assistant chunks
(live-only in DSH 0.2.0-rc.2) carry attempt/index identity and are never replayed
or fabricated. Approval audit events (`approval/asked`/`decided`) project to
interactions on replay only; live interaction ids come from the answerer
waterfall, which upstream does not correlate with the durable audit id — the
one identity seam upstream does not expose.

## Test

```sh
pnpm -F @gian/dsh-proxy test
```

The suite runs the complete `gian.proxy` contract through
`@gian/proxy-protocol`'s `HostProtocolValidator` against a fake bridge runtime:
initialize identity and capability narrowing, catalog (input descriptors,
permission presets, agent presets), session create/reattach idempotency, turn
lifecycle, steering, fork (head and turn-anchored), Side Chat
create/resume/close, native list, plan/diff projections, interaction
idempotency, replay identity parity, runtime-crash terminalization, and the
real stdio CLI path — zero model calls.
