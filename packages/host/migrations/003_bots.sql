-- M3: rebuild bots table with proper CHECK constraints.
-- The original definition in 001_initial.sql omitted them.
-- SQLite cannot ADD CHECK constraints via ALTER TABLE, so we rebuild.

CREATE TABLE bots_new (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  platform          TEXT NOT NULL CHECK (platform IN ('discord','slack')),
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('read-only','full-control')) DEFAULT 'read-only',
  allowed_user_id   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'disabled',
  last_error        TEXT,
  last_connected_at TEXT,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bots_new SELECT * FROM bots;
DROP TABLE bots;
ALTER TABLE bots_new RENAME TO bots;

UPDATE config SET value = '3' WHERE key = 'schema_version';
