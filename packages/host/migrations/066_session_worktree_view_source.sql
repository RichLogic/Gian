ALTER TABLE sessions
  ADD COLUMN detected_worktree_source TEXT
  CHECK (detected_worktree_source IS NULL OR detected_worktree_source IN ('agent', 'gian_tool'));

ALTER TABLE sessions
  ADD COLUMN detected_worktree_revision INTEGER NOT NULL DEFAULT 0
  CHECK (detected_worktree_revision >= 0);
