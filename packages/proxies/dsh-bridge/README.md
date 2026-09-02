# @gian/dsh-bridge

Gian-managed Cordis bundle that speaks `gian.dsh.bridge/1.0` inside a DSH
`gian` profile. The bundle is a patch layer applied **after**
`@deepseek-ai/dsh-base`; it does not mount DSH Web, Browser UI, or the headless
one-shot runner, and it keeps stdout exclusively for bridge JSON-RPC.

## Contract

- Schema: `src/schema.ts` (method/notification tables, JSON-RPC envelope).
- Transport: `src/jsonrpc.ts` (UTF-8 NDJSON stdio, no batch, ≤16 MiB lines).
- Server: `src/server.ts` (bridge/1.0 request routing and correlation).
- Real runtime seam: `src/cordis-host.ts`; deterministic fake: `src/fake-host.ts`.

The current production baseline is `@deepseek-ai/dsh@0.1.1-rc.2`. The Bridge
waits for late Provider registration before its first Catalog and projects the
selected Provider, model, and reasoning effort into the Agent's actual request.
Existing Gian-owned Sessions resume through `AgentRegistry.resume` only when
the Proxy and Bridge both validate the Host's per-process binding proof.
Unattested IDs and history adoption fail closed.

## Test

```sh
pnpm -F @gian/dsh-bridge test
```

The contract suite drives two root sessions and an in-process child through the
bridge server with a fake host: event, config, interaction, cancellation, and
independent close — zero model calls.

The separately authorized real-runtime canary is intentionally outside
`test:all`. It boots the installed DSH package with an isolated `gian` profile,
performs no model Turn, and checks Bridge stdout purity plus process cleanup:

```sh
pnpm -F @gian/dsh-bridge build
node scripts/run-dsh-bridge-canary.mjs
```
