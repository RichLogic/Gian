---
name: gian-session
description: Use the Gian MCP exposed to this Gian-managed Session for child delegation, delivery waiting, interactions, idempotent control operations, and Gian-managed worktree workflows. Use only when the gian MCP server is present.
---

# Gian Session

Use the `gian` MCP server for Gian-owned Task, Session, delivery, interaction,
and worktree workflows. The Host derives identity, role, Task membership, and
target authority from the injected credential. Never discover, print, persist,
or pass that credential as a Tool argument.

## Delegation

1. Read canonical Task and Session state before creating work.
2. Create only the child Session needed for the current goal.
3. Give every mutation a stable idempotency key. Reuse it only when retrying
   the exact same method and parameters.
4. Save the returned delivery id and wait on that delivery. A bounded timeout
   is not a terminal result; inspect state and wait again.
5. Respond only to an interaction exposed by `interaction.list`, using exactly
   the advertised action, native option, and input fields.

Ownership is direct, not transitive. A standard Session may control only the
children it created. An administrator still cannot list, approve, stop,
archive, rename, or otherwise control itself.

## Worktrees

Call `worktree.create_and_bind` instead of invoking `git worktree add`. Pass a
new local `branch` and, when needed, a `base_ref`; never pass a Session id or
target path. Gian chooses the managed root and opens the checkout in the
Session's breadcrumb, Files, Diffs, and History views.

The Tool returns the absolute checkout path. Use that path explicitly as the
working directory for subsequent file and command operations that should land
in the new checkout. The Agent runtime cwd and Workbench Terminal do not move.
If the Tool is absent or unavailable and direct `git worktree add` is truly
necessary, Gian will ask the user whether to adopt the detected checkout after
the Turn finishes.

## Boundaries

- Do not invoke `gianctl` from a Gian-managed Session.
- Do not scrape Gian's Web UI or edit its SQLite database.
- Do not call Provider CLIs to control another Gian Session.
- Do not guess another Session id to bypass Tool ownership.
- Stop on `PERMISSION_DENIED`; do not route around the Host policy.
- On `IDEMPOTENCY_CONFLICT`, inspect the original request before taking any
  further write action.

If the `gian` MCP server is absent or unhealthy, report that Gian integration
is unavailable. Do not install a global MCP server or edit Provider user
configuration from inside the Session.
