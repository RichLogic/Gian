-- Persist gian.proxy/2.0 interaction response ids so Host retries stay
-- idempotent across process restarts. Old `approvals` rows are display-era
-- records and are not migrated (D5).
CREATE TABLE proxy_interactions (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  interaction_id  TEXT NOT NULL,
  response_id     TEXT NOT NULL,
  turn_id         TEXT,
  action_id       TEXT,
  outcome         TEXT,
  values_json     TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  PRIMARY KEY (session_id, interaction_id)
);

CREATE INDEX idx_proxy_interactions_response
  ON proxy_interactions(response_id);
