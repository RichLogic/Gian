# @gian/dsh-proxy

`ai.deepseek.harness` — shared-scope Gian Proxy speaking `gian.proxy/2.1`
(JSON-RPC 2.0 / NDJSON / stdio) and supervising one shared DSH Host that runs
the `gian` profile with `@gian/dsh-bridge`.

## Layout

- `manifest.json` — Manifest v2 (`id: ai.deepseek.harness`, `process.scope:
  shared`, protocol range `>=2.0 <3.0`).
- `src/core/service.ts` — session/turn projection, stable `sourceTurnId` /
  `stepId` / `eventId` identity, terminal-state enforcement.
- `src/protocol/v2-adapter.ts` — `gian.proxy/2.1` dispatcher and capability
  narrowing.
- `src/runtime/bridge-client.ts` — bridge/1.0 JSON-RPC client + DSH child
  supervisor.
- `src/cli/spawn.ts` — stdio entry.

## Test

```sh
pnpm -F @gian/dsh-proxy test
```

The suite runs the complete `gian.proxy/2.1` contract through
`@gian/proxy-protocol`'s `HostProtocolValidator` against a fake bridge runtime:
initialize identity, capabilities (including `event.step`/`event.request`),
catalog, session create/idempotency, turn lifecycle, step/request/usage
projection, and hostServices fail-closed — zero model calls.
