# @gian/dsh-bridge

Gian-managed Cordis bundle that speaks `gian.dsh.bridge/1.0` inside a DSH
`gian` profile. The bundle is a patch layer applied **after**
`@deepseek-ai/dsh-base`; it does not mount DSH Web, Browser UI, or the headless
one-shot runner, and it keeps stdout exclusively for bridge JSON-RPC.

## Runtime baseline

The production baseline is `@deepseek-ai/dsh@0.1.5-rc.3` (npm dist-tag
`latest`, integrity
`sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==`,
upstream tag `dsh-v0.1.5-rc.3`, commit
`a4c74a91e06b00fe0b0937bde982170c526cc842`). The session format version the
bridge reports and keys its identity with is DSH `SESSION_FORMAT_VERSION = 3`.
Every native surface below was checked against the shipped `.d.ts` contracts
of that build before the bridge advertises it; the real Cordis host probes the
mounted services at `initialize` and reports only what is present.

## Contract

- Schema: `src/schema.ts` (method/notification tables, JSON-RPC envelope).
- Transport: `src/jsonrpc.ts` (UTF-8 NDJSON stdio, no batch, ≤16 MiB lines).
- Server: `src/server.ts` (bridge/1.0 request routing and correlation).
- Real runtime seam: `src/cordis-host.ts`; deterministic fake: `src/fake-host.ts`.

## Native capabilities

- **Structured input** — `turn.start` admits `localImage` / `localFile` /
  `skill` items through the native boundaries *before* any turn ordinal is
  consumed: images and files are committed via `ctx.attachments.saveImages` /
  `saveFile` into durable `ImageAttachmentRef` / `FileAttachmentRef` content
  blocks (`@deepseek-ai/dsh-attachment`); skills resolve through
  `ctx.skills.get` and inject the runtime's own `renderSkillContent` body as
  instructions-form context with the native `skill-invocation` source.
  Path, existence, media-type, and byte-limit failures reject the turn
  without appending an event.
- **Steer** — `turn.steer` calls `agent.steer` (consumed at the nearest step
  boundary of the open turn) and refuses with `TURN_NOT_FOUND` when no native
  turn is open; queueing for a later turn is never substituted.
- **Fork** — `session.fork` uses the native fork path
  (`agents.create` with `parentSession` / `isSeeded` / verified seed prefix /
  `inheritedEventCount`): head forks anchor on the verified last closed turn,
  turn forks cut exactly at the source turn's durable `turn/end` seq, and any
  unverifiable boundary returns `FORK_BOUNDARY_UNAVAILABLE` instead of a
  guessed sequence number. Parents are only read.
- **Native history** — `session.native.list` projects
  `ctx.sessionPersistence.list()` metadata (subagent-origin children stay out);
  `session.events.read` pages the live durable log for replay. Adoption of
  unattested native sessions still fails closed (the storage contract exposes
  no ownership identity); Gian-owned sessions resume through
  `AgentRegistry.resume` behind the per-process Host binding proof.
- **Interactions** — tool approvals ride the `approval/request` waterfall and
  structured user questions (single/multi select, free text, plan-review
  intent) ride `user-questions/request`; both are anchored on the durable ask
  audit seq, settle every pending entry on session close or runtime exit, and
  a dismissed question fails the native ask rather than fabricating an answer.
- **Plan / diff facts** — `todo/write`, `plan/mode`, `approval/*` audit, and
  `tool/result` fs-diff meta (`FsDiffMeta`) are forwarded verbatim as durable
  session events for the proxy to project.
- **Subagents** — `subagent/start` / `subagent/end` runtime events and
  attributed child tool activity are bridged with the parent Gian session and
  the native runId; unattributable children are dropped rather than guessed.
- **Customization inventory** — read-only `customization.list` / `detail`
  over `ctx.skills` (`provider_api`); MCP servers are static profile plugin
  instances and hooks have no enumeration registry in this build, so those
  kinds answer `provider_unsupported` with evidence.
- **Model selection** — provider/model/effort stay per-Agent via the
  `system-prompt/assemble` + `agent/request` waterfalls; an effort the
  selected model does not advertise is cleared instead of guessed. Catalog
  input descriptors advertise exactly the attachment/skill surfaces the
  runtime exposes.
- **Unsupported with evidence** — `session.rename` (no title field in
  `SessionHeader`, no rename surface) and native history deletion (no delete
  in the `SessionPersistence` contract) remain unsupported; the bridge never
  writes user-global config or storage directly.

## Test

```sh
pnpm -F @gian/dsh-bridge test
```

The suite drives two root sessions and an in-process child through the bridge
server with a fake host: event, config, interaction (approvals and structured
questions), cancellation, independent close, structured attachments, skills,
steering, fork boundaries, native list, subagent lifecycle, and
customization inventory — zero model calls.

Real-runtime acceptance (booting the installed DSH package with an isolated
`gian` profile for a stdout-purity and process-cleanup canary, and any real
Provider Turn) is a separately authorized action outside `test:all`; no-cost
protocol handshakes and metadata canaries are scheduled by the coordinator.
