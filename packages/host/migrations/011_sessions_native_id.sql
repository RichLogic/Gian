-- Add native_session_id linkage to sessions table for the "Adopt native
-- session" feature (Spaces view → Native Sessions tab).
--
-- When a Gian session is created from an existing claude / codex on-disk
-- session, this column stores that native session UUID. The cc-proxy /
-- codex-proxy then use it as the resume id (--resume <id> for cc,
-- thread/resume <id> for codex), so the same .jsonl on disk is the
-- bidirectional source of truth — the user can switch to the raw CLI and
-- back at any time.
--
-- Enforce 1:1 binding per executor: at most one Gian session may adopt a
-- given native session at a time. Allows multiple NULLs (most Gian sessions
-- are not adopted from native).

ALTER TABLE sessions ADD COLUMN native_session_id TEXT;

CREATE UNIQUE INDEX idx_sessions_native_unique
  ON sessions(executor, native_session_id)
  WHERE native_session_id IS NOT NULL;
