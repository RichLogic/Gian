# @gian/antigravity-proxy

Gian adapter for Google's official Antigravity ACP Server. This is not a
wrapper around the separate `agy --print` CLI.

The Proxy uses `gian.proxy/2.2` or `2.3` toward Host and ACP 1 toward the
official server. One Proxy/ACP connection serves one Agent/Runtime binding;
upstream owns a separate local harness for each native session. Only native
Gemini model choices are offered. Unsupported capabilities are not advertised.

## Runtime

Keep `agy_acp_server.par` and `localharness_external` from the same official
archive together. The Proxy requires an absolute server path and verifies
its companion; it never substitutes a system `agy` executable.

```sh
node dist/src/cli/spawn.js --antigravity-bin /absolute/runtime/agy_acp_server.par
```

The standard `GIAN_RUNTIME_BIN` exact launch binding is also accepted. An
explicit `GIAN_AGENT_HOME` maps to the Gemini root, otherwise `GEMINI_HOME`
and then the official `~/.gemini` default apply. Do not use the nested
`antigravity-acp` directory as the Gemini root.

Existing ACP credentials may be reused. CLI credentials are a different
namespace and are never copied. On macOS, Keychain credentials are not
isolated merely by changing the filesystem HOME.

The installed `agy --output-format json models` query supplies the cold
Gemini catalog only when `HOME` is the OS account home and the effective
Gemini root is that user's default `~/.gemini`. A managed `HOME`,
`GIAN_AGENT_HOME`, or `GEMINI_HOME` is rejected before the CLI starts. The
Proxy does not point the CLI at another account and does not read CLI
credential files. A missing CLI is an unavailable catalog, not an empty one.
The query does not create an ACP session or send a prompt.

Explicit personal login:

```sh
node dist/src/cli/spawn.js --antigravity-bin /absolute/runtime/agy_acp_server.par --authenticate
```

This command invokes the official OAuth flow and may open the system browser.
It is never run by discovery, catalog inspection or the bootstrap probe.
Those checks establish executable/protocol readiness, not successful login.

## Boundaries

- Same-session turns are serialized; separate sessions and pending approvals
  do not block each other.
- Cancellation uses ACP `session/cancel`; uncertain interrupted/crashed turns
  are never blindly resubmitted.
- Local session close detaches rather than claiming native history deletion.
  The shared server can be stopped once no live session depends on it.
- Host HTTP MCP descriptors are passed per session. The official server also
  merges user-global MCP settings; this is not a host-only customization claim.
- Initial input is text-only. Native advertised multimedia capabilities do
  not by themselves enable Gian attachments, Fork, Side Chat or history replay.
- Initial configuration exposes advertised string selects only; typed boolean
  ACP setters are not coerced into strings or offered as working controls.
- ACP 1.3.0 reports context occupancy through `usage_update.used/size`;
  conversation billing-token totals are unavailable and are not synthesized.
- Proxy 0.0.1 is a shipping candidate, not a qualification result. Publication
  requires successful independent hosted qualification and an exact signed
  Catalog combination; the upstream ACP Runtime remains 1.3.0.
  Source-first Dev includes it with the pinned darwin-arm64 Runtime pair.
  `scripts/build-antigravity-runtime.mjs` converts the SHA-bound official ZIP
  into a byte-preserving deterministic tar.gz; Dev preparation bundles the
  verified asset for offline installation. Formal standalone qualification
  stages those actual bytes with their computed digest at the immutable
  RichLogic/Gian-Proxies Proxy release coordinate. No fabricated asset hash,
  certificate or published history is stored in the source Catalog.
  Other Runtime product platforms are not part of this recipe.
- Dev coordinates select the generic Proxy bootstrap version probe, using the
  exact branch/bundled Proxy entry and an isolated configuration directory.
  The upstream version comes from ACP initialize, never an assumed
  `--version` flag. This does not establish authenticated model readiness.

Architecture: `docs/proposals/0.6.7-antigravity-proxy.md` in GianDev.
Task: <https://github.com/RichLogic/Gian-Dev/issues/179>.

## Branding

`assets/logo.png` is the unmodified Antigravity site favicon retrieved from
Google's favicon service on 2026-10-12. It identifies the upstream product;
the Proxy itself is maintained by Gian, not Google.
