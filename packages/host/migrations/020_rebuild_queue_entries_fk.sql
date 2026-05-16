-- migration:no-transaction
-- (toggle foreign_keys pragma; cannot be changed inside a transaction.)
--
-- 014 rebuilt turns / events / queue / approvals to repair FKs broken by
-- the earlier 013 rename, but missed queue_entries — the table actually
-- used by the runtime queue (added in 005; the legacy `queue` table from
-- 001 is unused). On DBs that went through the broken 013, the FK in
-- queue_entries.session_id still points at sessions_old, which has since
-- been dropped. Any INSERT fails with `no such table: main.sessions_old`,
-- so message enqueue (and therefore most session activity) is dead.
--
-- This rebuilds queue_entries so its FK points at sessions(id) again.
-- Idempotent — on a fresh DB the result is identical to 005's schema.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE queue_entries_new (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
INSERT INTO queue_entries_new (id, session_id, text, sort_order, created_at)
SELECT id, session_id, text, sort_order, created_at FROM queue_entries;
DROP TABLE queue_entries;
ALTER TABLE queue_entries_new RENAME TO queue_entries;
CREATE INDEX idx_queue_entries_session ON queue_entries(session_id, sort_order);

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
