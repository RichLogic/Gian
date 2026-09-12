ALTER TABLE remote_enrollments ADD COLUMN connector_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE remote_enrollments ADD COLUMN public_url TEXT;
ALTER TABLE remote_enrollments ADD COLUMN identity_changed_at TEXT;
ALTER TABLE remote_devices ADD COLUMN revoke_synced_at TEXT;
