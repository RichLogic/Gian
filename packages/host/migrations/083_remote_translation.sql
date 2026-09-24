ALTER TABLE remote_execution_send_requests ADD COLUMN translation_id TEXT REFERENCES translation_results(id) ON DELETE SET NULL;
ALTER TABLE remote_execution_send_requests ADD COLUMN method TEXT NOT NULL DEFAULT 'session.send';
CREATE INDEX remote_translation_delivery ON remote_execution_send_requests
  (local_session_id, json_extract(result_json, '$.delivery_id'));
CREATE INDEX remote_translation_queue ON remote_execution_send_requests
  (local_session_id, method, json_extract(params_json, '$.queue_id'));
ALTER TABLE session_translation_preferences ADD COLUMN remote_after_sequence INTEGER NOT NULL DEFAULT 0;
CREATE INDEX remote_replica_delivery ON remote_execution_replica_events
  (local_session_id, json_extract(item_json, '$.item.delivery_id'));
