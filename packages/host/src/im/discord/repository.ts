import { randomUUID } from 'node:crypto';
// rvc used the Node 22 built-in `node:sqlite` (DatabaseSync); Gian uses
// `better-sqlite3`. The type alias lives in our local sqlite shim.
import { type DatabaseSync } from '../sqlite.js';

import type {
  AdminDiscordBotRecord,
  DiscordBotStatus,
  SessionCommandEvent,
  SessionFileChangeEvent,
  SessionJobRecord,
  SessionRecord,
  SessionStatus,
  SessionTranscriptEntry,
} from '../types.js';
import {
  fromSqliteBoolean,
  isSqliteUniqueConstraintError,
  parseJson,
  serializeJson,
  toSqliteBoolean,
  withTransaction,
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

interface DiscordSessionRow {
  id: string;
  bot_id: string;
  owner_user_id: string;
  owner_username: string;
  executor: SessionRecord['executor'];
  workspace_id: string;
  thread_id: string;
  active_turn_id: string | null;
  title: string;
  auto_title: number;
  workspace: string;
  archived_at: string | null;
  security_profile: SessionRecord['securityProfile'];
  approval_mode: SessionRecord['approvalMode'];
  network_enabled: number;
  full_host_enabled: number;
  status: SessionStatus;
  last_issue: string | null;
  has_transcript: number;
  model: string | null;
  reasoning_effort: SessionRecord['reasoningEffort'];
  execution_mode: NonNullable<SessionRecord['executionMode']>;
  job_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DiscordTurnRow {
  id: string;
  session_id: string;
  turn_id: string;
  thread_id: string;
  seq: number;
  status: string;
  objective_text: string | null;
  assistant_text: string | null;
  thread_preview_text: string | null;
  transcript_entries_json: string;
  commands_json: string;
  changes_json: string;
  created_at: string;
  updated_at: string;
}

interface QueuedDiscordTurnRow {
  id: string;
  session_id: string;
  owner_user_id: string;
  prompt: string | null;
  attachment_ids_json: string;
  status: 'queued' | 'starting';
  queued_after_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DiscordInboundEventRow {
  id: string;
  bot_id: string;
  kind: string;
  channel_id: string | null;
  author_id: string | null;
  created_at: string;
}

interface DiscordOutboxRow {
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

export interface QueuedDiscordTurnRecord {
  id: string;
  sessionId: string;
  ownerUserId: string;
  prompt: string | null;
  attachmentIds: string[];
  status: 'queued' | 'starting';
  queuedAfterTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedDiscordCodingTurnRecord {
  id: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  seq: number;
  status: string;
  objective: string | null;
  assistantText: string | null;
  threadPreview: string | null;
  transcriptEntries: SessionTranscriptEntry[];
  commands: SessionCommandEvent[];
  changes: SessionFileChangeEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscordCodingTurnProjection {
  turnId: string;
  threadId: string;
  status: string;
  objective: string | null;
  assistantText: string | null;
  threadPreview: string | null;
  transcriptEntries: SessionTranscriptEntry[];
  commands: SessionCommandEvent[];
  changes: SessionFileChangeEvent[];
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

function toAdminBotRecord(record: DiscordBotRecord): AdminDiscordBotRecord {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerUsername: record.ownerUsername,
    label: record.label,
    applicationId: record.applicationId,
    botUserId: record.botUserId,
    allowedDiscordUserId: record.allowedDiscordUserId,
    selectedWorkspaceId: record.selectedWorkspaceId,
    directChannelId: record.directChannelId,
    enabled: record.enabled,
    hasToken: record.tokenCiphertext.trim().length > 0,
    status: record.status,
    lastError: record.lastError,
    lastConnectedAt: record.lastConnectedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function asSessionRecord(row: DiscordSessionRow): SessionRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    sessionType: 'code',
    executor: row.executor ?? 'codex',
    workspaceId: row.workspace_id,
    executionMode: row.execution_mode ?? 'interactive',
    job: parseJson<SessionJobRecord | null>(row.job_json, null) ?? null,
    threadId: row.thread_id,
    activeTurnId: row.active_turn_id,
    title: row.title,
    autoTitle: fromSqliteBoolean(row.auto_title),
    workspace: row.workspace,
    archivedAt: row.archived_at,
    origin: 'discord',
    botId: row.bot_id,
    securityProfile: row.security_profile,
    approvalMode: row.approval_mode,
    networkEnabled: fromSqliteBoolean(row.network_enabled),
    fullHostEnabled: fromSqliteBoolean(row.full_host_enabled),
    status: row.status,
    lastIssue: row.last_issue,
    hasTranscript: fromSqliteBoolean(row.has_transcript),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asTurnRecord(row: DiscordTurnRow): PersistedDiscordCodingTurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    threadId: row.thread_id,
    seq: row.seq,
    status: row.status,
    objective: row.objective_text,
    assistantText: row.assistant_text,
    threadPreview: row.thread_preview_text,
    transcriptEntries: parseJson<SessionTranscriptEntry[]>(row.transcript_entries_json, []),
    commands: parseJson<SessionCommandEvent[]>(row.commands_json, []),
    changes: parseJson<SessionFileChangeEvent[]>(row.changes_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asQueuedTurnRecord(row: QueuedDiscordTurnRow): QueuedDiscordTurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    prompt: row.prompt,
    attachmentIds: parseJson<string[]>(row.attachment_ids_json, []),
    status: row.status,
    queuedAfterTurnId: row.queued_after_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asOutboxRecord(row: DiscordOutboxRow): DiscordOutboxRecord {
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

export class DiscordCodingRepository {
  constructor(private readonly db: DatabaseSync) {}

  async ensureIndexes() {}

  async listBots() {
    const rows = this.db.prepare(`
      SELECT * FROM discord_bots
      ORDER BY owner_username ASC, created_at ASC
    `).all() as unknown as DiscordBotRow[];
    return rows.map((row) => toAdminBotRecord(asBotRecord(row)));
  }

  async listBotRecords() {
    const rows = this.db.prepare(`
      SELECT * FROM discord_bots
      ORDER BY owner_username ASC, created_at ASC
    `).all() as unknown as DiscordBotRow[];
    return rows.map(asBotRecord);
  }

  async listEnabledBotRecords() {
    const rows = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE enabled = 1
      ORDER BY owner_username ASC, created_at ASC
    `).all() as unknown as DiscordBotRow[];
    return rows.map(asBotRecord);
  }

  async getBot(botId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE id = ?
    `).get(botId) as DiscordBotRow | undefined;
    return row ? toAdminBotRecord(asBotRecord(row)) : null;
  }

  async getBotRecord(botId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE id = ?
    `).get(botId) as DiscordBotRow | undefined;
    return row ? asBotRecord(row) : null;
  }

  async getBotRecordForOwner(ownerUserId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_bots
      WHERE owner_user_id = ?
    `).get(ownerUserId) as DiscordBotRow | undefined;
    return row ? asBotRecord(row) : null;
  }

  async createBot(record: DiscordBotRecord) {
    try {
      this.db.prepare(`
        INSERT INTO discord_bots (
          id,
          owner_user_id,
          owner_username,
          label,
          token_ciphertext,
          application_id,
          bot_user_id,
          allowed_discord_user_id,
          selected_workspace_id,
          selected_session_id,
          direct_channel_id,
          enabled,
          status,
          last_error,
          last_connected_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.ownerUserId,
        record.ownerUsername,
        record.label,
        record.tokenCiphertext,
        record.applicationId,
        record.botUserId,
        record.allowedDiscordUserId,
        record.selectedWorkspaceId,
        record.selectedSessionId,
        record.directChannelId,
        toSqliteBoolean(record.enabled),
        record.status,
        record.lastError,
        record.lastConnectedAt,
        record.createdAt,
        record.updatedAt,
      );
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        throw new Error('Discord bot record conflicts with existing data.');
      }
      throw error;
    }
    return this.getBotRecord(record.id);
  }

  async updateBot(botId: string, patch: Partial<DiscordBotRecord>) {
    const current = await this.getBotRecord(botId);
    if (!current) {
      return null;
    }

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
      SET owner_username = ?,
          label = ?,
          token_ciphertext = ?,
          application_id = ?,
          bot_user_id = ?,
          allowed_discord_user_id = ?,
          selected_workspace_id = ?,
          selected_session_id = ?,
          direct_channel_id = ?,
          enabled = ?,
          status = ?,
          last_error = ?,
          last_connected_at = ?,
          updated_at = ?
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

  async deleteBot(botId: string) {
    const result = this.db.prepare(`
      DELETE FROM discord_bots
      WHERE id = ?
    `).run(botId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async countBotsForUser(userId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM discord_bots
      WHERE owner_user_id = ?
    `).get(userId) as { count: number };
    return row.count;
  }

  async updateOwnerUsername(userId: string, ownerUsername: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE discord_bots
      SET owner_username = ?,
          updated_at = ?
      WHERE owner_user_id = ?
    `).run(ownerUsername, now, userId);

    this.db.prepare(`
      UPDATE discord_coding_sessions
      SET owner_username = ?,
          updated_at = ?
      WHERE owner_user_id = ?
    `).run(ownerUsername, now, userId);
  }

  async countSessionsForWorkspace(botId: string, workspaceId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM discord_coding_sessions
      WHERE bot_id = ? AND workspace_id = ?
    `).get(botId, workspaceId) as { count: number };
    return row.count;
  }

  async getSession(sessionId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE id = ?
    `).get(sessionId) as DiscordSessionRow | undefined;
    return row ? asSessionRecord(row) : null;
  }

  async getSessionForBotWorkspace(botId: string, workspaceId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE bot_id = ? AND workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(botId, workspaceId) as DiscordSessionRow | undefined;
    return row ? asSessionRecord(row) : null;
  }

  async getSessionForBot(botId: string, sessionId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE bot_id = ? AND id = ?
    `).get(botId, sessionId) as DiscordSessionRow | undefined;
    return row ? asSessionRecord(row) : null;
  }

  async listSessionsForBotWorkspace(botId: string, workspaceId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE bot_id = ? AND workspace_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
    `).all(botId, workspaceId) as unknown as DiscordSessionRow[];
    return rows.map(asSessionRecord);
  }

  async countSessionsForOwnerWorkspace(userId: string, workspaceId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM discord_coding_sessions
      WHERE owner_user_id = ? AND workspace_id = ?
    `).get(userId, workspaceId) as { count: number };
    return row.count;
  }

  async listSessionsForOwnerWorkspace(userId: string, workspaceId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE owner_user_id = ? AND workspace_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
    `).all(userId, workspaceId) as unknown as DiscordSessionRow[];
    return rows.map(asSessionRecord);
  }

  async findSessionByThreadId(threadId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE thread_id = ?
    `).get(threadId) as DiscordSessionRow | undefined;
    return row ? asSessionRecord(row) : null;
  }

  async listSessionsForUser(userId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE owner_user_id = ?
      ORDER BY updated_at DESC
    `).all(userId) as unknown as DiscordSessionRow[];
    return rows.map(asSessionRecord);
  }

  async getSessionForUser(sessionId: string, userId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE id = ? AND owner_user_id = ?
    `).get(sessionId, userId) as DiscordSessionRow | undefined;
    return row ? asSessionRecord(row) : null;
  }

  async listSessionsForBot(botId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_sessions
      WHERE bot_id = ?
      ORDER BY updated_at DESC
    `).all(botId) as unknown as DiscordSessionRow[];
    return rows.map(asSessionRecord);
  }

  async countSessionsForUser(userId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM discord_coding_sessions
      WHERE owner_user_id = ?
    `).get(userId) as { count: number };
    return row.count;
  }

  async upsertSession(record: SessionRecord) {
    if (!record.botId) {
      throw new Error('Discord session is missing botId.');
    }

    this.db.prepare(`
      INSERT INTO discord_coding_sessions (
        id,
        bot_id,
        owner_user_id,
        owner_username,
        executor,
        workspace_id,
        thread_id,
        active_turn_id,
        title,
        auto_title,
        workspace,
        archived_at,
        security_profile,
        approval_mode,
        network_enabled,
        full_host_enabled,
        status,
        last_issue,
        has_transcript,
        model,
        reasoning_effort,
        execution_mode,
        job_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bot_id = excluded.bot_id,
        owner_user_id = excluded.owner_user_id,
        owner_username = excluded.owner_username,
        executor = excluded.executor,
        workspace_id = excluded.workspace_id,
        thread_id = excluded.thread_id,
        active_turn_id = excluded.active_turn_id,
        title = excluded.title,
        auto_title = excluded.auto_title,
        workspace = excluded.workspace,
        archived_at = excluded.archived_at,
        security_profile = excluded.security_profile,
        approval_mode = excluded.approval_mode,
        network_enabled = excluded.network_enabled,
        full_host_enabled = excluded.full_host_enabled,
        status = excluded.status,
        last_issue = excluded.last_issue,
        has_transcript = excluded.has_transcript,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        execution_mode = excluded.execution_mode,
        job_json = excluded.job_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.botId,
      record.ownerUserId,
      record.ownerUsername,
      record.executor,
      record.workspaceId,
      record.threadId,
      record.activeTurnId,
      record.title,
      toSqliteBoolean(record.autoTitle),
      record.workspace,
      record.archivedAt,
      record.securityProfile,
      record.approvalMode,
      toSqliteBoolean(record.networkEnabled),
      toSqliteBoolean(record.fullHostEnabled),
      record.status,
      record.lastIssue,
      toSqliteBoolean(record.hasTranscript),
      record.model,
      record.reasoningEffort,
      record.executionMode ?? 'interactive',
      serializeJson(record.job ?? null),
      record.createdAt,
      record.updatedAt,
    );

    return this.getSession(record.id);
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const next: SessionRecord = {
      ...current,
      ...patch,
      id: current.id,
      sessionType: 'code',
      origin: 'discord',
      botId: patch.botId ?? current.botId ?? null,
      ownerUserId: current.ownerUserId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    await this.upsertSession(next);
    return next;
  }

  async deleteSession(sessionId: string) {
    const result = this.db.prepare(`
      DELETE FROM discord_coding_sessions
      WHERE id = ?
    `).run(sessionId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async markAllStale(reason: string) {
    this.db.prepare(`
      UPDATE discord_coding_sessions
      SET active_turn_id = NULL,
          status = 'stale',
          last_issue = ?,
          network_enabled = 0,
          updated_at = ?
    `).run(reason, new Date().toISOString());
  }

  async listTurns(sessionId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_turns
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(sessionId) as unknown as DiscordTurnRow[];
    return rows.map(asTurnRecord);
  }

  async mergeTurnProjections(sessionId: string, projections: DiscordCodingTurnProjection[]) {
    if (projections.length === 0) {
      return this.listTurns(sessionId);
    }

    withTransaction(this.db, () => {
      const highestSeqRow = this.db.prepare(`
        SELECT seq
        FROM discord_coding_turns
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `).get(sessionId) as Pick<DiscordTurnRow, 'seq'> | undefined;

      let nextSeq = (highestSeqRow?.seq ?? -1) + 1;
      const now = new Date().toISOString();
      const selectExisting = this.db.prepare(`
        SELECT id
        FROM discord_coding_turns
        WHERE id = ?
      `);
      const update = this.db.prepare(`
        UPDATE discord_coding_turns
        SET thread_id = ?,
            status = ?,
            objective_text = ?,
            assistant_text = ?,
            thread_preview_text = ?,
            transcript_entries_json = ?,
            commands_json = ?,
            changes_json = ?,
            updated_at = ?
        WHERE id = ?
      `);
      const insert = this.db.prepare(`
        INSERT INTO discord_coding_turns (
          id,
          session_id,
          turn_id,
          thread_id,
          seq,
          status,
          objective_text,
          assistant_text,
          thread_preview_text,
          transcript_entries_json,
          commands_json,
          changes_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const projection of projections) {
        const documentId = `${sessionId}:${projection.turnId}`;
        const payload = [
          projection.threadId,
          projection.status,
          projection.objective,
          projection.assistantText,
          projection.threadPreview,
          serializeJson(projection.transcriptEntries),
          serializeJson(projection.commands),
          serializeJson(projection.changes),
          now,
        ] as const;
        const existing = selectExisting.get(documentId) as { id: string } | undefined;
        if (existing) {
          update.run(...payload, documentId);
          continue;
        }

        insert.run(
          documentId,
          sessionId,
          projection.turnId,
          projection.threadId,
          nextSeq++,
          projection.status,
          projection.objective,
          projection.assistantText,
          projection.threadPreview,
          serializeJson(projection.transcriptEntries),
          serializeJson(projection.commands),
          serializeJson(projection.changes),
          now,
          now,
        );
      }
    });

    return this.listTurns(sessionId);
  }

  async deleteSessionHistory(sessionId: string) {
    this.db.prepare(`
      DELETE FROM discord_coding_turns
      WHERE session_id = ?
    `).run(sessionId);
  }

  async listQueuedTurns(sessionId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM discord_coding_queued_turns
      WHERE session_id = ? AND status = 'queued'
      ORDER BY created_at ASC, rowid ASC
    `).all(sessionId) as unknown as QueuedDiscordTurnRow[];
    return rows.map(asQueuedTurnRecord);
  }

  async countQueuedTurns(sessionId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM discord_coding_queued_turns
      WHERE session_id = ? AND status = 'queued'
    `).get(sessionId) as { count: number };
    return row.count;
  }

  async enqueueTurn(input: {
    sessionId: string;
    ownerUserId: string;
    prompt: string | null;
    attachmentIds: string[];
    queuedAfterTurnId?: string | null;
  }) {
    const now = new Date().toISOString();
    const record: QueuedDiscordTurnRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      prompt: input.prompt,
      attachmentIds: [...input.attachmentIds],
      status: 'queued',
      queuedAfterTurnId: input.queuedAfterTurnId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO discord_coding_queued_turns (
        id,
        session_id,
        owner_user_id,
        prompt,
        attachment_ids_json,
        status,
        queued_after_turn_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.ownerUserId,
      record.prompt,
      serializeJson(record.attachmentIds),
      record.status,
      record.queuedAfterTurnId,
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  async claimNextQueuedTurn(sessionId: string) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT * FROM discord_coding_queued_turns
        WHERE session_id = ? AND status = 'queued'
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `).get(sessionId) as QueuedDiscordTurnRow | undefined;
      if (!row) {
        return null;
      }

      const updatedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE discord_coding_queued_turns
        SET status = 'starting',
            updated_at = ?
        WHERE id = ?
      `).run(updatedAt, row.id);

      return asQueuedTurnRecord({
        ...row,
        status: 'starting',
        updated_at: updatedAt,
      });
    });
  }

  async deleteQueuedTurn(sessionId: string, queuedTurnId: string) {
    const result = this.db.prepare(`
      DELETE FROM discord_coding_queued_turns
      WHERE id = ? AND session_id = ?
    `).run(queuedTurnId, sessionId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async deleteAllQueuedTurns(sessionId: string) {
    const result = this.db.prepare(`
      DELETE FROM discord_coding_queued_turns WHERE session_id = ? AND status = 'queued'
    `).run(sessionId) as { changes?: number };
    return result.changes ?? 0;
  }

  async resetQueuedTurnToQueued(sessionId: string, queuedTurnId: string) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE discord_coding_queued_turns
      SET status = 'queued',
          updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(updatedAt, queuedTurnId, sessionId);
    return this.getQueuedTurn(sessionId, queuedTurnId);
  }

  async getQueuedTurn(sessionId: string, queuedTurnId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_coding_queued_turns
      WHERE id = ? AND session_id = ?
    `).get(queuedTurnId, sessionId) as QueuedDiscordTurnRow | undefined;
    return row ? asQueuedTurnRecord(row) : null;
  }

  async recordInboundEvent(input: {
    id: string;
    botId: string;
    kind: string;
    channelId?: string | null;
    authorId?: string | null;
  }) {
    const row: DiscordInboundEventRow = {
      id: input.id,
      bot_id: input.botId,
      kind: input.kind,
      channel_id: input.channelId ?? null,
      author_id: input.authorId ?? null,
      created_at: new Date().toISOString(),
    };

    try {
      this.db.prepare(`
        INSERT INTO discord_inbound_events (
          id,
          bot_id,
          kind,
          channel_id,
          author_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.bot_id,
        row.kind,
        row.channel_id,
        row.author_id,
        row.created_at,
      );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  async createOutboxMessage(input: {
    botId: string;
    sessionId?: string | null;
    channelId?: string | null;
    turnId?: string | null;
    content: string;
  }) {
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
        id,
        bot_id,
        session_id,
        channel_id,
        turn_id,
        content,
        status,
        attempt_count,
        sent_message_id,
        last_error,
        created_at,
        updated_at
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

  async markOutboxSent(outboxId: string, sentMessageId: string | null) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE discord_outbox
      SET status = 'sent',
          attempt_count = attempt_count + 1,
          sent_message_id = ?,
          last_error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(sentMessageId, updatedAt, outboxId);
  }

  async markOutboxError(outboxId: string, message: string) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE discord_outbox
      SET status = 'error',
          attempt_count = attempt_count + 1,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(message, updatedAt, outboxId);
  }

  async getOutboxMessage(outboxId: string) {
    const row = this.db.prepare(`
      SELECT * FROM discord_outbox
      WHERE id = ?
    `).get(outboxId) as DiscordOutboxRow | undefined;
    return row ? asOutboxRecord(row) : null;
  }
}
