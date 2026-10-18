-- Durable episode for one system.repair source.
-- Generation is stored here. It is not recomputed from events, because
-- those rows can be deleted with a session. The watermark is the last
-- consumed events.sequence for one session of that source. A new fact
-- reads that cursor instead of scanning older history.
-- config_identity is the canonical turn-snapshot binding captured when
-- the episode opened. NULL means that snapshot had no runtime binding,
-- and recovery_block CONFIG_IDENTITY_ABSENT forbids closing the episode.
CREATE TABLE inbox_repair_episodes (
  source_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('open', 'closed')),
  config_identity TEXT,
  recovery_block TEXT CHECK (
    recovery_block IS NULL OR recovery_block = 'CONFIG_IDENTITY_ABSENT'
  ),
  fault_event_id TEXT,
  fault_session_id TEXT,
  fault_turn_id TEXT,
  fault_turn_number INTEGER,
  fault_turn_created_at TEXT,
  title TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('agent_login', 'agent_settings')),
  updated_at TEXT NOT NULL
);

CREATE TABLE inbox_repair_watermarks (
  source_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  PRIMARY KEY (source_key, session_id)
);
