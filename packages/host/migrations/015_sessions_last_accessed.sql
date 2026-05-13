-- Track when a session's events were last read; used by sweepColdEvents
-- to LRU-evict events of long-untouched sessions. NULL means never
-- accessed in the new tracking era; sweep treats those as "stale at
-- creation time" using created_at as the fallback.

ALTER TABLE sessions ADD COLUMN last_accessed_at TEXT;
