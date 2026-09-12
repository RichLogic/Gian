ALTER TABLE device_host_pairings ADD COLUMN crypto_connection_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revocation_tombstones_signature
  ON revocation_tombstones(host_id, device_id, signature);
