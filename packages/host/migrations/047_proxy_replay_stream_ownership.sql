ALTER TABLE proxy_replay_turns
  ADD COLUMN replay_owned INTEGER NOT NULL DEFAULT 1
  CHECK (replay_owned IN (0, 1));

CREATE TABLE proxy_replay_streams (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  replay_stream_id TEXT NOT NULL
);
