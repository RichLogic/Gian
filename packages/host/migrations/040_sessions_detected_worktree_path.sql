-- Records the absolute path of a git worktree the AGENT created itself
-- mid-session (detected from `git worktree add` in command_execution events).
-- NULL until detected, and never set for Gian-owned worktree sessions
-- (sessions.worktree_path IS NOT NULL). View-only: the web auto-switches the
-- diff/files view to this tree; execution cwd stays on the main tree.
ALTER TABLE sessions ADD COLUMN detected_worktree_path TEXT;
