-- 025_tasks.sql — Task abstraction layer (PRD-v3 / PRD-v3-implementation-plan.md P0).
--
-- A Task is a lightweight container for "one thing the user is doing", spanning
-- multiple Subtasks. It does NOT bind a workspace; workspace membership is
-- decided by its Subtasks. Subtasks and the per-Task Manager are both sessions:
-- a session with a non-null task_id and type='subtask' is a Subtask, type='manager'
-- is the Task's read-only Codex manager.

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'done' | 'archived'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link sessions to their Task. Nullable (null = scattered / standalone session).
-- ON DELETE SET NULL: deleting a Task orphans its sessions into the scattered
-- pool rather than blocking the delete.
ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
