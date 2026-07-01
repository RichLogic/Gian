-- 030_sessions_tty_turn_seq.sql — Persistent per-session TTY turn ordinal.
--
-- The gian-task action protocol derives a TTY turn's idempotency key from a
-- monotonic per-session ordinal (proposal §4A.A ③). Keeping that ordinal only
-- in memory (TtyManager) meant it reset to 0 on host restart / TTY re-claim, so
-- a post-restart turn could collide with a pre-restart action of the same
-- ordinal + identical text and be wrongly deduped. Persisting it here makes the
-- key stable across restarts.
--
-- Additive, NOT NULL DEFAULT 0: existing rows start at 0; `SELECT *` carries the
-- column out but no shared type references it (host-internal counter).

ALTER TABLE sessions ADD COLUMN tty_turn_seq INTEGER NOT NULL DEFAULT 0;
