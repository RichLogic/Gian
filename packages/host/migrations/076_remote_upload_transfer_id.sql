ALTER TABLE remote_upload_intents ADD COLUMN transfer_id TEXT;

UPDATE remote_upload_intents SET transfer_id = id WHERE transfer_id IS NULL;

CREATE UNIQUE INDEX idx_remote_upload_intents_open_transfer
  ON remote_upload_intents(device_id, transfer_id)
  WHERE transfer_id IS NOT NULL AND state = 'open';
