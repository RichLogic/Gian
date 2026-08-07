-- migration:no-transaction
-- Make sessions.workspace_id nullable with ON DELETE SET NULL so deleting a
-- workspace always succeeds: its sessions lose their affiliation and surface
-- in the Sessions rail's 无归属 (Unfiled) group instead of blocking the
-- delete with 409 "workspace has associated sessions".

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_native_unique;

CREATE TABLE sessions_new (
  id                    TEXT PRIMARY KEY,
  name                  TEXT,
  type                  TEXT NOT NULL DEFAULT 'coding',
  workspace_id          TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  executor              TEXT NOT NULL,
  model                 TEXT,
  approval_mode         TEXT,
  executor_config_json  TEXT NOT NULL DEFAULT '{"schemaVersion":1,"values":{}}',
  active_channel        TEXT DEFAULT 'web',
  status                TEXT NOT NULL DEFAULT 'new',
  archived              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  worktree_path         TEXT,
  branch                TEXT,
  base_branch           TEXT,
  worktree_outcome      TEXT
    CHECK (worktree_outcome IS NULL OR worktree_outcome IN ('merged', 'discarded')),
  thinking_effort       TEXT,
  native_session_id     TEXT NOT NULL,
  last_accessed_at      TEXT,
  unread                INTEGER NOT NULL DEFAULT 0,
  task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  summary               TEXT,
  completed_at          TEXT,
  service_tier          TEXT,
  context_tokens_used   INTEGER,
  context_window_tokens INTEGER,
  context_usage_updated_at TEXT,
  conversation_input_tokens INTEGER,
  conversation_output_tokens INTEGER,
  conversation_cached_input_tokens INTEGER,
  conversation_total_tokens INTEGER,
  conversation_usage_complete INTEGER NOT NULL DEFAULT 0,
  fork_from_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  detected_worktree_path TEXT,
  pinned_at             TEXT
);

INSERT INTO sessions_new (
  id, name, type, workspace_id, executor, model, approval_mode,
  executor_config_json, active_channel, status, archived, created_at,
  updated_at, worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id, last_accessed_at, unread, task_id,
  summary, completed_at, service_tier, context_tokens_used,
  context_window_tokens, context_usage_updated_at, conversation_input_tokens,
  conversation_output_tokens, conversation_cached_input_tokens,
  conversation_total_tokens, conversation_usage_complete,
  fork_from_session_id, detected_worktree_path, pinned_at
)
SELECT
  id, name, type, workspace_id, executor, model, approval_mode,
  executor_config_json, active_channel, status, archived, created_at,
  updated_at, worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id, last_accessed_at, unread, task_id,
  summary, completed_at, service_tier, context_tokens_used,
  context_window_tokens, context_usage_updated_at, conversation_input_tokens,
  conversation_output_tokens, conversation_cached_input_tokens,
  conversation_total_tokens, conversation_usage_complete,
  fork_from_session_id, detected_worktree_path, pinned_at
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
