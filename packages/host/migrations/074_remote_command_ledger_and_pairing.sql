ALTER TABLE remote_devices ADD COLUMN crypto_connection_id TEXT;
ALTER TABLE remote_pairings ADD COLUMN server_pairing_id TEXT;

CREATE TABLE remote_command_ledger_v2 (
  device_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  method TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL,
  tool_result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, command_id)
);

INSERT INTO remote_command_ledger_v2 (
  device_id, command_id, method, attempt_id, state, tool_result_json, error_json, created_at, updated_at
)
SELECT device_id, command_id, method, attempt_id, state, tool_result_json, error_json, created_at, updated_at
FROM remote_command_ledger;

DROP TABLE remote_command_ledger;
ALTER TABLE remote_command_ledger_v2 RENAME TO remote_command_ledger;

CREATE INDEX idx_remote_command_ledger_device
  ON remote_command_ledger(device_id, updated_at DESC);
