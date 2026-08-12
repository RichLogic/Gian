CREATE TABLE proxy_replay_turns (
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider_turn_id TEXT NOT NULL,
  turn_id          TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, provider_turn_id)
);

CREATE TABLE proxy_replay_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  turn_id    TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
);

CREATE INDEX idx_proxy_replay_events_turn
  ON proxy_replay_events(turn_id);
