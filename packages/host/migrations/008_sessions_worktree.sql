-- Worktree mode for sessions. A session in worktree mode runs the AI
-- on a dedicated branch in an isolated working directory, so the user's
-- main checkout stays clean and multiple sessions can run in parallel.
--
-- Inference rule: a session is "worktree mode" iff branch IS NOT NULL.
-- worktree_path goes null after merge/drop (the directory is removed)
-- but branch / base_branch / worktree_outcome stick around for history.

ALTER TABLE sessions ADD COLUMN worktree_path    TEXT;
ALTER TABLE sessions ADD COLUMN branch           TEXT;
ALTER TABLE sessions ADD COLUMN base_branch      TEXT;
ALTER TABLE sessions ADD COLUMN worktree_outcome TEXT
  CHECK (worktree_outcome IS NULL OR worktree_outcome IN ('merged', 'discarded'));

UPDATE config SET value = '8' WHERE key = 'schema_version';
