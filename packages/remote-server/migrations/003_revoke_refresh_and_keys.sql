ALTER TABLE host_credentials ADD COLUMN previous_refresh_secret_hash TEXT;
ALTER TABLE host_credentials ADD COLUMN issued_refresh_secret TEXT;
ALTER TABLE revocation_tombstones ADD COLUMN public_key_jwk TEXT;

CREATE TABLE revoked_pairing_keys (
  public_key_hash TEXT PRIMARY KEY,
  public_key_jwk TEXT NOT NULL,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);
