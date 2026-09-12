CREATE TABLE remote_handshake_receipts (
  handshake_nonce TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  signed_at INTEGER NOT NULL
);

CREATE TABLE remote_revoke_receipts (
  signature TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  signed_at INTEGER NOT NULL
);
