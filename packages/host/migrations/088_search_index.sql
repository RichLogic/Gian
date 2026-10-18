-- Derived search documents and a durable dirty queue.
-- FTS5 is probed at runtime. This migration does not create a virtual table,
-- so a trigram failure cannot block schema upgrade. Triggers only enqueue.

CREATE TABLE search_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  index_revision INTEGER NOT NULL,
  backfill_stage TEXT NOT NULL,
  backfill_cursor TEXT,
  backfill_complete INTEGER NOT NULL CHECK (backfill_complete IN (0, 1)),
  fts_mode TEXT NOT NULL,
  -- 1 while documents still need to be copied into the trigram table.
  -- Query mode stays unavailable until that copy finishes.
  fts_rebuild INTEGER NOT NULL DEFAULT 0 CHECK (fts_rebuild IN (0, 1)),
  fts_cursor TEXT,
  last_error TEXT,
  agent_marker TEXT
);

INSERT INTO search_state (
  id, schema_version, index_revision, backfill_stage, backfill_cursor,
  backfill_complete, fts_mode, fts_rebuild, fts_cursor, last_error, agent_marker
) VALUES (1, 1, 0, 'workspace', NULL, 0, 'unknown', 0, NULL, NULL, NULL);

CREATE TABLE search_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  owner_id TEXT,
  workspace_id TEXT,
  group_key TEXT,
  source_revision TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  search_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  anchor_json TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  sort_turn INTEGER,
  sort_pos INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX search_documents_scan ON search_documents (archived, updated_at DESC, id);
CREATE INDEX search_documents_title ON search_documents (normalized_title, updated_at DESC, id);
CREATE INDEX search_documents_owner ON search_documents (owner_id, kind);
CREATE INDEX search_documents_group ON search_documents (group_key);
CREATE INDEX search_documents_kind_sort ON search_documents (owner_id, kind, sort_turn, sort_pos, id);

CREATE TABLE search_dirty (
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  -- Resume point for a paged session/workspace/task fanout. NULL starts over.
  cursor TEXT,
  PRIMARY KEY (kind, source_key)
);

CREATE TRIGGER search_events_insert AFTER INSERT ON events
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('turn', NEW.turn_id);
END;

CREATE TRIGGER search_events_update AFTER UPDATE ON events
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('turn', NEW.turn_id);
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('turn', OLD.turn_id);
END;

CREATE TRIGGER search_events_delete AFTER DELETE ON events
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('turn', OLD.turn_id);
END;

CREATE TRIGGER search_sessions_insert AFTER INSERT ON sessions
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('session', NEW.id);
END;

-- Access, unread, status, and usage updates are not search input.
CREATE TRIGGER search_sessions_update AFTER UPDATE ON sessions
WHEN OLD.name IS NOT NEW.name
  OR OLD.archived IS NOT NEW.archived
  OR OLD.hidden IS NOT NEW.hidden
  OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.branch IS NOT NEW.branch
  OR OLD.base_branch IS NOT NEW.base_branch
  OR OLD.worktree_path IS NOT NEW.worktree_path
  OR OLD.detected_worktree_path IS NOT NEW.detected_worktree_path
BEGIN
  INSERT INTO search_dirty (kind, source_key, cursor) VALUES ('session', NEW.id, NULL)
  ON CONFLICT(kind, source_key) DO UPDATE SET cursor = NULL;
END;

CREATE TRIGGER search_sessions_delete AFTER DELETE ON sessions
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('session', OLD.id);
END;

CREATE TRIGGER search_workspaces_insert AFTER INSERT ON workspaces
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('workspace', NEW.id);
END;

CREATE TRIGGER search_workspaces_update AFTER UPDATE ON workspaces
WHEN OLD.name IS NOT NEW.name
  OR OLD.path IS NOT NEW.path
  OR OLD.hidden IS NOT NEW.hidden
BEGIN
  INSERT INTO search_dirty (kind, source_key, cursor) VALUES ('workspace', NEW.id, NULL)
  ON CONFLICT(kind, source_key) DO UPDATE SET cursor = NULL;
END;

CREATE TRIGGER search_workspaces_delete AFTER DELETE ON workspaces
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('workspace', OLD.id);
END;

CREATE TRIGGER search_tasks_insert AFTER INSERT ON tasks
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('task', NEW.id);
END;

CREATE TRIGGER search_tasks_update AFTER UPDATE ON tasks
WHEN OLD.name IS NOT NEW.name
  OR OLD.description IS NOT NEW.description
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO search_dirty (kind, source_key, cursor) VALUES ('task', NEW.id, NULL)
  ON CONFLICT(kind, source_key) DO UPDATE SET cursor = NULL;
END;

CREATE TRIGGER search_tasks_delete AFTER DELETE ON tasks
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('task', OLD.id);
END;

CREATE TRIGGER search_schedules_insert AFTER INSERT ON schedules
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('schedule', NEW.id);
END;

CREATE TRIGGER search_schedules_update AFTER UPDATE ON schedules
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('schedule', NEW.id);
END;

CREATE TRIGGER search_schedules_delete AFTER DELETE ON schedules
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('schedule', OLD.id);
END;

CREATE TRIGGER search_inbox_insert AFTER INSERT ON inbox_items
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('inbox', NEW.id);
END;

CREATE TRIGGER search_inbox_update AFTER UPDATE ON inbox_items
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('inbox', NEW.id);
END;

CREATE TRIGGER search_inbox_delete AFTER DELETE ON inbox_items
BEGIN
  INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES ('inbox', OLD.id);
END;
