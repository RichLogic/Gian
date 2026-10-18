# Antigravity

Antigravity Proxy 0.0.1 connects Gian to Google's official Antigravity ACP
Server 1.3.0. The Proxy version and upstream Runtime version are independent.
This is not a wrapper around the separate `agy --print` CLI.

One connection serves an Agent/Runtime binding; upstream manages a separate
local harness for each native session. Only actually advertised Gemini models
are exposed. Gian projects supported native variants into separate Model and
Thinking controls and forwards the exact advertised native model ID. Mode is
also native: the Proxy does not replace it with a Host permission preset.

Text turns, native tool approvals, cancellation, context occupancy and
session detach/resume use the ACP connection. Fork, Side Chat, native history
replay, multimedia input and billing-token totals are not advertised by this
initial integration. Native global MCP configuration can supplement Gian's
per-session MCP descriptors; this is not an isolation guarantee.

This source describes the first release candidate, not a successful
qualification or publication. Installable Proxy/Runtime URLs, digests and
certificate identity must come from actual hosted qualification and the
signed Catalog. No first-publication date or historical artifact hash is
invented here. App/Desktop and authenticated model acceptance are separate.

The logo identifies Google's upstream product. The Proxy is maintained by
Gian, not Google. See the [official ACP setup guide](https://antigravity.google/docs/ide/extensions/zed/).
