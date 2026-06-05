-- migration:no-transaction
-- Remove the static CHECK list from sessions.thinking_effort. Claude Code
-- reports supported effort levels at runtime, so the database should not
-- bake a stale Gian-side enum into persisted sessions.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_native_unique;

CREATE TABLE sessions_new (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  type              TEXT NOT NULL DEFAULT 'coding',
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  executor          TEXT NOT NULL,
  model             TEXT,
  approval_mode     TEXT NOT NULL DEFAULT 'auto',
  turns             INTEGER NOT NULL DEFAULT 1,
  active_channel    TEXT DEFAULT 'web',
  status            TEXT NOT NULL DEFAULT 'new',
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  worktree_path     TEXT,
  branch            TEXT,
  base_branch       TEXT,
  worktree_outcome  TEXT
    CHECK (worktree_outcome IS NULL OR worktree_outcome IN ('merged', 'discarded')),
  thinking_effort   TEXT,
  native_session_id TEXT NOT NULL,
  last_accessed_at  TEXT,
  runtime_mode      TEXT NOT NULL DEFAULT 'structured'
);

INSERT INTO sessions_new (
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id, last_accessed_at, runtime_mode
)
SELECT
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id, last_accessed_at, runtime_mode
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_status    ON sessions(status);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated   ON sessions(updated_at DESC);

CREATE UNIQUE INDEX idx_sessions_native_unique
  ON sessions(executor, native_session_id);

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
