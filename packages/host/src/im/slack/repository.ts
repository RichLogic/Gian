import { randomUUID } from 'node:crypto';
import type { SlackBotStatus } from '../types.js';
import type { DatabaseSync } from '../sqlite.js';
import {
  fromSqliteBoolean,
  isSqliteUniqueConstraintError,
  toSqliteBoolean,
} from '../sqlite.js';

interface SlackBotRow {
  id: string;
  owner_user_id: string;
  owner_username: string;
  label: string;
  bot_token_ciphertext: string;
  app_token_ciphertext: string;
  team_id: string | null;
  bot_user_id: string | null;
  allowed_slack_user_id: string | null;
  selected_workspace_id: string | null;
  selected_session_id: string | null;
  direct_channel_id: string | null;
  command_prefix: string | null;
  config_token_ciphertext: string | null;
  enabled: number;
  status: SlackBotStatus;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SlackOutboxRow {
  id: string;
  bot_id: string;
  session_id: string | null;
  channel_id: string | null;
  turn_id: string | null;
  content: string;
  status: 'pending' | 'sent' | 'error';
  attempt_count: number;
  sent_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlackBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  botTokenCiphertext: string;
  appTokenCiphertext: string;
  teamId: string | null;
  botUserId: string | null;
  allowedSlackUserId: string | null;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  directChannelId: string | null;
  commandPrefix: string | null;
  configTokenCiphertext: string | null;
  enabled: boolean;
  status: SlackBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackOutboxRecord {
  id: string;
  botId: string;
  sessionId: string | null;
  channelId: string | null;
  turnId: string | null;
  content: string;
  status: 'pending' | 'sent' | 'error';
  attemptCount: number;
  sentMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function asBotRecord(row: SlackBotRow): SlackBotRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    label: row.label,
    botTokenCiphertext: row.bot_token_ciphertext,
    appTokenCiphertext: row.app_token_ciphertext,
    teamId: row.team_id,
    botUserId: row.bot_user_id,
    allowedSlackUserId: row.allowed_slack_user_id,
    selectedWorkspaceId: row.selected_workspace_id,
    selectedSessionId: row.selected_session_id,
    directChannelId: row.direct_channel_id,
    commandPrefix: row.command_prefix,
    configTokenCiphertext: row.config_token_ciphertext,
    enabled: fromSqliteBoolean(row.enabled),
    status: row.status,
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asOutboxRecord(row: SlackOutboxRow): SlackOutboxRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    channelId: row.channel_id,
    turnId: row.turn_id,
    content: row.content,
    status: row.status,
    attemptCount: row.attempt_count,
    sentMessageId: row.sent_message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SlackCodingRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listEnabledBotRecords(): Promise<SlackBotRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM slack_bots
      WHERE enabled = 1
      ORDER BY owner_username ASC, created_at ASC
    `).all() as unknown as SlackBotRow[];
    return rows.map(asBotRecord);
  }

  async listBotRecordsForSession(sessionId: string): Promise<SlackBotRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM slack_bots
      WHERE enabled = 1 AND selected_session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as unknown as SlackBotRow[];
    return rows.map(asBotRecord);
  }

  async getBotRecord(botId: string): Promise<SlackBotRecord | null> {
    const row = this.db.prepare('SELECT * FROM slack_bots WHERE id = ?')
      .get(botId) as SlackBotRow | undefined;
    return row ? asBotRecord(row) : null;
  }

  async updateBot(
    botId: string,
    patch: Partial<SlackBotRecord>,
  ): Promise<SlackBotRecord | null> {
    const current = await this.getBotRecord(botId);
    if (!current) return null;

    const next: SlackBotRecord = {
      ...current,
      ...patch,
      id: current.id,
      ownerUserId: current.ownerUserId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE slack_bots
      SET owner_username = ?, label = ?,
          bot_token_ciphertext = ?, app_token_ciphertext = ?,
          team_id = ?, bot_user_id = ?, allowed_slack_user_id = ?,
          selected_workspace_id = ?, selected_session_id = ?, direct_channel_id = ?,
          command_prefix = ?, config_token_ciphertext = ?,
          enabled = ?, status = ?, last_error = ?, last_connected_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      next.ownerUsername,
      next.label,
      next.botTokenCiphertext,
      next.appTokenCiphertext,
      next.teamId,
      next.botUserId,
      next.allowedSlackUserId,
      next.selectedWorkspaceId,
      next.selectedSessionId,
      next.directChannelId,
      next.commandPrefix,
      next.configTokenCiphertext,
      toSqliteBoolean(next.enabled),
      next.status,
      next.lastError,
      next.lastConnectedAt,
      next.updatedAt,
      botId,
    );
    return next;
  }

  async recordInboundEvent(input: {
    id: string;
    botId: string;
    kind: string;
    channelId?: string | null;
    authorId?: string | null;
  }): Promise<boolean> {
    try {
      this.db.prepare(`
        INSERT INTO slack_inbound_events (id, bot_id, kind, channel_id, author_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.botId,
        input.kind,
        input.channelId ?? null,
        input.authorId ?? null,
        new Date().toISOString(),
      );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async createOutboxMessage(input: {
    botId: string;
    sessionId?: string | null;
    channelId?: string | null;
    turnId?: string | null;
    content: string;
  }): Promise<SlackOutboxRecord> {
    const now = new Date().toISOString();
    const record: SlackOutboxRecord = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId ?? null,
      channelId: input.channelId ?? null,
      turnId: input.turnId ?? null,
      content: input.content,
      status: 'pending',
      attemptCount: 0,
      sentMessageId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO slack_outbox (
        id, bot_id, session_id, channel_id, turn_id, content,
        status, attempt_count, sent_message_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.botId,
      record.sessionId,
      record.channelId,
      record.turnId,
      record.content,
      record.status,
      record.attemptCount,
      record.sentMessageId,
      record.lastError,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  async getOutboxMessageBySentMessageId(
    botId: string,
    sentMessageId: string,
  ): Promise<SlackOutboxRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM slack_outbox
      WHERE bot_id = ? AND sent_message_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(botId, sentMessageId) as SlackOutboxRow | undefined;
    return row ? asOutboxRecord(row) : null;
  }

  async markOutboxSent(outboxId: string, sentMessageId: string | null): Promise<void> {
    this.db.prepare(`
      UPDATE slack_outbox
      SET status = 'sent', attempt_count = attempt_count + 1,
          sent_message_id = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(sentMessageId, new Date().toISOString(), outboxId);
  }

  async markOutboxError(outboxId: string, message: string): Promise<void> {
    this.db.prepare(`
      UPDATE slack_outbox
      SET status = 'error', attempt_count = attempt_count + 1,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(message, new Date().toISOString(), outboxId);
  }
}
