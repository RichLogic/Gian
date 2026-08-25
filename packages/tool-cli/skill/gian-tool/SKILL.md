---
name: gian-tool
description: Operate the local Gian Host through gianctl to inspect or manage Gian Tasks, Sessions, deliveries, and pending interactions. Use when the user explicitly asks to delegate work to Gian, check Gian progress, continue a Gian Session, or answer a Gian approval or question.
---

# Gian Tool

Use `gianctl` as a structured local API client. Treat its stdout as one JSON
object. Never scrape Gian's Web UI, edit its SQLite database, or call Provider
CLIs directly for work owned by a Gian Session.

This skill is an external control surface. Do not install or inject it into
Sessions created by Gian itself; that would create recursive delegation.

## Workflow

1. Run `gianctl ping`. If it fails, report that the local Gian Host is not
   available. Do not start, restart, or kill Gian automatically.
2. Before creating a Session, call `catalog.get_create_options`. Use only the
   returned Workspace `id`, Agent `id`, model, mode, and dynamic config values.
   Pass those IDs as `workspace_id` and `agent_id`; never guess them from
   display labels.
3. Read existing state before mutating it. Prefer `task.list`, `task.get`,
   `session.list`, `session.get`, and `session.read` over duplicate creation.
4. Give every mutation a stable idempotency key. Reuse the same key only when
   retrying the exact same method and params. A useful shape is
   `<goal-id>:<operation>:<sequence>`.
5. Save the `delivery_id` returned by `session.send`. Use it with
   `gianctl wait --session <id> --delivery <id>`. A queued outcome is durable;
   wait again later instead of sending the same message with a new key.
6. When wait reports `needs_interaction`, show the user the advertised choices
   and risks. Send only an advertised decision, native option, and answer.
   Never choose a consequential approval on the user's behalf.
7. On timeout, inspect `session.get` and resume waiting. Do not infer failure
   from a bounded wait timeout.

## Commands

Read calls do not use an idempotency key:

```sh
gianctl call catalog.get_create_options --json '{"refresh":false}'
gianctl call session.get --json '{"session_id":"<session-id>"}'
gianctl call session.read --json '{"session_id":"<session-id>","turns":3,"view":"messages"}'
```

All mutations require `--idempotency-key`:

```sh
gianctl call session.create \
  --idempotency-key '<goal>:create-session:1' \
  --json '{"workspace_id":"<workspace-id>","agent_id":"<agent-id>"}'

gianctl call session.send \
  --idempotency-key '<goal>:send:1' \
  --json '{"session_id":"<session-id>","text":"<message>","busy":"queue"}'

gianctl wait --session '<session-id>' --delivery '<delivery-id>' --timeout 30000
```

Use `busy:"queue"` unless the user explicitly needs a failure or the cataloged
Agent supports and the task calls for steering the current Turn. Cancel only a
queued delivery created by the same caller.

## Error Handling

- `IDEMPOTENCY_CONFLICT`: do not retry with changed params; mint a new key for
  a genuinely new action.
- `SESSION_BUSY`: inspect the Session, then queue or wait.
- `AGENT_NOT_READY` or `EXECUTOR_NOT_READY`: report the unavailable Agent and
  let the user repair it in Gian.
- `INTERACTION_ALREADY_RESOLVED`: refresh `interaction.list`; another control
  surface already answered it.
- `TIMEOUT`: inspect and wait again. It is not a terminal Session result.
- `INTERNAL_ERROR`: report the sanitized message and avoid blind mutation
  retries unless the original idempotency key is preserved.
