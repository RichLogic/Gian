-- These tables never backed a live product surface. Authentication uses the
-- password plus ephemeral gian_session tokens; message queuing uses
-- queue_entries. Keep their historical migrations for upgrade ordering, then
-- remove the unreachable storage here.
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS queue;
