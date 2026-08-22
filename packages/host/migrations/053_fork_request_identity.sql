-- Persist the canonical session.fork request identity separately from its
-- resolved origin. Head and turn requests can resolve to the same Turn, while
-- a new source attach generation must still conflict for an existing id.
ALTER TABLE sessions ADD COLUMN origin_source_stream_id TEXT;
ALTER TABLE sessions ADD COLUMN origin_anchor_type TEXT
  CHECK (origin_anchor_type IS NULL OR origin_anchor_type IN ('head', 'turn'));
