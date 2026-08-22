-- Independent Side Chat transient store. These rows are never ordinary
-- sessions, turns, transcript, trace, replay, archive, or search.
CREATE TABLE sidechat_transients (
  sidechat_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_stream_id TEXT,
  stream_id TEXT,
  stream_generation INTEGER NOT NULL DEFAULT 0,
  resume_ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closing', 'unavailable')),
  anchor_json TEXT NOT NULL,
  session_config_json TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  user_input_json TEXT,
  idempotency_json TEXT,
  last_error TEXT,
  uncertain_turn_id TEXT,
  close_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sidechat_transients_parent
  ON sidechat_transients(parent_session_id);
CREATE INDEX idx_sidechat_transients_status
  ON sidechat_transients(status);

ALTER TABLE sessions ADD COLUMN origin_kind TEXT;
ALTER TABLE sessions ADD COLUMN origin_session_id TEXT;
ALTER TABLE sessions ADD COLUMN origin_turn_id TEXT;
ALTER TABLE sessions ADD COLUMN origin_source_turn_id TEXT;
ALTER TABLE sessions ADD COLUMN available_actions_json TEXT;
