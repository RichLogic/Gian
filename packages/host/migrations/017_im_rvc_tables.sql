-- IM transplant from remote-vibe-coding (rvc).
--
-- 把 rvc apps/host/src/sqlite.ts 里的 IM-related schema 整片搬过来。
-- 唯一改动:外键 `coding_workspaces(id)` → Gian 的 `workspaces(id)`。
-- 其他全部 1:1 复制,IM 模块照原样使用。
--
-- 这些表和 Gian 现有的 `sessions` / `bots` 是平行的:IM 端有自己一套
-- discord_coding_sessions / slack_coding_sessions(rvc 的 IM 数据模型)。
-- 老的统一 `bots` 表暂留只读,后续 Phase 6/7 决定是否清理。

CREATE TABLE IF NOT EXISTS discord_bots (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  label TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  application_id TEXT,
  bot_user_id TEXT,
  allowed_discord_user_id TEXT,
  selected_workspace_id TEXT,
  selected_session_id TEXT,
  direct_channel_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disabled',
  last_error TEXT,
  last_connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (selected_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS discord_bots_owner_updated_idx
  ON discord_bots (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS discord_coding_sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  executor TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  active_turn_id TEXT,
  title TEXT NOT NULL,
  auto_title INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  archived_at TEXT,
  security_profile TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  network_enabled INTEGER NOT NULL,
  full_host_enabled INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_issue TEXT,
  has_transcript INTEGER NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'interactive',
  job_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES discord_bots(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS discord_coding_sessions_owner_updated_idx
  ON discord_coding_sessions (owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS discord_coding_sessions_bot_workspace_updated_idx
  ON discord_coding_sessions (bot_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS discord_coding_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  objective_text TEXT,
  assistant_text TEXT,
  thread_preview_text TEXT,
  transcript_entries_json TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, turn_id),
  FOREIGN KEY (session_id) REFERENCES discord_coding_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discord_coding_queued_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  prompt TEXT,
  attachment_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_after_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES discord_coding_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS discord_coding_queued_turns_session_status_created_idx
  ON discord_coding_queued_turns (session_id, status, created_at, id);

CREATE INDEX IF NOT EXISTS discord_coding_queued_turns_session_created_idx
  ON discord_coding_queued_turns (session_id, created_at, id);

CREATE INDEX IF NOT EXISTS discord_coding_queued_turns_owner_created_idx
  ON discord_coding_queued_turns (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS discord_inbound_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT,
  author_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES discord_bots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS discord_inbound_events_bot_created_idx
  ON discord_inbound_events (bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS discord_outbox (
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
  FOREIGN KEY (session_id) REFERENCES discord_coding_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS discord_outbox_bot_status_created_idx
  ON discord_outbox (bot_id, status, created_at);

CREATE TABLE IF NOT EXISTS slack_bots (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  label TEXT NOT NULL,
  bot_token_ciphertext TEXT NOT NULL,
  app_token_ciphertext TEXT NOT NULL,
  team_id TEXT,
  bot_user_id TEXT,
  allowed_slack_user_id TEXT,
  selected_workspace_id TEXT,
  selected_session_id TEXT,
  direct_channel_id TEXT,
  command_prefix TEXT,
  config_token_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disabled',
  last_error TEXT,
  last_connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (selected_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS slack_bots_owner_updated_idx
  ON slack_bots (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS slack_coding_sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  executor TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  active_turn_id TEXT,
  title TEXT NOT NULL,
  auto_title INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  archived_at TEXT,
  security_profile TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  network_enabled INTEGER NOT NULL,
  full_host_enabled INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_issue TEXT,
  has_transcript INTEGER NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'interactive',
  job_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES slack_bots(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS slack_coding_sessions_owner_updated_idx
  ON slack_coding_sessions (owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS slack_coding_sessions_bot_workspace_updated_idx
  ON slack_coding_sessions (bot_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS slack_coding_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  objective_text TEXT,
  assistant_text TEXT,
  thread_preview_text TEXT,
  transcript_entries_json TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, turn_id),
  FOREIGN KEY (session_id) REFERENCES slack_coding_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_coding_queued_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  prompt TEXT,
  attachment_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_after_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES slack_coding_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS slack_coding_queued_turns_session_status_created_idx
  ON slack_coding_queued_turns (session_id, status, created_at, id);

CREATE INDEX IF NOT EXISTS slack_coding_queued_turns_session_created_idx
  ON slack_coding_queued_turns (session_id, created_at, id);

CREATE INDEX IF NOT EXISTS slack_coding_queued_turns_owner_created_idx
  ON slack_coding_queued_turns (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS slack_inbound_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT,
  author_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES slack_bots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS slack_inbound_events_bot_created_idx
  ON slack_inbound_events (bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS slack_outbox (
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
  FOREIGN KEY (session_id) REFERENCES slack_coding_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS slack_outbox_bot_status_created_idx
  ON slack_outbox (bot_id, status, created_at);
