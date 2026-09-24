CREATE TABLE account_peers (
  role TEXT NOT NULL CHECK (role IN ('host', 'controller')),
  installation_id TEXT NOT NULL,
  github_account_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  server_identity_fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (role, installation_id)
);

CREATE TABLE account_challenges (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('host', 'controller')),
  installation_id TEXT NOT NULL,
  public_key_json TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX account_challenges_expiry ON account_challenges(expires_at);

ALTER TABLE hosts ADD COLUMN account_peer_id TEXT;
ALTER TABLE device_host_pairings ADD COLUMN account_peer_id TEXT;
ALTER TABLE device_sessions ADD COLUMN account_peer_id TEXT;
