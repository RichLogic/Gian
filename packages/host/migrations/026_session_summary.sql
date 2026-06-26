-- 026_session_summary.sql — Subtask-level summary (PRD-v3 / implementation-plan P4).
--
-- The summarizer (`.ai/` write-back) records a short, user-editable summary on
-- the Subtask session when it completes. The per-Task Manager inlines this into
-- its system prompt (see task/manager-session.ts buildManagerSystemPrompt) so it
-- can reason about what each Subtask achieved without reading full transcripts.
--
-- Nullable + additive: every existing session keeps summary = NULL; `SELECT *`
-- carries the column out automatically (Session.summary in @gian/shared).

ALTER TABLE sessions ADD COLUMN summary TEXT;
