-- migration:no-transaction
-- (marker tells the runner to skip its automatic transaction wrap; we
-- toggle pragmas + manage the transaction ourselves below.)
--
-- Migration 012 已删完 native_session_id IS NULL 的行；这里把
-- native_session_id 改成 NOT NULL，并把原来的 partial unique index
-- (WHERE native_session_id IS NOT NULL) 替换为无条件的 UNIQUE。
--
-- SQLite 不支持 ALTER COLUMN，标准做法是 rename → create new → copy →
-- drop old → recreate indexes。但 SQLite 默认在 ALTER TABLE RENAME 时
-- **自动重写其他表的 FOREIGN KEY 引用** 指向新名字 (sessions →
-- sessions_old)。等我们 DROP sessions_old 后，events / turns / queue /
-- approvals 这几张表的 FK 就悬空指向不存在的 sessions_old，后续 INSERT
-- 会以 SQLITE_ERROR 失败。
--
-- 修复：开 legacy_alter_table=1 让 RENAME 不重写其它表的 FK。同时关
-- foreign_keys 避免 DROP sessions_old 时触发 FK 检查（reference is by
-- name, parent rows already migrated to new sessions table by then）。
-- 这俩 PRAGMA 都不能在 transaction 内切换，所以放在 BEGIN 之前。

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_native_unique;

ALTER TABLE sessions RENAME TO sessions_old;

CREATE TABLE sessions (
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
  thinking_effort   TEXT
    CHECK (thinking_effort IS NULL OR thinking_effort IN
      ('off','minimal','low','medium','high','max','xhigh')),
  native_session_id TEXT NOT NULL
);

INSERT INTO sessions (
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id
)
SELECT
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id
FROM sessions_old;

DROP TABLE sessions_old;

CREATE INDEX idx_sessions_status    ON sessions(status);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated   ON sessions(updated_at DESC);

CREATE UNIQUE INDEX idx_sessions_native_unique
  ON sessions(executor, native_session_id);

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
