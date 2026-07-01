-- 029_task_pinned.sql
-- Adds a nullable `pinned_at` timestamp to tasks. NULL = not pinned. Pinned
-- tasks sort above the rest in the Tasks list, most-recently-pinned first
-- (pinned_at DESC); non-pinned tasks fall back to created_at DESC. Set/cleared
-- via the `task:update { pinned }` path (TaskManager.setTaskPinned), which does
-- NOT bump updated_at (pin is view metadata, not a content edit).

ALTER TABLE tasks ADD COLUMN pinned_at TEXT;
