-- migration:no-transaction
-- Add executor-native configuration and make the legacy Gian approval mode
-- nullable. Claude/Codex keep their behavior-compatible legacy values during
-- the incremental migration; Kimi rows use NULL and persist exact ACP option
-- IDs/values in executor_config_json.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_native_unique;

CREATE TABLE sessions_new (
  id                    TEXT PRIMARY KEY,
  name                  TEXT,
  type                  TEXT NOT NULL DEFAULT 'coding',
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  executor              TEXT NOT NULL,
  model                 TEXT,
  approval_mode         TEXT,
  executor_config_json  TEXT NOT NULL DEFAULT '{"schemaVersion":1,"values":{}}',
  turns                 INTEGER NOT NULL DEFAULT 1,
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
  runtime_mode          TEXT NOT NULL DEFAULT 'structured',
  unread                INTEGER NOT NULL DEFAULT 0,
  task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  summary               TEXT,
  completed_at          TEXT,
  tty_turn_seq          INTEGER NOT NULL DEFAULT 0,
  service_tier          TEXT
);

INSERT INTO sessions_new (
  id, name, type, workspace_id, executor, model, approval_mode,
  executor_config_json, turns, active_channel, status, archived,
  created_at, updated_at, worktree_path, branch, base_branch,
  worktree_outcome, thinking_effort, native_session_id, last_accessed_at,
  runtime_mode, unread, task_id, summary, completed_at, tty_turn_seq,
  service_tier
)
SELECT
  id, name, type, workspace_id, executor, model, approval_mode,
  CASE
    WHEN executor = 'claude' AND approval_mode = 'plan' THEN
      '{"schemaVersion":1,"values":{"permissionMode":"plan"}}'
    WHEN executor = 'claude' AND approval_mode = 'auto' THEN
      '{"schemaVersion":1,"values":{"permissionMode":"auto"}}'
    WHEN executor = 'claude' THEN
      '{"schemaVersion":1,"values":{"permissionMode":"default"}}'
    WHEN executor = 'codex' AND approval_mode = 'plan' THEN
      '{"schemaVersion":1,"values":{"sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","collaborationMode":"plan"}}'
    WHEN executor = 'codex' AND approval_mode = 'auto' THEN
      '{"schemaVersion":1,"values":{"sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"auto_review"}}'
    WHEN executor = 'codex' AND approval_mode = 'full-access' THEN
      '{"schemaVersion":1,"values":{"sandbox":"danger-full-access","approvalPolicy":"never","approvalsReviewer":"auto_review"}}'
    WHEN executor = 'codex' THEN
      '{"schemaVersion":1,"values":{"sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"user"}}'
    ELSE '{"schemaVersion":1,"values":{}}'
  END,
  turns, active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome, thinking_effort,
  native_session_id, last_accessed_at, runtime_mode, unread, task_id,
  summary, completed_at, tty_turn_seq, service_tier
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
