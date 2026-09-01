# WP0 raw probe captures

Redacted-at-write NDJSON captures from the WP0 probes (`probes/wp0/`).
All sessions were created in throwaway HOMEs/workspaces (`mkdtemp`); no real
model calls, no credentials, and no `~/.zcode` writes. NOTE (deterministic
closure): the historical WP0 isolation helper DID read the machine's real
`~/.zcode/cli/config.json` to copy model/provider metadata (with the apiKey
replaced) into the isolated copy; committed evidence contains no secret value,
and the probe helper has since been rewritten to build a fully synthetic
config without reading the real one.

`g6-replay.ndjson` is a STATEFUL capture, not read-only: it covers
session/resume (which may persist a session.resumed event) plus
read/events/messages of probe-owned sessions only (workspace-asserted
`/tmp/...`). Re-running it requires WP0_ALLOW_STATEFUL_PROBES=1 (fail closed
otherwise). User-session listing captures were reviewed and deleted, never
committed.
