-- Canonical execution evidence for the Trace projection.
--
-- One row per gian.proxy/1.0 notification that reached the coordinator's
-- standard (turn-scoped) path, either live or via replay. The row keeps the
-- protocol identity fields Trace needs (eventId, streamId, sequence,
-- sessionId, turnId, emittedAt, method) plus a normalized, bounded view of
-- the event payload. Replays of the same eventId are idempotent via the
-- (session_id, event_id) primary key.
--
-- The table is deliberately independent from the transcript `events` table:
-- `events` stores the display projection used by Chat; `trace_events`
-- stores the trace-relevant canonical payload. The Chat transcript is never
-- modified by this projection.

CREATE TABLE trace_events (
  event_id          TEXT NOT NULL,
  stream_id         TEXT NOT NULL,
  sequence          INTEGER NOT NULL,
  stream_generation INTEGER NOT NULL DEFAULT 1,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id           TEXT,
  emitted_at        TEXT NOT NULL,
  method            TEXT NOT NULL,
  data              TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
);

-- Session-level stable order: the protocol resets sequence when a session is
-- re-attached with a new streamId, so cross-stream ordering must come from
-- the Host-assigned stream generation, with protocol sequence ordering only
-- within one stream.
CREATE INDEX idx_trace_events_session_gen_seq
  ON trace_events(session_id, stream_generation, sequence);