import {
  RemoteProtocolError, executionSessionSchema, executionSyncResultSchema,
  generateCanonicalId, parseClosed,
  redactRemoteConversationText,
  type ExecutionSession, type ExecutionSyncResult,
  executionHistoryEntrySchema,
} from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import { RemoteProjector, projectRemoteInteraction, remoteStableUuid } from './projection.js';
import type { RemoteDeviceRecord } from './device-store.js';
import { RemoteExecutionBindings, type RemoteExecutionBinding } from './execution-bindings.js';

export class RemoteExecutionJournal {
  constructor(private readonly db: Db, private readonly sessions: SessionManager, private readonly projector: RemoteProjector) {}

  register(sessionId: string, device: RemoteDeviceRecord): void {
    const accountId = this.account(device);
    const session = this.sessions.getSession(sessionId);
    if (session.task_id !== null) throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'execution must not belong to a remote Task');
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO remote_execution_exports
      (session_id, account_id, stream_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, accountId, generateCanonicalId(), Date.now());
    this.authorize(sessionId, device);
    if (inserted.changes) for (const event of this.sessions.listEvents(sessionId)) this.append(event);
  }

  contains(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM remote_execution_exports WHERE session_id = ?').get(sessionId));
  }

  authorize(sessionId: string, device: RemoteDeviceRecord): void {
    const accountId = this.account(device);
    const row = this.db.prepare('SELECT account_id FROM remote_execution_exports WHERE session_id = ?')
      .get(sessionId) as { account_id: string } | undefined;
    if (!row || row.account_id !== accountId) throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'execution is not available to this account');
  }

  session(sessionId: string, device: RemoteDeviceRecord): ExecutionSession {
    this.authorize(sessionId, device);
    const session = this.sessions.getSession(sessionId);
    const workspace = session.workspace_id ? this.db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined : undefined;
    return parseClosed(executionSessionSchema, {
      ...this.projector.projectSession(session, device.id),
      worktree_root: session.worktree_path ?? workspace?.path ?? '',
      session_config: {},
      turn_config: {},
      ...(session.turn_config_options ? { turn_config_options: session.turn_config_options.filter(option => !option.presentation?.sensitive) } : {}),
      context_tokens_used: session.context_tokens_used ?? null,
      context_window_tokens: session.context_window_tokens ?? null,
      context_usage_updated_at: session.context_usage_updated_at ?? null,
      conversation_input_tokens: session.conversation_input_tokens ?? null,
      conversation_output_tokens: session.conversation_output_tokens ?? null,
      conversation_cached_input_tokens: session.conversation_cached_input_tokens ?? null,
      conversation_total_tokens: session.conversation_total_tokens ?? null,
      conversation_usage_complete: session.conversation_usage_complete === 1,
    });
  }

  list(device: RemoteDeviceRecord, after?: string): { sessions: ExecutionSession[]; has_more: boolean } {
    const accountId = this.account(device);
    const rows = this.db.prepare(`SELECT e.session_id FROM remote_execution_exports e
      JOIN sessions s ON s.id = e.session_id WHERE e.account_id = ? AND s.archived = 0
      AND e.session_id > ? ORDER BY e.session_id LIMIT 101`).all(accountId, after ?? '') as Array<{ session_id: string }>;
    return { sessions: rows.slice(0, 100).map(row => this.session(row.session_id, device)), has_more: rows.length > 100 };
  }

  append(event: EventEnvelope): void {
    if (!this.contains(event.session_id)) return;
    const resolution = event.display?.type === 'interaction.resolved';
    const request = event.display?.type === 'interaction.approval' || event.display?.type === 'interaction.question';
    if (!resolution && !request && !this.projector.projectTranscriptEvent(event)) return;
    if (event.display?.type === 'message' && event.display.data.text.length > 8000) {
      const original = event.display.data;
      const text = redactRemoteConversationText(original.text);
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 8000, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
        this.append({ ...event, display: { type: 'message', data: { ...original,
          text: text.slice(offset, end), delta: offset === 0 ? original.delta : true } } });
        offset = end;
      }
      return;
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE remote_execution_exports SET sequence = sequence + 1 WHERE session_id = ?').run(event.session_id);
      const row = this.db.prepare('SELECT sequence FROM remote_execution_exports WHERE session_id = ?')
        .get(event.session_id) as { sequence: number };
      this.db.prepare('INSERT INTO remote_execution_events (session_id, sequence, event_json) VALUES (?, ?, ?)')
        .run(event.session_id, row.sequence, JSON.stringify(event));
    })();
  }

  sync(device: RemoteDeviceRecord, input: { session_id: string; after: number; stream_id?: string }): ExecutionSyncResult {
    this.authorize(input.session_id, device);
    const stream = this.db.prepare('SELECT stream_id, sequence FROM remote_execution_exports WHERE session_id = ?')
      .get(input.session_id) as { stream_id: string; sequence: number };
    if ((input.stream_id && input.stream_id !== stream.stream_id) || input.after > stream.sequence) {
      throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'execution history stream changed');
    }
    const rows = this.db.prepare(`SELECT sequence, event_json FROM remote_execution_events
      WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT 128`)
      .all(input.session_id, input.after) as Array<{ sequence: number; event_json: string }>;
    const events: ExecutionSyncResult['events'] = [];
    let size = 0;
    let cursor = input.after;
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as EventEnvelope;
      const item = this.projector.projectTranscriptEvent(event, device.id);
      const resolution = event.display?.type === 'interaction.resolved' ? event.display.data : null;
      const requested = event.display?.type === 'interaction.approval' || event.display?.type === 'interaction.question'
        ? event.display.data : null;
      const interaction = requested ? projectRemoteInteraction({
        id: requested.approvalId, sessionId: event.session_id,
        turnId: remoteStableUuid('remote-turn', `${event.session_id}:${event.turn}`), turnNumber: event.turn,
        status: 'pending', createdAt: event.ts, category: requested.category, risk: requested.risk,
        description: requested.description, subject: requested.subject, nativeOptions: requested.nativeOptions,
        payload: { ...requested },
      }, '0') : null;
      if (!item && !resolution && !interaction) throw new RemoteProtocolError('INVALID_FRAME', 'execution event cannot be projected');
      const entry = parseClosed(executionHistoryEntrySchema, interaction
        ? { sequence: row.sequence, interaction, turn: event.turn } : resolution
        ? { sequence: row.sequence, resolution: { interaction_id: resolution.approvalId,
          decision: resolution.decision, auto: resolution.auto, turn: event.turn, ts: event.ts,
          ...(resolution.answers ? { answers: resolution.answers } : {}) } }
        : { sequence: row.sequence, item });
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (events.length && size + bytes > 192 * 1024) break;
      size += bytes;
      events.push(entry);
      cursor = row.sequence;
    }
    const interactions = this.sessions.listPendingApprovals().filter(item => item.sessionId === input.session_id)
      .map(item => {
        const row = this.db.prepare('SELECT resource_revision FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?')
          .get(item.sessionId, item.id) as { resource_revision: number } | undefined;
        return projectRemoteInteraction(item, String(row?.resource_revision ?? 0));
      });
    return parseClosed(executionSyncResultSchema, {
      stream_id: stream.stream_id, cursor, has_more: cursor < stream.sequence,
      session: this.session(input.session_id, device), events, interactions,
    });
  }

  private account(device: RemoteDeviceRecord): string {
    if (!device.accountId || device.revokedAt) throw new RemoteProtocolError('AUTH_REQUIRED', 'verified account required');
    return device.accountId;
  }
}

export class RemoteExecutionReplicas {
  private readonly bindings: RemoteExecutionBindings;
  constructor(private readonly db: Db) { this.bindings = new RemoteExecutionBindings(db); }

  snapshot(localSessionId: string): ExecutionSyncResult | null {
    const row = this.db.prepare('SELECT snapshot_json FROM remote_execution_replicas WHERE local_session_id = ?')
      .get(localSessionId) as { snapshot_json: string } | undefined;
    return row ? parseClosed(executionSyncResultSchema, JSON.parse(row.snapshot_json)) : null;
  }

  apply(binding: RemoteExecutionBinding, value: unknown): ExecutionSyncResult {
    const incoming = parseClosed(executionSyncResultSchema, value);
    return this.db.transaction(() => {
      this.bindings.assertCurrent(binding);
      if (incoming.session.id !== binding.target.remote_session_id) throw new RemoteProtocolError('INVALID_FRAME', 'cross-session replica');
      const previous = this.snapshot(binding.local_session_id);
      if (previous && previous.stream_id !== incoming.stream_id) throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'replica stream changed');
      let cursor = previous?.cursor ?? 0;
      if (incoming.cursor < cursor) throw new RemoteProtocolError('PRECONDITION_FAILED', 'stale history response');
      for (const event of incoming.events) {
        if (event.sequence <= cursor) continue;
        if (event.sequence !== cursor + 1) throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'replica event gap');
        cursor = event.sequence;
      }
      if (cursor !== incoming.cursor) throw new RemoteProtocolError('INVALID_FRAME', 'invalid history cursor');
      // The saved checkpoint excludes event bodies; the append-only rows own history.
      const snapshot = { ...incoming, events: [] };
      this.db.prepare(`INSERT INTO remote_execution_replicas (local_session_id, stream_id, cursor, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(local_session_id) DO UPDATE SET
        cursor = excluded.cursor, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`)
        .run(binding.local_session_id, incoming.stream_id, cursor, JSON.stringify(snapshot), Date.now());
      for (const event of incoming.events) {
        this.db.prepare(`INSERT OR IGNORE INTO remote_execution_replica_events
          (local_session_id, sequence, item_json) VALUES (?, ?, ?)`)
          .run(binding.local_session_id, event.sequence, JSON.stringify(event));
        const turn = 'item' in event ? event.item.turn : 'interaction' in event ? event.turn : event.resolution.turn;
        const ts = 'item' in event ? event.item.ts : 'interaction' in event ? Date.parse(event.interaction.created_at) : event.resolution.ts;
        if (turn <= 0) continue;
        const id = localRemoteTurnId(binding.local_session_id, turn);
        this.db.prepare(`INSERT OR IGNORE INTO turns (id, session_id, turn_number, status, created_at)
          VALUES (?, ?, ?, 'running', ?)`).run(id, binding.local_session_id, turn, new Date(ts).toISOString());
        if ('item' in event && event.item.kind === 'turn-end') {
          const status = event.item.outcome === 'worked' ? 'completed' : event.item.outcome === 'stopped' ? 'stopped' : 'error';
          this.db.prepare('UPDATE turns SET status = ?, completed_at = ? WHERE id = ?')
            .run(status, new Date(ts).toISOString(), id);
        }
      }
      if (incoming.session.active_turn) {
        const turn = incoming.session.active_turn.turn_number;
        this.db.prepare(`INSERT OR IGNORE INTO turns (id, session_id, turn_number, status, created_at)
          VALUES (?, ?, ?, 'running', ?)`).run(localRemoteTurnId(binding.local_session_id, turn), binding.local_session_id, turn, incoming.session.updated_at);
      }
      return incoming;
    })();
  }

  items(localSessionId: string): ExecutionSyncResult['events'] {
    return (this.db.prepare('SELECT sequence, item_json FROM remote_execution_replica_events WHERE local_session_id = ? ORDER BY sequence')
      .all(localSessionId) as Array<{ sequence: number; item_json: string }>).map(row => parseClosed(executionHistoryEntrySchema, JSON.parse(row.item_json)));
  }
}

export function localRemoteTurnId(localSessionId: string, turn: number): string {
  return remoteStableUuid('remote-execution-turn', `${localSessionId}:${turn}`);
}
