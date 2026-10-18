-- Producer freshness for an Integration update. The published Catalog sequence
-- does not move when an installed receipt's candidate phase changes, and the
-- Inbox row keeps the previous candidate when an older version is rejected.
-- This table remembers the last observation so the next signal stays monotonic
-- across restart without using a process-local counter.
CREATE TABLE inbox_source_epochs (
  source_key TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('available', 'downloaded', 'failed')),
  catalog_sequence INTEGER NOT NULL CHECK (catalog_sequence >= 1)
);
