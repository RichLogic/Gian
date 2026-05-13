CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

UPDATE config SET value = '4' WHERE key = 'schema_version';
