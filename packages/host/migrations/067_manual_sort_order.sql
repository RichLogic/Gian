-- Manual sidebar ordering (2026-08-29). NULL = automatic order (the
-- pre-existing created_at/updated_at-based sort); a non-NULL value is the
-- user's explicit drag position within the scope:
--   tasks.sort_order      — position among Tasks (the web lists open and done
--                           groups separately; values are only ever compared
--                           within one status group)
--   sessions.workspace_order — position within its workspace group (or the
--                           NULL-workspace "unfiled" group) in the Sessions rail
--   sessions.task_order   — position within its Task in the Tasks rail
-- Reorder endpoints rewrite a scope's values to a dense 1..n sequence; rows
-- never touched by a drag keep NULL and sort ABOVE the manual range by their
-- automatic key, so upgrading changes nothing until the first drag.
ALTER TABLE tasks ADD COLUMN sort_order INTEGER;
ALTER TABLE sessions ADD COLUMN workspace_order INTEGER;
ALTER TABLE sessions ADD COLUMN task_order INTEGER;
