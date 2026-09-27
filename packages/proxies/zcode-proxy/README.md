# com.zhipu.zcode — ZCode Proxy (Gian Plugin)

Shared-scope Gian Proxy speaking **`gian.proxy/2.1–2.3`** outward and **ZCode
Protocol v1 / v4 commands** (the NDJSON protocol of the open-source ZCode CLI
`zcode.cjs app-server --stdio --surface desktop`) inward. Owner of all
ZCode-specific vocabulary: no ZCode method names, permission words, or bundle
types leak into Host/Web.

## Runtime baseline: open-source ZCode CLI 0.16.9

- Upstream repository `https://github.com/zai-org/ZCode`, commit
  `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`, CLI `0.16.9`
  (`runtime.verifiedVersions` / `src/identity.ts`). All capability claims
  below carry a file:line reference into that tree.
- The runtime no longer comes from ZCode.app. Hosted qualification builds the
  complete CLI from the pinned Git commit and publishes a certified archive.
  `provider/zcode-builtin.json` must remain next to `zcode.cjs`; provenance,
  archive contents and the extracted app-server are checked before publication.
- Inner app-servers are pooled per canonical workspace cwd
  (`app-server --stdio --surface desktop`). A crash in one workspace does not
  terminate another.
- 0.16.9 protocol facts this rebase absorbs:
  - `workspace/readState` is gone; the side-effect-free read is
    `workspace/readPresentation` (`packages/shared/src/zcode-protocol/index.ts:1998`).
  - The versioned `gian/modelCatalog` integration exposes allowlisted Registry
    metadata without credentials or session creation. Session snapshots may
    narrow model facts to the current selection.
  - Turns are driven by the v4 `sendText` command
    (`packages/shared/src/zcode-protocol-v4/command.ts:81`); legacy
    `session/send` is deprecated upstream and is never sent by this proxy.
  - The legacy `session/event` stream keeps flowing for v4-driven turns while
    a `desktop-continuous` subscription exists
    (`server-operations.ts` `onSessionEvent`), so live/replay identity is
    unchanged.

## Prerequisites the user must satisfy themselves

- Configure a Provider through the installed CLI's login or TUI. The pinned
  CLI uses `~/.zcode/v2/provider_config.json` and can import legacy
  `~/.zcode/cli/config.json`. The Proxy never writes Provider credentials.

## Capability map

### Supported

| Capability | Upstream mechanism (0.16.9 evidence) |
|---|---|
| `catalog.list` / `catalog.resolve` | `workspace/readPresentation` (mode + slash commands) merged with the pinned `gian/modelCatalog` Registry projection (full configured marketplace and per-model reasoning levels). No session or model request is made, and no credentials cross the boundary. Model values use the reversible `zmodel:v1` encoding; switching provider/model drops stale Thinking values. |
| `input.text` | `v4/command` `sendText` payload `text` (`command.ts:81`). |
| `input.localImage` / `input.localFile` | Desktop "local zero-copy": the attachment ref IS the absolute local path — `{ref, fileName, mime, bytes}` (`useComposerAttachments.ts:643`, `attachment-refs.ts:3-12`); ref → core `TurnAttachment {path, type: image\|video\|pdf\|file by mime}` (`attachment-refs.ts:61-101`). The proxy validates existence, regular-file, MIME kind, and the upstream 20 MiB cap (`zcode-protocol-v4/core.ts:84`) BEFORE sending; there is nothing staged, so validation failure leaves no rollback work. Upstream caps: 20 MiB/file. |
| `input.skill` | The upstream `/skill` canonical prompt (`slash-commands.ts:229` `buildManualSkillPrompt`): "Use the skill named \`X\` … First call the \`Skill\` tool with name \`X\`…". The proxy rewrites the outer skill item to exactly that text; no fake API. |
| `turn.start` | v4 `sendText` with `requestedDelivery: "startNow"`, deterministic `commandId` (CLI command-inbox dedup, `command-inbox.ts`), complete model/reasoning selection applied atomically via `session/setModel`, then approval via `session/setMode`, with restore-on-failure. |
| `turn.steer` | v4 `sendText` with `requestedDelivery: "guide"` — supplementary guidance inlined into the CURRENT turn at the next model-step boundary; the same turn continues (`contracts/src/interfaces/session.port.ts:272-278`, `turn-guide-drain.ts:13-66`). No active turn → explicit `TURN_NOT_FOUND` (upstream would silently degrade a guide to a new send — the proxy refuses instead). Attachments in steer → `INVALID_PARAMS` (upstream `guide.attachmentsUnsupported`, `session-flow.ts:259`). Idempotency: identical text ⇒ identical `commandId` ⇒ CLI `duplicate` ack; different text ⇒ a new steer on the same turn. Native `turn.steerQueued` / `turn.steerDrained` events project as notice activities on the same outer turn. After a runtime restart upstream DISCARDS queued guides (`resume.ts:233` `discardPersistedPendingSteerInputs`); the proxy mirrors this by not surviving steers across restarts. |
| `turn.interrupt` | v4 `stop` command with `expectedForegroundExecutionId` guard; terminal mapping only when the native terminal agrees. |
| `interaction` (permissions) | `interaction/requestPermission` reverse request; the EXACT native response payload round-trips (`interaction-broker.ts:59-134`), subagent `origin` preserved. |
| `interaction` (structured questions) | `interaction/requestUserInput` — AskUserQuestion surfaces with question/header/options/multiSelect intact (`interaction-broker.ts:195-248`); accept maps to `{action:"accept", content:{answers:{questionText: value}}}` (arrays join ", " per upstream `normalizeAnswerValue`); decline → `{action:"decline"}`. Nothing is flattened to plain text. |
| `interaction` (plan approval) | ExitPlanMode uses the same reverse request with `schema.interaction = "plan_approval"` (`interaction-broker.ts:295-345`); the plan text, the canonical question ("Review this implementation plan."), and approve/feedback/decline actions are preserved; feedback maps to upstream `plan_approval_feedback`. |
| `interaction` lifecycle | `interaction.requested` / `interaction.respond` / `interaction.resolved` with responseId idempotency + CONFLICT on reuse with different content; turn end/cancel resolves pending interactions as `turn_ended`, runtime exit/failure as `runtime_ended` and answers the open server requests so ZCode never hangs. |
| `session.rename` | v4 `renameSession` command → `runtime.setCustomSessionTitle` (`session-mgmt.ts:140-152`); title stickiness (`titleSource=custom`) enforced by core. 1–200 code points enforced. |
| `session.fork` (head) / `session.fork.atTurn` | v4 `forkAssistant` — the stable CONVERSATION-ONLY fork ("conversation-only copy; running parent 与 workspace 不动", `fork-edit-retry.ts:6`, `v4-bridge.ts:1162`). The proxy resolves the fork target from the conversation projection: last assistant segment of a successfully completed turn with `actions.canFork` (`product-projection.ts:895-932`), addressed by `{rowId, entityId}` with the `rowsRange` CAS watermark (`baseRevision`/`baseLogEpoch`; one stale-retry). The child is a durable persisted session (`sessionKind: "fork"`, `parentSessionId`) and is adopted via the standard resume+subscribe path. The legacy checkpoint fork (`session/fork`, which restores workspace files) is NEVER called. |
| `session.native.list` | `session/list` (workspace-scoped, `limit`, no native cursor). Interactive and fork sessions that are not already owned are listed; running/waiting ones are not adoptable. |
| Adoption + history recovery | `session/resume` (re-injecting session-scoped Host MCP) + `session/read` + `session/messages`; `nativeSession.history: "replay"` projects the complete persisted transcript — user inputs, assistant text/reasoning, tool calls, usage, terminal state, native `anchorTurnId` identities — onto the fresh stream with eventIds IDENTICAL to a later `session.replay`. |
| `session.replay` | `session/messages` projected to canonical replay events with stable ids; `replayStreamId` revision-pinned. |
| `event.plan` | Native todo facts: the `TodoWrite`/`UpdatePlan` tool (`contracts/src/tools/todo.ts:26`) → `plan.updated` `{content, status: pending\|in_progress\|completed}` steps; identical re-emits collapse. Never guessed from prose. |
| `event.diff` | Edit/Write tool results carry jsdiff `structuredPatch` hunks (`core/src/tool/handlers/edit.ts:530`, `write.ts:154`) → `diff.updated` with real path, added/modified status, and a unified diff (bounded). |
| Subagent activity | `subagent_spawned` / `subagent_stopped` internal events (default-arm `session.updated`, `core/src/subagent/runner.ts:231,351`) → `activity.updated` with `presentation.type: "agent"`, stable identity = `childSessionId`, state running/completed/failed/interrupted, `parentToolCallId` in the presentation data. `session/subagents` remains available as the runtime's query surface. |
| `session.close` | Detach only: drop adapter state, release ownership. The inner close/delete is never called. |
| `customization.list` / `customization.detail` (2.3) | `skill`: `skills/referenceCatalog` (`skill-reference-catalog.ts:16-36`, fresh workspace scan, never executes anything) → `ci1_`-id items with scope/origin/discovery. `mcp`: `mcp/list` with `mode:"status"` — the read-only surface that never connects (`mcp.ts:78-87`) — with transport, toolCount, and status→activation mapping. `hook` / `rule`: `proxy_unsupported` (see below). No credentials exist on these result shapes; inbound Host header values are redacted from logs. |
| Host MCP injection | Outer `hostServices` (streamable-http) → `session/create` / `session/resume` `mcpServers` entries `{name, type:"http", url, headers, isolation:"session"}` — a per-session runtime override (`protocol-mcp-config.ts:4-42`); the user's global config is never modified. Re-injected on resume from the persisted ownership record. |

### Unsupported (with upstream evidence)

| Capability | Reason |
|---|---|
| `sidechat.create` / `sidechat.resume` / `sidechat.close` | Upstream has only "selection side chats" (`createSelectionSideSession`, `session-fork.ts:804-831`): the child always INHERITS the parent's committed context with the transcript rewritten to model-only/hidden (`session-fork.ts:677-693`) and restricts edit/retry/fork/goal commands inside (`commands/executor.ts:10-16`). There is no empty-context side chat and no anchor parameter. Not semantically equal to a Gian Side Chat, so it is refused with `SIDECHAT_UNAVAILABLE` instead of being faked on conversation forks. |
| `session.native.delete` | v4 `deleteSession` is documented as closeSession: "非真删 record——message 库无删除 API" — it unloads the runtime and never purges persisted history (`session-mgmt.ts:154-158`; the in-memory store drop is all `eventStore.deleteSession` does). The proxy therefore keeps `session.close` = detach, keeps history visible and adoptable, and answers `session.native.delete` with `CAPABILITY_NOT_SUPPORTED` naming that evidence. No database/file deletion is performed to fake a native delete. |
| MCP elicitation | Not present upstream: greps for `elicitation|elicit|sampling/createMessage` across `apps/zcode-cli/packages/adapters/src/mcp` and `core/src/mcp` return zero hits. The MCP adapter implements tools only. "Elicitation" upstream is the internal AskUserQuestion channel, which the proxy already surfaces as structured questions. |
| Hooks inventory | No hook enumeration method exists on the app-server (the only hook method is `workspace/hooks/trustGrant`, `shared/zp/index.ts:3601`; greps for `listHooks|hooks/list` return zero hits). `customization.list kind:"hook"` therefore reports `proxy_unsupported` with `SOURCE_NOT_ENUMERABLE`. Hook RUNS still surface as transcript activities. The proxy never executes a hook. |
| MCP tool-level detail | `mcp/list` returns statuses + `toolCount` only; no protocol method returns a server's tool list (`McpPort.listTools` is in-process only, `mcp.port.ts:308`). |
| `session.create.forkBoundaries` (capability) | Fork boundaries are resolved live from the conversation projection at fork time; the create-time boundary list has no upstream source. |
| Model marketplace beyond observed snapshots | 0.16.9 deliberately keeps the provider registry out of read/setModel snapshots (`session-mapper.ts:215` comment); `catalog.list` before any session therefore shows only the presentation-backed approval mode, and model choices grow from real runtime snapshots. The proxy does not parse `~/.zcode/cli/config.json` to invent a marketplace. |

## Session close semantics (0.16.9)

Inner `session/close` tears the runtime down and drops in-memory event state;
it does not delete history. v4 `deleteSession` is the same close under a
different name. Gian `session.close` is detach only: unsubscribe, drop adapter
state, release ownership — provider history stays visible via
`session.native.list` + `session/resume` adoption.

## Known limitations

- Configuration now uses complete `ModelSelection` values, including
  `options.reasoningLevel`, in both `session/setModel` and `session/send`.
  The supported modes are build/edit/plan/yolo; the old `auto` choice is not
  advertised. Failed updates restore the previous complete selection.
- The extracted Runtime protocol probe must pass both model metadata and
  presentation requests before publication. Historical real-provider evidence
  is not a qualification of this source-built candidate.
- Official MCP auth (`interaction/requestOfficialMcpAuthHeaders`) is answered
  with a structured `official_auth_unavailable`; ZCode degrades gracefully.
- `interaction/requestProviderRuntimeHeaders` and the browser-control reverse
  requests (`interaction/browserList` / `browserExecute`) fail closed: Gian
  does not supply provider headers or drive a browser over this surface.
- Steer text is limited by the upstream 200 KB guide input cap
  (`core/src/runtime/helpers/steering.ts:11`).
- After an app-server restart, upstream discards queued steer inputs by
  design (`fault.command.inputDiscardedOnRestart`); the proxy surfaces the
  interrupted turn honestly rather than replaying lost guides.
- Streaming delta batching at the protocol edge reuses the first delta's
  identity (`server-operations.ts` delta batching); replay identity is stable
  for tool/message facts, not for individual delta chunk boundaries.
- Desktop authorization is not imported. Users configure the ZCode provider
  account; Gian never reads Desktop private OAuth services.

## Verification

- `pnpm -F @gian/zcode-proxy build && pnpm -F @gian/zcode-proxy test` —
  deterministic suite against the scriptable fake app-server, covering every
  row of the capability map above, live/replay identity, Registry catalog
  safety, restart recovery, and response-barrier ordering.
- `pnpm -F @gian/zcode-proxy test:real-app-server` — EXPLICIT canary against a
  real standalone runtime (synthetic config, no model traffic). It skips with
  an explicit note when only the installed ZCode.app bundle is present
  (missing `provider/zcode-builtin.json`; the bundle is never modified).
