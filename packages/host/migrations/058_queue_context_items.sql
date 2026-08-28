-- 058_queue_context_items.sql - preserve Gian-owned context cards while a
-- message waits in the queue.
-- Provider input remains in items_json; context_items_json stores the
-- canonical pasted-text/folder metadata rendered by the web client.

ALTER TABLE queue_entries
ADD COLUMN context_items_json TEXT;
