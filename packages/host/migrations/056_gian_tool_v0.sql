CREATE TABLE tool_requests (
  id TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  domain_id TEXT,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(caller_id, idempotency_key)
);

CREATE TABLE tool_deliveries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES tool_requests(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  queue_entry_id TEXT,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE queue_entries ADD COLUMN tool_request_id TEXT REFERENCES tool_requests(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN tool_request_id TEXT REFERENCES tool_requests(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN config_json TEXT;

CREATE UNIQUE INDEX idx_queue_entries_tool_request
  ON queue_entries(tool_request_id) WHERE tool_request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_turns_tool_request
  ON turns(tool_request_id) WHERE tool_request_id IS NOT NULL;
CREATE INDEX idx_tool_deliveries_session ON tool_deliveries(session_id, updated_at);
