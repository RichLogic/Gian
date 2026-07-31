-- migration:no-transaction
-- Slack and Discord now use Gian's canonical sessions, turns, and
-- queue_entries tables. Keep only platform-owned bot, inbound-event, and
-- outbox state. Existing outbox links are preserved when their session id
-- exists in the canonical sessions table.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE discord_outbox_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  channel_id TEXT,
  turn_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  sent_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES discord_bots(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
INSERT INTO discord_outbox_new (
  id, bot_id, session_id, channel_id, turn_id, content, status,
  attempt_count, sent_message_id, last_error, created_at, updated_at
)
SELECT
  id,
  bot_id,
  CASE
    WHEN session_id IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE sessions.id = discord_outbox.session_id)
      THEN session_id
    ELSE NULL
  END,
  channel_id,
  turn_id,
  content,
  status,
  attempt_count,
  sent_message_id,
  last_error,
  created_at,
  updated_at
FROM discord_outbox;
DROP TABLE discord_outbox;
ALTER TABLE discord_outbox_new RENAME TO discord_outbox;
CREATE INDEX discord_outbox_bot_status_created_idx
  ON discord_outbox (bot_id, status, created_at);

CREATE TABLE slack_outbox_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  channel_id TEXT,
  turn_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  sent_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES slack_bots(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
INSERT INTO slack_outbox_new (
  id, bot_id, session_id, channel_id, turn_id, content, status,
  attempt_count, sent_message_id, last_error, created_at, updated_at
)
SELECT
  id,
  bot_id,
  CASE
    WHEN session_id IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE sessions.id = slack_outbox.session_id)
      THEN session_id
    ELSE NULL
  END,
  channel_id,
  turn_id,
  content,
  status,
  attempt_count,
  sent_message_id,
  last_error,
  created_at,
  updated_at
FROM slack_outbox;
DROP TABLE slack_outbox;
ALTER TABLE slack_outbox_new RENAME TO slack_outbox;
CREATE INDEX slack_outbox_bot_status_created_idx
  ON slack_outbox (bot_id, status, created_at);

DROP TABLE discord_coding_queued_turns;
DROP TABLE discord_coding_turns;
DROP TABLE discord_coding_sessions;
DROP TABLE slack_coding_queued_turns;
DROP TABLE slack_coding_turns;
DROP TABLE slack_coding_sessions;

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
