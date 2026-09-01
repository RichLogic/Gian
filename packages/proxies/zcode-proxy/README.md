# com.zhipu.zcode — ZCode Proxy (Gian Plugin)

Shared-scope Gian Proxy speaking **`gian.proxy/2.1`** outward and **ZCode
Protocol v1** (the NDJSON protocol of `zcode.cjs app-server`) inward. Owner of
all ZCode-specific vocabulary: no ZCode method names, permission words, or
bundle types leak into Host/Web.

## Status: shipping

ZCode Proxy 0.1.0 is part of the default shipping set. WP7 passed real
GLM-5.3-Flash text, reasoning, tool, 25-second permission, interrupt,
same-workspace concurrency, native discovery, detach/reattach, and Replay
identity canaries.

## Verified runtime scope

- **Exactly ZCode `0.16.5`** (`runtime.verifiedCliVersions: ["0.16.5"]`).
  Other versions are unverified; the runtime fingerprint (whole `glm` closure)
  must match, otherwise the generation retires.
- ZCode ships only inside ZCode.app. Gian does **not** download, install,
  mirror, upgrade, or downgrade it. Discovery: `agents.json` cliPath →
  `ZCODE_BIN` → `/Applications/ZCode.app/.../zcode.cjs` →
  `~/Applications/ZCode.app/.../zcode.cjs`.
- The outer Proxy is shared, while inner app-servers are pooled by canonical
  workspace cwd and launched as `app-server --stdio --surface desktop`.
  Process failure in one workspace does not terminate another workspace.

## Prerequisites the user must satisfy themselves

- The ZCode CLI needs its own model-provider config at
  `~/.zcode/cli/config.json`. When it is missing, the Agent reports
  readiness `invalid` with a repairable issue pointing at that file.
- **Gian never creates or modifies anything under `~/.zcode`.** The evidence
  proves only the missing-config failure path; no repair command is claimed.

## Capability notes (as of this revision)

- Declared: `catalog.resolve`, `session.native.list`, `session.replay`,
  `interaction`, `event.reasoning`, `event.usage` (plus core). Catalog comes
  from the side-effect-free `workspace/readState`; the bootstrap catalog only
  covers the unconfigured vocabulary.
- **Not declared**: `input.localImage`, `input.localFile`, `session.rename`,
  `session.native.delete`, `session.fork`,
  `sidechat`, `turn.steer`, `integration.mcp.*` (frozen D10).
- Tools map to `activity.updated` only — no synthetic Step/Request events.

Permission interactions are enabled by default. The adapter coalesces ZCode's
repeated reverse requests by native request id, preserves the exact native
action payload, and has passed a 25-second delayed-response canary.

## Session close semantics (WP0 G7)

Inner `session/close` **destroys empty native sessions** and merely unloads
sessions that carry history. Gian therefore implements Outer `session.close`
as detach only: unsubscribe, drop adapter state, release ownership — it never
calls inner close, and provider history is never deleted on Gian's behalf
(no native delete exists in the protocol surface).

## Known limitations

- Official MCP auth (`interaction/requestOfficialMcpAuthHeaders`) is answered
  with a structured `official_auth_unavailable`; ZCode degrades gracefully.
- File and image inputs are not advertised in 0.1.0. The public Protocol/1
  `session/send` surface used here accepts text; Gian rejects attachments
  before a turn instead of dropping them silently.
- `interaction/requestUserInput` is not exposed by this verified runtime
  surface. Unknown reverse methods fail closed.
- Desktop authorization is not imported. Users configure the separate ZCode
  CLI provider account; Gian never reads Desktop private OAuth services.
