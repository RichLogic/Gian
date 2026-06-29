-- 027_session_completed.sql — Subtask user-completion flag, separate from turn status.
--
-- A Subtask IS a Session. Until now the "is this subtask done" state and the
-- turn lifecycle BOTH lived on `sessions.status` ('done'), so finishing a single
-- turn auto-marked the subtask complete. This column splits them: `status` is
-- purely the turn lifecycle (new/running/pending/done/error); `completed_at`
-- (nullable ISO) is the USER's explicit "this subtask is complete" flag.
--
-- Migration decision (spec 2026-06-28, Codex review #6): existing `status='done'`
-- subtasks cannot be distinguished between "turn finished" and "user completed",
-- so we do NOT back-fill — every row starts completed_at = NULL (not completed).
-- Users re-mark the genuinely-finished ones.
--
-- Nullable + additive: `SELECT *` carries the column out (Session.completed_at).

ALTER TABLE sessions ADD COLUMN completed_at TEXT;
