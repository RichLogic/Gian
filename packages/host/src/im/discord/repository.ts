import { randomUUID } from 'node:crypto';
import type { DiscordBotStatus } from '../types.js';
import type { DatabaseSync } from '../sqlite.js';
import {
  fromSqliteBoolean,
  isSqliteUniqueConstraintError,
  toSqliteBoolean,
} from '../sqlite.js';

interface DiscordBotRow {
  id: string;
  owner_user_id: string;
  owner_username: string;
  label: string;
  token_ciphertext: string;
  application_id: string | null;
  bot_user_id: string | null;
  allowed_discord_user_id: string | null;
  selected_workspace_id: string | null;
  selected_session_id: string | null;
  direct_channel_id: string | null;
  enabled: number;
  status: DiscordBotStatus;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscordBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  tokenCiphertext: string;
  applicationId: string | null;
  botUserId: string | null;
  allowedDiscordUserId: string | null;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  directChannelId: string | null;
  enabled: boolean;
  status: DiscordBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordOutboxRecord {
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

function asBotRecord(row: DiscordBotRow): DiscordBotRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    label: row.label,
    tokenCiphertext: row.token_ciphertext,
    applicationId: row.application_id,
    botUserId: row.bot_user_id,
    allowedDiscordUserId: row.allowed_discord_user_id,
    selectedWorkspaceId: row.selected_workspace_id,
    selectedSessionId: row.selected_session_id,
    directChannelId: row.direct_channel_id,
    enabled: fromSqliteBoolean(row.enabled),
    status: row.status,
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DiscordCodingRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listEnabledBotRecords(): Promise<DiscordBotRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE enabled = 1
      ORDER BY owner_username ASC, created_at ASC
    `).all() as unknown as DiscordBotRow[];
    return rows.map(asBotRecord);
  }

  async listBotRecordsForSession(sessionId: string): Promise<DiscordBotRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE enabled = 1 AND selected_session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as unknown as DiscordBotRow[];
    return rows.map(asBotRecord);
  }

  async getBotRecord(botId: string): Promise<DiscordBotRecord | null> {
    const row = this.db.prepare('SELECT * FROM discord_bots WHERE id = ?')
      .get(botId) as DiscordBotRow | undefined;
    return row ? asBotRecord(row) : null;
  }

  async updateBot(
    botId: string,
    patch: Partial<DiscordBotRecord>,
  ): Promise<DiscordBotRecord | null> {
    const current = await this.getBotRecord(botId);
    if (!current) return null;

    const next: DiscordBotRecord = {
      ...current,
      ...patch,
      id: current.id,
      ownerUserId: current.ownerUserId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.db.prepare(`
      UPDATE discord_bots
      SET owner_username = ?, label = ?, token_ciphertext = ?,
          application_id = ?, bot_user_id = ?, allowed_discord_user_id = ?,
          selected_workspace_id = ?, selected_session_id = ?, direct_channel_id = ?,
          enabled = ?, status = ?, last_error = ?, last_connected_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.ownerUsername,
      next.label,
      next.tokenCiphertext,
      next.applicationId,
      next.botUserId,
      next.allowedDiscordUserId,
      next.selectedWorkspaceId,
      next.selectedSessionId,
      next.directChannelId,
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
        INSERT INTO discord_inbound_events (id, bot_id, kind, channel_id, author_id, created_at)
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
  }): Promise<DiscordOutboxRecord> {
    const now = new Date().toISOString();
    const record: DiscordOutboxRecord = {
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
      INSERT INTO discord_outbox (
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

  async markOutboxSent(outboxId: string, sentMessageId: string | null): Promise<void> {
    this.db.prepare(`
      UPDATE discord_outbox
      SET status = 'sent', attempt_count = attempt_count + 1,
          sent_message_id = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(sentMessageId, new Date().toISOString(), outboxId);
  }

  async markOutboxError(outboxId: string, message: string): Promise<void> {
    this.db.prepare(`
      UPDATE discord_outbox
      SET status = 'error', attempt_count = attempt_count + 1,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(message, new Date().toISOString(), outboxId);
  }
}
