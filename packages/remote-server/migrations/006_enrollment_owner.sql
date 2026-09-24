ALTER TABLE host_enrollments ADD COLUMN github_account_id TEXT;
ALTER TABLE account_peers ADD COLUMN delegated_host_id TEXT REFERENCES hosts(id);

-- Legacy unused tokens have no verified owner and cannot be safely upgraded.
UPDATE host_enrollments SET expires_at = 0 WHERE used_at IS NULL;

CREATE TABLE enrollment_sessions (
  token_hash TEXT PRIMARY KEY,
  account_peer_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
