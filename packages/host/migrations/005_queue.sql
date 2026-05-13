CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_queue_entries_session ON queue_entries(session_id, sort_order);

UPDATE config SET value = '5' WHERE key = 'schema_version';
