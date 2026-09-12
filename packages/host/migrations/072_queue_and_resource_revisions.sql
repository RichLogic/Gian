ALTER TABLE sessions ADD COLUMN queue_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE proxy_interactions ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE queue_delivery_tombstones (
  queue_entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_request_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_queue_delivery_tombstones_session
  ON queue_delivery_tombstones(session_id, created_at);
