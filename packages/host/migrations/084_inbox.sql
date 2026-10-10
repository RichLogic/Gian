-- Host-local Inbox. Source rows can be rebuilt; read state and business
-- terminal state stay here. No provider payload column.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'session.question', 'session.approval', 'system.repair', 'system.pairing', 'product.update'
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
  -- Latest product.update epoch this Host has seen, including an epoch that
  -- did not change the public candidate. Null on every other source kind.
  source_epoch INTEGER CHECK (source_epoch IS NULL OR source_epoch >= 1),
  -- 1: this generation's display is an unfilled safe tombstone.
  -- Cleared when that generation's open is applied. Not derived from title text.
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX inbox_items_list ON inbox_items (updated_at DESC, id DESC);
CREATE INDEX inbox_items_pending ON inbox_items (status, updated_at DESC, id DESC);

CREATE TABLE inbox_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Public list cursor. A source high-water note does not move it.
  revision INTEGER NOT NULL CHECK (revision >= 0),
  -- Reconcile fence. Moves with every public inbox write and every source
  -- observation that raises a high water without changing the public row.
  collection_revision INTEGER NOT NULL CHECK (collection_revision >= 0)
);

INSERT INTO inbox_meta (id, revision, collection_revision) VALUES (1, 0, 0);
