CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE host_credentials (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  refresh_secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL
);

CREATE TABLE host_enrollments (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  claimed_host_id TEXT REFERENCES hosts(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE pairing_grants (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  failed_claims INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  pairing_id TEXT,
  consumed_at INTEGER,
  rejected_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE browser_installations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE device_host_pairings (
  id TEXT PRIMARY KEY,
  browser_installation_id TEXT NOT NULL REFERENCES browser_installations(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL,
  platform TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (browser_installation_id, host_id)
);

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  browser_installation_id TEXT NOT NULL REFERENCES browser_installations(id) ON DELETE CASCADE,
  current_refresh_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sliding_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_rotated_at INTEGER NOT NULL
);

CREATE TABLE ws_tickets (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  device_id TEXT REFERENCES device_host_pairings(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES device_sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE presence_leases (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE relay_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  ciphertext_bytes INTEGER NOT NULL,
  transport_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (route_id, direction, transport_sequence)
);

CREATE TABLE revocation_tombstones (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE TABLE connector_challenges (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE device_challenges (
  id TEXT PRIMARY KEY,
  browser_installation_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
