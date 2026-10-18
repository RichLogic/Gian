# Installation And Account Setup

Requires Gian 0.6.7 or later. Older Hosts do not fully support creation with
the Proxy's native Mode values; upgrade Gian before using this Proxy.

Install the exact signed Catalog combination for darwin-arm64. The Runtime
must keep `agy_acp_server.par` and `localharness_external` together from the
same pinned official 1.3.0 archive. Gian does not replace this server with a
system `agy` executable. Other managed platforms are not provided by this
release recipe.

The separate official `agy` CLI is required for the cold Gemini model query.
It is a different component from ACP Server 1.3.0. A missing helper is an
unavailable catalog, not an empty model list or permission to guess a model.
The query does not create an ACP session or send a model prompt.

Use the OS account HOME and its default `~/.gemini` configuration for catalog
inspection. A managed/custom HOME or Gemini root is rejected for this query;
the Proxy never copies credentials or silently rewrites the selected HOME.
Runtime files and account configuration are separate locations. Do not use
the nested `antigravity-acp` directory as the Gemini root.

Sign in through the official ACP authentication flow when needed. This is an
explicit user action and may open a browser. Runtime discovery and version
probing do not authenticate. Existing ACP credentials may be reused, but
separate CLI credentials are not copied into ACP. On macOS, changing a
filesystem HOME does not by itself isolate Keychain state.

Never paste account tokens, OAuth callback URLs or credential files into a
conversation or diagnostic report.
