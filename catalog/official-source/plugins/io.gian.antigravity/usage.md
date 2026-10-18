# Models, Thinking And Native Mode

Choose Model, Thinking and Mode from the current Proxy catalog. The available
family/Thinking pairs come only from advertised Gemini native IDs; unsupported
pairs fail before prompting. The Runtime receives the exact native model
variant, not a synthetic Thinking setter. Fixed or unknown model variants
retain their native identity rather than gaining invented levels.

The pinned native Mode contract is `default` (normal permission prompts),
`auto_edit` (auto-approve file edits), and `yolo` (auto-approve all tools).
The default is conservative `default`. Explicit choices are validated against
the live advertisement; Gian does not substitute `ask` or silently choose
`yolo`. Agent defaults apply to new sessions, and an explicit new-session
choice takes precedence. Per-turn values follow the current native catalog.

Legacy defaults containing a full native variant ID remain accepted when a
separate Thinking value is omitted. Conflicting explicit selections are
rejected, not coerced. Older Agent controls may still show the legacy combined
choice; canonical split-display migration is not claimed by this release.

Native approval buttons return the exact option ID advertised for that
request. Rejecting is not an allow operation. A disconnected, cancelled or
uncertain turn is never blindly replayed; inspect its state before continuing.
Closing the local session detaches it and does not claim to delete native
history.

Workspace roots, including Gian's attachment directory, describe context;
they do not grant filesystem permissions or change native Mode. The initial
prompt input is text-only even if the upstream Runtime advertises additional
media capabilities. Context occupancy is reported when available; monetary
usage or billing-token totals are not synthesized.
