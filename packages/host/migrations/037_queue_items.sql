-- 037_queue_items.sql — carry structured input items (attachments) on
-- queued messages.
--
-- queue_entries used to store text only, so queueing a message with image
-- attachments silently dropped the files — they never reached the LLM when
-- the entry drained. `items_json` holds the same InputItem[] shape the web
-- sends on `message:send` (text + localImage path references into the
-- per-session attachment store). NULL for text-only entries.

ALTER TABLE queue_entries
ADD COLUMN items_json TEXT;
