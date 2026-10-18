-- Allow the schedule.confirmation Inbox source. SQLite cannot alter a CHECK,
-- so the table is rebuilt in place. Existing rows are copied unchanged.
-- Dropping the table drops the search triggers; they are recreated so a
-- schedule confirmation row still dirties the generic inbox anchor
-- { inbox_id, generation }. No new search target is added.
CREATE TABLE inbox_items_new (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'session.question', 'session.approval', 'system.repair', 'system.pairing',
    'product.update', 'schedule.confirmation'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'resolved', 'rejected', 'cancelled', 'expired'
  )),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  read_at TEXT,
  read_generation INTEGER,
  notified_generation INTEGER,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  candidate_version TEXT,
  candidate_channel TEXT,
  skipped_version TEXT,
  skipped_channel TEXT,
  source_epoch INTEGER CHECK (source_epoch IS NULL OR source_epoch >= 1),
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

INSERT INTO inbox_items_new (
  id, source_key, source_kind, status, generation, revision, read_at,
  read_generation, notified_generation, title, summary, target_json, display_json,
  candidate_version, candidate_channel, skipped_version, skipped_channel,
  source_epoch, tombstone, created_at, updated_at, closed_at
)
SELECT
  id, source_key, source_kind, status, generation, revision, read_at,
  read_generation, notified_generation, title, summary, target_json, display_json,
  candidate_version, candidate_channel, skipped_version, skipped_channel,
  source_epoch, tombstone, created_at, updated_at, closed_at
FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;

CREATE INDEX inbox_items_list ON inbox_items (updated_at DESC, id DESC);
CREATE INDEX inbox_items_pending ON inbox_items (status, updated_at DESC, id DESC);

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

-- Derived Inbox mirror failures. The confirmation row stays canonical.
-- A later read or reconcile retries the op and deletes the row on success.
CREATE TABLE schedule_confirmation_inbox_retries (
  confirmation_id TEXT PRIMARY KEY,
  op TEXT NOT NULL CHECK (op IN ('open', 'close')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('resolved', 'rejected', 'expired')),
  actor TEXT CHECK (actor IS NULL OR actor IN ('user', 'system')),
  detail TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
