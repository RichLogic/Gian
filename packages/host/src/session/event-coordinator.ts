import { createHash, randomUUID } from 'node:crypto';
import type {
  AttentionMessage,
  ChatEvent,
  ConfigOption,
  EventEnvelope,
  ExecutorConfigState,
  InputItem,
  MessageContextItem,
  NativeConfigOption,
  ProxyNotification,
  Session,
  SessionErrorData,
  SessionStatus,
} from '@gian/shared';
import {
  ProxyProtocolError,
  canonicalFingerprint,
  protocolViolation,
  proxyNotificationSchema,
  replayEventSchemaUnion,
  type ProxyNotification as ProtocolNotification,
  type ReplayEvent,
} from '@gian/proxy-protocol';
import type { ApprovalManager } from '../approval/index.js';
import { projectNotification } from '../event/index.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { QueueManager } from '../queue/index.js';
import type { Db } from '../storage/db.js';
import { TraceEvidenceStore } from '../trace/evidence-store.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { listGitWorktreesAsync } from '../workspace/git.js';
import { detectWorktreeAddPath } from './worktree-detect.js';
import { type SessionRepository } from './repository.js';
import type { SessionHistoryStore } from './history-store.js';
import type { ActiveTurn, TurnRuntime } from './turn-runtime.js';
import type { AutoTitleService } from './auto-title.js';
import type { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import {
  parseTokenUsageUpdate,
  type ParsedTokenUsageUpdate,
} from './token-usage.js';
import { kimiContentText } from './input-items.js';
import { AttentionDispatcher } from './attention.js';

export {
  ATTENTION_BODY_MAX_BYTES,
  ATTENTION_TITLE_MAX_BYTES,
  attentionMessageForEvent,
} from './attention.js';

function isReplaceableSnapshot(event: ChatEvent): boolean {
  if (event.event === 'diff.updated') return true;
  if (
    event.display?.type === 'state.turn-started'
    || event.display?.type === 'state.turn-completed'
  ) return true;
  if (event.event === 'codex.agent' && event.display?.type === 'agent') return true;
  if (event.event !== 'acp.sessionUpdate') return false;
  const update = event.data.update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const kind = (update as Record<string, unknown>).sessionUpdate;
  return kind === 'tool_call' || kind === 'tool_call_update';
}

function notificationProviderTurnId(notification: ProxyNotification): string | null {
  const params = notification.params as { sourceTurnId?: unknown; turnId?: unknown } | undefined;
  const value = params?.sourceTurnId ?? params?.turnId;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function replayEventAsNotification(event: ReplayEvent): ProtocolNotification {
  return {
    jsonrpc: '2.0',
    method: event.method,
    params: {
      eventId: event.eventId,
      streamId: event.replayStreamId,
      sequence: event.sequence,
      sessionId: event.sessionId,
      turnId: event.sourceTurnId,
      sourceTurnId: event.sourceTurnId,
      emittedAt: event.emittedAt,
      data: event.data,
    },
  } as ProtocolNotification;
}

function protocolEventPayloadHash(notification: ProtocolNotification): string {
  return createHash('sha256').update(JSON.stringify({
    method: notification.method,
    fingerprint: canonicalFingerprint(notification),
    ...('turnId' in notification.params ? { turnId: notification.params.turnId } : {}),
    emittedAt: notification.params.emittedAt,
    data: notification.params.data,
  })).digest('hex');
}

const SNAPSHOT_FLUSH_MS = 120;

interface EventCoordinatorCallbacks {
  sendMessage: (
    sessionId: string,
    text: string,
    items?: InputItem[],
    toolRequestId?: string,
    contextItems?: MessageContextItem[],
    composerDocument?: import('@gian/shared').ComposerDocument,
  ) => Promise<unknown>;
  onInteractionResolved?: (interactionId: string) => void;
}

export class SessionEventCoordinator {
  private eventSubscribers: Array<(event: ChatEvent) => void> = [];
  private conversationUsageTurns = new Map<string, Set<string>>();
  private pendingSnapshots = new Map<string, {
    event: ChatEvent;
    turnId: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private pendingWorktreeDetectionCommands = new Map<string, string>();
  private activeWorktreeDetections = new Set<string>();
  private replayRefreshes = new Map<string, Promise<void>>();
  private replayRefreshDirty = new Set<string>();
  private replayRetryAttempts = new Map<string, number>();
  private replayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private replayRefreshCancelled = new Set<string>();
  private attention: AttentionDispatcher;
  private traceEvidence: TraceEvidenceStore;

  constructor(
    private db: Db,
    private sessions: SessionRepository,
    private history: SessionHistoryStore,
    private turns: TurnRuntime,
    private broadcaster: WsBroadcaster,
    private approvals: ApprovalManager,
    private queue: QueueManager,
    private watcher: NativeJsonlWatcher | null,
    private proxySessions: ProxySessionCoordinator,
    private autoTitle: AutoTitleService,
    private callbacks: EventCoordinatorCallbacks,
    attention?: AttentionDispatcher,
  ) {
    this.attention = attention ?? new AttentionDispatcher(broadcaster);
    this.traceEvidence = new TraceEvidenceStore(db);
  }

  onEvent(subscriber: (event: ChatEvent) => void): () => void {
    this.eventSubscribers.push(subscriber);
    return () => {
      const index = this.eventSubscribers.indexOf(subscriber);
      if (index !== -1) this.eventSubscribers.splice(index, 1);
    };
  }

  forgetConversationUsage(sessionId: string): void {
    this.conversationUsageTurns.delete(sessionId);
    this.replayRefreshDirty.delete(sessionId);
    this.replayRetryAttempts.delete(sessionId);
    const retry = this.replayRetryTimers.get(sessionId);
    if (retry) clearTimeout(retry);
    this.replayRetryTimers.delete(sessionId);
    if (this.replayRefreshes.has(sessionId)) this.replayRefreshCancelled.add(sessionId);
  }

  persistTurnConfigOptions(
    sessionId: string,
    options: ConfigOption[],
    revision: string,
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE sessions
          SET turn_config_options_json = ?, turn_config_revision = ?, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(options), revision, now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      turn_config_options: options,
      turn_config_revision: revision,
      updated_at: now,
    });
  }

  persistNativeConfigSnapshot(
    sessionId: string,
    state: ExecutorConfigState,
    options: NativeConfigOption[],
  ): void {
    const now = new Date().toISOString();
    this.sessions.setNativeOptions(sessionId, options);
    this.db
      .prepare('UPDATE sessions SET executor_config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), now, sessionId);
    this.broadcaster.broadcast({
      type: 'session:native-config',
      session_id: sessionId,
      state,
      options,
    });
    this.broadcastSessionUpdated(sessionId, {
      executor_config: state,
      native_config_options: options,
      updated_at: now,
    });
  }

  persistKimiReplay(
    sessionId: string,
    updates: unknown[],
    timestamp: string,
    replayStreamId?: string,
  ): { turns: number; events: number } {
    if (updates.length === 0) return { turns: 0, events: 0 };
    const replay = updates.map((update) => replayEventSchemaUnion.safeParse(update));
    if (replay.every((parsed) => parsed.success)) {
      return this.persistProtocolV1Replay(
        sessionId,
        replay.map((parsed) => replayEventAsNotification(parsed.data)),
        timestamp,
        false,
        replayStreamId,
      );
    }
    const standard = updates.map((update) => proxyNotificationSchema.safeParse(update));
    if (standard.every((parsed) => parsed.success)) {
      return this.persistProtocolV1Replay(
        sessionId,
        standard.map((parsed) => parsed.data),
        timestamp,
        false,
        replayStreamId,
      );
    }

    let turnNumber = 0;
    let turnId: string | null = null;
    let eventCount = 0;
    let pendingUserText = '';

    const insert = (
      activeTurnId: string,
      callId: string,
      type: string,
      data: Record<string, unknown>,
      replaceSnapshot = false,
    ): void => {
      const result = this.history.appendEvent(
        sessionId,
        activeTurnId,
        callId,
        type,
        data,
        { replaceSnapshot, createdAt: timestamp },
      );
      if (result.inserted) eventCount += 1;
    };

    const lifecycleData = (
      activeTurnId: string,
      status: 'running' | 'completed',
      type: 'state.turn-started' | 'state.turn-completed',
    ): Record<string, unknown> => ({
      __gian_event: 2,
      provider: 'kimi',
      raw: { turnId: activeTurnId, status },
      display: { type, data: { turnId: activeTurnId } },
    });

    const ensureTurn = (): string => {
      if (turnId) return turnId;
      turnNumber += 1;
      turnId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO turns
            (id, session_id, turn_number, status, created_at, completed_at)
           VALUES (?, ?, ?, 'completed', ?, ?)`,
        )
        .run(turnId, sessionId, turnNumber, timestamp, timestamp);
      insert(
        turnId,
        `gian:turn-started:${turnId}`,
        'gian.turn.started',
        lifecycleData(turnId, 'running', 'state.turn-started'),
      );
      return turnId;
    };

    const finalizeTurn = (): void => {
      if (!turnId) return;
      const completedTurnId = turnId;
      this.history.compactTurnStreams(completedTurnId);
      insert(
        completedTurnId,
        `gian:turn-completed:${completedTurnId}`,
        'gian.turn.completed',
        lifecycleData(completedTurnId, 'completed', 'state.turn-completed'),
      );
      turnId = null;
    };

    const flushUserMessage = (): void => {
      if (!pendingUserText) return;
      finalizeTurn();
      insert(ensureTurn(), randomUUID(), 'user_message', { text: pendingUserText });
      pendingUserText = '';
    };

    for (const raw of updates) {
      if (!raw || typeof raw !== 'object') continue;
      const notification = raw as { update?: unknown };
      if (!notification.update || typeof notification.update !== 'object') continue;
      const update = notification.update as Record<string, unknown>;
      const kind = update.sessionUpdate;
      if (kind === 'config_option_update' || kind === 'available_commands_update') {
        continue;
      }
      if (kind === 'user_message_chunk') {
        const text = kimiContentText(update.content);
        if (!text) continue;
        // ACP history is chunked. Coalesce consecutive chunks so one original
        // user message becomes one Gian transcript row and one turn boundary.
        pendingUserText += text;
        continue;
      }

      flushUserMessage();
      const activeTurnId = ensureTurn();
      const projected = projectNotification(
        'kimi',
        {
          method: 'acp.sessionUpdate',
          params: {
            sessionId,
            turnId: activeTurnId,
            data: { update },
          },
        },
        sessionId,
        turnNumber,
      );
      for (const event of projected) {
        insert(
          activeTurnId,
          event.call_id,
          event.event,
          {
            __gian_event: 2,
            provider: event.provider,
            raw: event.data,
            ...(event.display ? { display: event.display } : {}),
          },
          isReplaceableSnapshot(event),
        );
      }
    }
    flushUserMessage();
    finalizeTurn();

    if (turnNumber > 0) {
      this.db
        .prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`)
        .run(sessionId);
    }
    return { turns: turnNumber, events: eventCount };
  }

  private persistProtocolV1Replay(
    sessionId: string,
    notifications: ProtocolNotification[],
    fallbackTimestamp: string,
    broadcast = false,
    replayStreamId?: string,
  ): { turns: number; events: number } {
    const broadcasts: Array<{
      event: ChatEvent;
      turnId: string;
      attentionEligible: boolean;
    }> = [];
    const persist = this.db.transaction(() => this.persistProtocolV1ReplayTransaction(
      sessionId,
      notifications,
      fallbackTimestamp,
      broadcast ? broadcasts : null,
      replayStreamId,
    ));
    const result = persist();
    for (const item of broadcasts) {
      this.broadcastChatEvent(
        item.event,
        item.turnId,
        item.attentionEligible && !result.rebuilt,
      );
    }
    if (broadcast && result.rebuilt) {
      this.broadcaster.broadcast({ type: 'session:history-rebuilt', session_id: sessionId });
    }
    return { turns: result.turns, events: result.events };
  }

  private persistProtocolV1ReplayTransaction(
    sessionId: string,
    notifications: ProtocolNotification[],
    fallbackTimestamp: string,
    broadcasts: Array<{
      event: ChatEvent;
      turnId: string;
      attentionEligible: boolean;
    }> | null,
    replayStreamId?: string,
  ): { turns: number; events: number; rebuilt: boolean } {
    const provider = this.sessions.get(sessionId).executor;
    const turns = new Map<string, {
      id: string;
      number: number;
      inserted: boolean;
      replayOwned: boolean;
    }>();
    let turnCount = 0;
    let eventCount = 0;
    let rebuilt = false;

    if (replayStreamId) {
      const current = this.db.prepare(
        'SELECT replay_stream_id FROM proxy_replay_streams WHERE session_id = ?',
      ).get(sessionId) as { replay_stream_id: string } | undefined;
      if (current && current.replay_stream_id !== replayStreamId) {
        const deleted = this.db.prepare(
          `DELETE FROM turns
           WHERE id IN (
             SELECT turn_id FROM proxy_replay_turns
             WHERE session_id = ? AND replay_owned = 1
           )`,
        ).run(sessionId);
        rebuilt = deleted.changes > 0;
      }
      this.db.prepare(
        `INSERT INTO proxy_replay_streams (session_id, replay_stream_id)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET replay_stream_id = excluded.replay_stream_id`,
      ).run(sessionId, replayStreamId);
    }

    const ensureTurn = (providerTurnId: string, createdAt: string) => {
      const existing = turns.get(providerTurnId);
      if (existing) return existing;
      const persisted = this.db.prepare(
        `SELECT replay.turn_id AS id, turns.turn_number AS number,
                replay.replay_owned AS replay_owned
         FROM proxy_replay_turns replay
         JOIN turns ON turns.id = replay.turn_id
         WHERE replay.session_id = ? AND replay.provider_turn_id = ?`,
      ).get(sessionId, providerTurnId) as {
        id: string;
        number: number;
        replay_owned: number;
      } | undefined;
      if (persisted) {
        const turn = {
          id: persisted.id,
          number: persisted.number,
          inserted: false,
          replayOwned: persisted.replay_owned === 1,
        };
        turns.set(providerTurnId, turn);
        return turn;
      }
      const latest = this.db.prepare(
        'SELECT COALESCE(MAX(turn_number), 0) AS number FROM turns WHERE session_id = ?',
      ).get(sessionId) as { number: number };
      const turn = {
        id: randomUUID(),
        number: latest.number + 1,
        inserted: true,
        replayOwned: true,
      };
      this.db
        .prepare(
          `INSERT INTO turns
            (id, session_id, turn_number, status, created_at, completed_at)
           VALUES (?, ?, ?, 'completed', ?, ?)`,
        )
        .run(turn.id, sessionId, turn.number, createdAt, createdAt);
      this.db.prepare(
        `INSERT INTO proxy_replay_turns
          (session_id, provider_turn_id, turn_id)
         VALUES (?, ?, ?)`,
      ).run(sessionId, providerTurnId, turn.id);
      turns.set(providerTurnId, turn);
      turnCount += 1;
      return turn;
    };

    for (const notification of notifications) {
      if (!('sessionId' in notification.params)) continue;
      if (notification.params.sessionId !== sessionId) continue;
      if (!('turnId' in notification.params)) continue;

      // Canonical Trace evidence: idempotent by (session_id, event_id), so
      // replaying already-persisted events backfills rows written before the
      // Trace slice shipped without creating duplicates.
      this.traceEvidence.persist(notification);

      const createdAt = notification.params.emittedAt || fallbackTimestamp;
      const payloadHash = protocolEventPayloadHash(notification);
      const existingEvent = this.db.prepare(
        `SELECT payload_sha256
         FROM proxy_replay_events
         WHERE session_id = ? AND event_id = ?`,
      ).get(sessionId, notification.params.eventId) as { payload_sha256: string } | undefined;
      if (existingEvent) {
        if (existingEvent.payload_sha256 !== payloadHash) {
          throw protocolViolation(
            `Proxy replay event ${notification.params.eventId} changed after persistence.`,
          );
        }
        continue;
      }
      const turn = ensureTurn(notification.params.turnId, createdAt);
      // Gian already persists the input before starting a live turn. Replay
      // later confirms that input, but must not render it a second time.
      const projected = notification.method === 'input.recorded' && !turn.replayOwned
        ? []
        : projectNotification(
            provider,
            notification as unknown as ProxyNotification,
            sessionId,
            turn.number,
          );
      for (const event of projected) {
        const result = this.history.appendEvent(
          sessionId,
          turn.id,
          event.call_id,
          event.event,
          {
            __gian_event: 2,
            provider: event.provider,
            raw: event.data,
            ...(event.display ? { display: event.display } : {}),
          },
          { replaceSnapshot: isReplaceableSnapshot(event), createdAt },
        );
        if (result.inserted) {
          eventCount += 1;
          broadcasts?.push({
            event,
            turnId: turn.id,
            // Replay-owned turns originate outside this Host process. A
            // newly appended tail is live work and may need attention;
            // Gian-owned turns were already notified by their stdio path.
            attentionEligible: turn.replayOwned,
          });
        }
      }
      this.db.prepare(
        `INSERT INTO proxy_replay_events
          (session_id, event_id, turn_id, payload_sha256)
         VALUES (?, ?, ?, ?)`,
      ).run(sessionId, notification.params.eventId, turn.id, payloadHash);
    }

    for (const turn of turns.values()) this.history.compactTurnStreams(turn.id);
    if (notifications.length > 0) {
      this.db.prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`).run(sessionId);
    }
    return { turns: turnCount, events: eventCount, rebuilt };
  }

  private persistTokenUsage(
    sessionId: string,
    turnId: string | undefined,
    update: ParsedTokenUsageUpdate,
  ): void {
    const session = this.sessions.get(sessionId);
    const now = new Date().toISOString();
    let contextUsed = session.context_tokens_used ?? null;
    let contextWindow = session.context_window_tokens ?? null;
    let contextUpdatedAt = session.context_usage_updated_at ?? null;
    let conversationInput = session.conversation_input_tokens ?? null;
    let conversationOutput = session.conversation_output_tokens ?? null;
    let conversationCached = session.conversation_cached_input_tokens ?? null;
    let conversationTotal = session.conversation_total_tokens ?? null;
    let conversationComplete = session.conversation_usage_complete ?? 0;
    let changed = false;

    if (update.hasContext) {
      contextUpdatedAt = now;
      if (update.context === null) {
        // Preserve the known window while compacting; only the numerator is
        // stale. The next real provider sample replaces it.
        contextUsed = null;
      } else if (update.context) {
        contextUsed = update.context.used;
        if (update.context.window !== undefined) {
          contextWindow = update.context.window;
        }
      }
      changed = true;
    }

    const conversation = update.conversation;
    let applyConversation = Boolean(conversation);
    if (conversation?.mode === 'delta' && turnId) {
      let turns = this.conversationUsageTurns.get(sessionId);
      if (!turns) {
        turns = new Set<string>();
        this.conversationUsageTurns.set(sessionId, turns);
      }
      if (turns.has(turnId)) {
        applyConversation = false;
      } else {
        turns.add(turnId);
      }
    }

    if (conversation && applyConversation) {
      const input = conversation.inputTokens ?? 0;
      const output = conversation.outputTokens ?? 0;
      const cached = conversation.cachedInputTokens ?? 0;
      const total = conversation.totalTokens ?? input + output;
      if (conversation.mode === 'reset') {
        conversationInput = null;
        conversationOutput = null;
        conversationCached = null;
        conversationTotal = null;
        conversationComplete = 1;
      } else if (conversation.mode === 'absolute') {
        conversationInput = input;
        conversationOutput = output;
        conversationCached = cached;
        conversationTotal = total;
        conversationComplete = 1;
      } else {
        conversationInput = (conversationInput ?? 0) + input;
        conversationOutput = (conversationOutput ?? 0) + output;
        conversationCached = (conversationCached ?? 0) + cached;
        conversationTotal = (conversationTotal ?? 0) + total;
      }
      changed = true;
    }

    if (!changed) return;

    this.db
      .prepare(
        `UPDATE sessions
         SET context_tokens_used = @context_tokens_used,
             context_window_tokens = @context_window_tokens,
             context_usage_updated_at = @context_usage_updated_at,
             conversation_input_tokens = @conversation_input_tokens,
             conversation_output_tokens = @conversation_output_tokens,
             conversation_cached_input_tokens = @conversation_cached_input_tokens,
             conversation_total_tokens = @conversation_total_tokens,
             conversation_usage_complete = @conversation_usage_complete
         WHERE id = @id`,
      )
      .run({
        id: sessionId,
        context_tokens_used: contextUsed,
        context_window_tokens: contextWindow,
        context_usage_updated_at: contextUpdatedAt,
        conversation_input_tokens: conversationInput,
        conversation_output_tokens: conversationOutput,
        conversation_cached_input_tokens: conversationCached,
        conversation_total_tokens: conversationTotal,
        conversation_usage_complete: conversationComplete,
      });
    this.broadcastSessionUpdated(sessionId, {
      context_tokens_used: contextUsed,
      context_window_tokens: contextWindow,
      context_usage_updated_at: contextUpdatedAt,
      conversation_input_tokens: conversationInput,
      conversation_output_tokens: conversationOutput,
      conversation_cached_input_tokens: conversationCached,
      conversation_total_tokens: conversationTotal,
      conversation_usage_complete: conversationComplete as 0 | 1,
    });
  }

  handleNotification(
    sessionId: string,
    notification: ProxyNotification,
  ): void {
    const sidechat = this.db.prepare(
      'SELECT 1 FROM sidechat_transients WHERE sidechat_id = ?',
    ).get(sessionId);
    if (sidechat) return;
    const providerTurnId = notificationProviderTurnId(notification);
    const runtimeErrorHasTurn = notification.method === 'runtime.error'
      && providerTurnId !== null;
    if (
      notification.method === 'turn.completed'
      || notification.method === 'turn.failed'
      || runtimeErrorHasTurn
    ) {
      this.flushSnapshots(sessionId);
    }
    // session.rotated: cc-proxy emits this when /clear creates a new native
    // session. Pure host-internal: update sessions.native_session_id and
    // broadcast session:updated. Don't surface as a transcript event.
    if (notification.method === 'session.rotated') {
      this.handleSessionRotated(sessionId, notification);
      return;
    }
    if (notification.method === 'catalog.changed') {
      void this.proxySessions.refreshCatalog(sessionId);
      return;
    }
    if (notification.method === 'history.changed') {
      this.refreshProtocolReplay(sessionId);
      return;
    }
    if (notification.method === 'runtime.error' && !runtimeErrorHasTurn) {
      this.persistLiveSessionStatus(sessionId, 'error');
      return;
    }
    if (notification.method === 'session.updated') {
      const data = notification.params?.data as
        | {
            nativeSession?: { id?: unknown };
            state?: 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';
            lastError?: string | null;
            turnConfigOptions?: ConfigOption[];
            turnConfigRevision?: string;
            availableActions?: Record<string, { enabled: boolean; reason?: string }>;
          }
        | undefined;
      const nativeSessionId = data?.nativeSession?.id;
      if (typeof nativeSessionId === 'string' && nativeSessionId) {
        this.handleSessionRotated(sessionId, notification, nativeSessionId, false);
      }
      if (data?.state) {
        const status: SessionStatus | null = data.state === 'running'
          ? 'running'
          : data.state === 'waiting_interaction'
            ? 'pending'
            : data.state === 'stale' || data.state === 'error'
              ? 'error'
              : this.turns.has(sessionId) ? null : 'done';
        if (status) this.persistLiveSessionStatus(sessionId, status);
      }
      if (
        data?.turnConfigOptions !== undefined
        && typeof data.turnConfigRevision === 'string'
        && data.turnConfigRevision.length > 0
      ) {
        this.persistTurnConfigOptions(
          sessionId,
          data.turnConfigOptions,
          data.turnConfigRevision,
        );
      }
      if (data?.availableActions !== undefined) {
        const now = new Date().toISOString();
        this.db.prepare(
          'UPDATE sessions SET available_actions_json = ?, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(data.availableActions), now, sessionId);
        this.broadcastSessionUpdated(sessionId, {
          available_actions: data.availableActions,
          updated_at: now,
        });
      }
      return;
    }

    // Usage is session accounting rather than transcript content. Codex can
    // legitimately report a short-lived compaction turn id inside one outer
    // Host turn, so do not use these samples to establish generation binding.
    if (notification.method === 'token_usage.updated' || notification.method === 'usage.updated') {
      const session = this.sessions.get(sessionId);
      const update = parseTokenUsageUpdate(notification.params?.data, session.executor);
      if (update) this.persistTokenUsage(sessionId, providerTurnId ?? undefined, update);
      return;
    }

    // Bind every provider-scoped notification to one Host turn generation.
    // Settled provider ids are tombstoned, so an old output/tool/end arriving
    // after a stop cannot attach itself to the next active turn.
    const active = this.turns.get(sessionId);
    if (providerTurnId) {
      if (!active || !this.turns.bindProviderTurn(sessionId, active.id, providerTurnId)) {
        return;
      }
    }
    if (notification.method === 'runtime.error' && !runtimeErrorHasTurn) return;

    // Transcript events require a real persisted turn. Provider callbacks can
    // arrive after a local stop (or host-level runtime.error can be fanned out
    // while idle); dropping those stale diagnostics is safer than inventing a
    // random turn id that violates the events.turn_id foreign key.
    if (!active) return;

    // Project/dispatch BEFORE handleLifecycle. handleLifecycle calls
    // completeTurn on turn.completed/failed, which deletes the activeTurns
    // map entry, so both projection and persistence use the captured active
    // turn rather than re-reading mutable lifecycle state.
    const standard = proxyNotificationSchema.safeParse(notification);
    if (standard.success) {
      try {
        this.persistProtocolV1LiveEvent(sessionId, standard.data, active);
      } catch (error) {
        if (!(error instanceof ProxyProtocolError)) throw error;
        console.error(`[proxy-live] ${sessionId} protocol fault`, error);
        if (error.faultClass === 'session') this.proxySessions.quarantine(sessionId, error);
        else if (error.fatal) this.proxySessions.abort(sessionId);
        else throw error;
        return;
      }
    } else {
      const events = this.runProjector(sessionId, notification, active.number);
      for (const event of events) this.dispatchChatEvent(event, active.id);
    }

    this.handleLifecycle(sessionId, notification);
  }

  private persistProtocolV1LiveEvent(
    sessionId: string,
    notification: ProtocolNotification,
    active: ActiveTurn,
  ): boolean {
    if (!('turnId' in notification.params)) return true;
    const providerTurnId = notification.params.sourceTurnId;
    const eventId = notification.params.eventId;
    const payloadHash = protocolEventPayloadHash(notification);
    const existing = this.db.prepare(
      `SELECT payload_sha256
       FROM proxy_replay_events
       WHERE session_id = ? AND event_id = ?`,
    ).get(sessionId, eventId) as { payload_sha256: string } | undefined;
    if (existing) {
      if (existing.payload_sha256 !== payloadHash) {
        throw protocolViolation(
          `Proxy live event ${eventId} changed after persistence.`,
        );
      }
      return false;
    }

    const events = this.runProjector(
      sessionId,
      notification as unknown as ProxyNotification,
      active.number,
    );
    const persistedEvents: Array<{ event: ChatEvent; inserted: boolean }> = [];
    const persist = this.db.transaction(() => {
      const mapped = this.db.prepare(
        `SELECT turn_id
         FROM proxy_replay_turns
         WHERE session_id = ? AND provider_turn_id = ?`,
      ).get(sessionId, providerTurnId) as { turn_id: string } | undefined;
      if (mapped && mapped.turn_id !== active.id) {
        throw protocolViolation(
          `Proxy turn ${providerTurnId} changed Host turn ownership.`,
        );
      }
      if (!mapped) {
        const hostMapping = this.db.prepare(
          `SELECT provider_turn_id, replay_owned
           FROM proxy_replay_turns
           WHERE session_id = ? AND turn_id = ?`,
        ).get(sessionId, active.id) as {
          provider_turn_id: string;
          replay_owned: number;
        } | undefined;
        if (
          hostMapping
          && hostMapping.provider_turn_id === active.id
          && hostMapping.replay_owned === 0
        ) {
          // sendMessage reserves the Host turn before the Provider has exposed
          // its native sourceTurnId. Replace that provisional identity on the
          // first canonical live event so Fork anchors use the Provider boundary.
          this.db.prepare(
            `UPDATE proxy_replay_turns
             SET provider_turn_id = ?
             WHERE session_id = ? AND turn_id = ?`,
          ).run(providerTurnId, sessionId, active.id);
        } else if (hostMapping) {
          throw protocolViolation(
            `Host turn ${active.id} changed Proxy turn identity.`,
          );
        } else {
          this.db.prepare(
            `INSERT INTO proxy_replay_turns
              (session_id, provider_turn_id, turn_id, replay_owned)
             VALUES (?, ?, ?, 0)`,
          ).run(sessionId, providerTurnId, active.id);
        }
      }
      for (const event of events) {
        const result = this.history.appendEvent(
          sessionId,
          active.id,
          event.call_id,
          event.event,
          {
            __gian_event: 2,
            provider: event.provider,
            raw: event.data,
            ...(event.display ? { display: event.display } : {}),
          },
          { replaceSnapshot: isReplaceableSnapshot(event) },
        );
        persistedEvents.push({ event, inserted: result.inserted });
      }
      this.db.prepare(
        `INSERT INTO proxy_replay_events
          (session_id, event_id, turn_id, payload_sha256)
         VALUES (?, ?, ?, ?)`,
      ).run(sessionId, eventId, active.id, payloadHash);
      // Canonical Trace evidence: idempotent by (session_id, event_id).
      this.traceEvidence.persist(notification);
    });
    persist();
    for (const item of persistedEvents) {
      this.broadcastChatEvent(item.event, active.id, item.inserted);
    }
    return true;
  }

  private refreshProtocolReplay(sessionId: string): void {
    if (this.replayRefreshCancelled.has(sessionId)) return;
    if (this.replayRefreshes.has(sessionId)) {
      this.replayRefreshDirty.add(sessionId);
      return;
    }
    const retryTimer = this.replayRetryTimers.get(sessionId);
    if (retryTimer) clearTimeout(retryTimer);
    this.replayRetryTimers.delete(sessionId);
    let fatal = false;
    let transientFailure = false;
    const pending = this.proxySessions.replay(sessionId).then(replay => {
      const parsed = replay.events.map((update) => replayEventSchemaUnion.safeParse(update));
      const invalid = parsed.find((result) => !result.success);
      if (invalid && !invalid.success) {
        throw protocolViolation(`Proxy replay returned an invalid event: ${invalid.error.message}`);
      }
      const notifications = parsed.flatMap((result) => (
        result.success ? [replayEventAsNotification(result.data)] : []
      ));
      this.persistProtocolV1Replay(
        sessionId,
        notifications,
        new Date().toISOString(),
        true,
        replay.replayStreamId,
      );
      this.replayRetryAttempts.delete(sessionId);
    }).catch(error => {
      console.error(`[proxy-replay] ${sessionId} refresh failed`, error);
      fatal = error instanceof ProxyProtocolError && error.fatal;
      if (error instanceof ProxyProtocolError && error.faultClass === 'session') {
        this.proxySessions.quarantine(sessionId, error);
      } else if (fatal) this.proxySessions.abort(sessionId);
      else transientFailure = true;
    }).finally(() => {
      if (this.replayRefreshes.get(sessionId) === pending) {
        this.replayRefreshes.delete(sessionId);
      }
      if (this.replayRefreshCancelled.delete(sessionId)) return;
      const dirty = this.replayRefreshDirty.delete(sessionId);
      if (dirty && !fatal) {
        this.refreshProtocolReplay(sessionId);
        return;
      }
      if (transientFailure) this.scheduleProtocolReplayRetry(sessionId);
    });
    this.replayRefreshes.set(sessionId, pending);
  }

  private scheduleProtocolReplayRetry(sessionId: string): void {
    const attempt = (this.replayRetryAttempts.get(sessionId) ?? 0) + 1;
    this.replayRetryAttempts.set(sessionId, attempt);
    if (attempt > 3) {
      console.error(`[proxy-replay] ${sessionId} exhausted transient refresh retries`);
      this.replayRetryAttempts.delete(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      this.replayRetryTimers.delete(sessionId);
      this.refreshProtocolReplay(sessionId);
    }, 250 * (2 ** (attempt - 1)));
    timer.unref();
    this.replayRetryTimers.set(sessionId, timer);
  }

  /**
   * cc-proxy fires `session.rotated` after a `/clear` whose native session id
   * has changed. We swap `sessions.native_session_id` so future host restarts
   * adopt the new id, and broadcast a `session:updated` so the UI knows.
   *
   *   params: {
   *     sessionId,                    // proxy-side stable id (NOT the native id)
   *     data: { oldNativeSessionId, newNativeSessionId }
   *   }
   *
   * The Gian session id is provided by closure (sessionId arg), so we don't
   * need any reverse lookup from the proxy-side ids.
   */
  private handleSessionRotated(
    gianSessionId: string,
    notification: ProxyNotification,
    standardNativeSessionId?: string,
    manageWatcher = true,
  ): void {
    const data = notification.params?.data as
      | { oldNativeSessionId?: string; newNativeSessionId?: string }
      | undefined;
    const newNativeSessionId = standardNativeSessionId ?? data?.newNativeSessionId;
    if (!newNativeSessionId || typeof newNativeSessionId !== 'string') {
      return;
    }
    const now = new Date().toISOString();
    this.conversationUsageTurns.delete(gianSessionId);
    this.db
      .prepare(
        `UPDATE sessions
         SET native_session_id = ?,
             fork_from_session_id = NULL,
             context_tokens_used = NULL,
             context_window_tokens = NULL,
             context_usage_updated_at = NULL,
             conversation_input_tokens = NULL,
             conversation_output_tokens = NULL,
             conversation_cached_input_tokens = NULL,
             conversation_total_tokens = NULL,
             conversation_usage_complete = 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(newNativeSessionId, now, gianSessionId);
    this.broadcastSessionUpdated(gianSessionId, {
      native_session_id: newNativeSessionId,
      context_tokens_used: null,
      context_window_tokens: null,
      context_usage_updated_at: null,
      conversation_input_tokens: null,
      conversation_output_tokens: null,
      conversation_cached_input_tokens: null,
      conversation_total_tokens: null,
      conversation_usage_complete: 1,
      updated_at: now,
    });

    // Live Sync v2: native id rotated → JSONL path changed. Stop the old
    // watcher and start a new one against the rotated file.
    if (this.watcher && manageWatcher) {
      this.watcher.stop(gianSessionId);
    }
  }

  /** Provider lifecycle hook for turn bookkeeping (status + queue). */
  private handleLifecycle(sessionId: string, n: ProxyNotification): void {
    if (n.method === 'turn.completed') {
      const settled = this.completeTurn(sessionId, 'completed');
      // Live Sync v2: proxy finished writing this turn to the JSONL; advance
      // watcher offset to current EOF so we skip our own writes and resume
      // tailing for any external CLI appends from here.
      this.watcher?.resume(sessionId);
      if (settled !== 'stopped') this.maybeAutoSendNext(sessionId);
    } else if (
      n.method === 'turn.failed'
      || (
        n.method === 'runtime.error'
        && notificationProviderTurnId(n) !== null
      )
    ) {
      const settled = this.completeTurn(sessionId, 'error');
      this.watcher?.resume(sessionId);
      if (settled !== 'stopped') this.maybeAutoSendNext(sessionId);
    }
  }

  private runProjector(
    sessionId: string,
    notification: ProxyNotification,
    turn: number,
  ): ChatEvent[] {
    const session = this.sessions.get(sessionId);
    return projectNotification(session.executor, notification, sessionId, turn);
  }

  /** Persist the native event and broadcast its optional UI projection. */
  private dispatchChatEvent(e: ChatEvent, turnId: string): void {
    if (isReplaceableSnapshot(e)) {
      const key = `${e.session_id}\u0000${turnId}\u0000${e.event}\u0000${e.call_id}`;
      const pending = this.pendingSnapshots.get(key);
      if (pending) {
        pending.event = e;
        return;
      }
      const entry = {
        event: e,
        turnId,
        timer: setTimeout(() => this.flushSnapshot(key), SNAPSHOT_FLUSH_MS),
      };
      this.pendingSnapshots.set(key, entry);
      return;
    }
    this.persistAndBroadcast(e, turnId);
  }

  private flushSnapshot(key: string): void {
    const pending = this.pendingSnapshots.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSnapshots.delete(key);
    this.persistAndBroadcast(pending.event, pending.turnId);
  }

  private flushSnapshots(sessionId: string): void {
    for (const [key, pending] of this.pendingSnapshots) {
      if (pending.event.session_id === sessionId) this.flushSnapshot(key);
    }
  }

  private persistAndBroadcast(e: ChatEvent, turnId: string): void {
    const storedData = {
      __gian_event: 2,
      provider: e.provider,
      raw: e.data,
      ...(e.display ? { display: e.display } : {}),
    };
    const result = this.history.appendEvent(
      e.session_id,
      turnId,
      e.call_id,
      e.event,
      storedData,
      { replaceSnapshot: isReplaceableSnapshot(e) },
    );
    this.broadcastChatEvent(e, turnId, result.inserted);
  }

  private broadcastChatEvent(e: ChatEvent, turnId: string, attentionEligible: boolean): void {
    this.broadcaster.broadcast({
      type: 'event',
      session_id: e.session_id,
      turn: e.turn,
      call_id: e.call_id,
      event: e.event,
      ts: e.ts,
      data: e.data,
      provider: e.provider,
      ...(e.display ? { display: e.display } : {}),
    });
    // A provider can emit its terminal synchronously while interruptTurn is
    // still awaiting the Stop RPC. The turn remains active until lifecycle
    // handling below, but its stop intent is already authoritative for user
    // attention: never flash a completion/error alert for work they stopped.
    const attention = attentionEligible
      && !this.turns.isStopRequested(e.session_id, turnId)
      ? this.attention.claim(e)
      : null;
    if (
      attention
      && e.display?.type !== 'interaction.approval'
      && e.display?.type !== 'interaction.question'
    ) {
      this.broadcaster.broadcast(attention);
    }
    this.afterChatEvent(e, turnId, attention);
    for (const fn of this.eventSubscribers) {
      try { fn(e); } catch {}
    }
  }

  /**
   * Post-broadcast hook for cross-cutting state updates triggered by
   * specific event types — used by Approval (Track C) to register pending
   * approvals into the global list.
   */
  private afterChatEvent(
    e: ChatEvent,
    turnId: string,
    attention: AttentionMessage | null,
  ): void {
    if (e.display?.type === 'interaction.approval' || e.display?.type === 'interaction.question') {
      this.persistLiveSessionStatus(e.session_id, 'pending');
      const d = e.display.data as import('@gian/shared').ApprovalRequestedData;
      void this.approvals.request({
        sessionId: e.session_id,
        turnId,
        category: d.category,
        risk: d.risk,
        description: d.description,
        subject: d.subject,
        payload: {
          approvalId: d.approvalId,
          scopeOptions: d.scopeOptions,
          ...(d.questions ? { questions: d.questions } : {}),
          ...(d.planActions ? { planActions: d.planActions } : {}),
          ...(d.actions ? { actions: d.actions } : {}),
          ...(d.inputs ? { inputs: d.inputs } : {}),
        },
        nativeOptions: d.nativeOptions,
        ...(attention ? { attention } : {}),
      }).catch(err => {
        console.error('[approval] request failed', err);
      });
    }
    if (e.display?.type === 'interaction.resolved') {
      this.persistLiveSessionStatus(e.session_id, 'running');
      const d = e.display.data as import('@gian/shared').ApprovalResolvedData;
      const raw = e.data as { outcome?: string };
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE proxy_interactions
            SET outcome = ?, resolved_at = ?
          WHERE session_id = ? AND interaction_id = ?`,
      ).run(raw.outcome ?? null, now, e.session_id, d.approvalId);
      const pending = this.approvals.getPending(d.approvalId);
      const selected = d.nativeOptionId
        ? pending?.nativeOptions?.find(option => option.optionId === d.nativeOptionId)
        : undefined;
      const decision: import('@gian/shared').ApprovalDecision = selected?.kind.startsWith('reject')
        ? 'decline'
        : selected?.kind === 'allow_session' || selected?.kind === 'allow_always'
          ? 'allow_session'
          : selected?.kind === 'allow_once'
            ? 'allow_once'
            : d.decision;
      this.approvals.resolve(
        d.approvalId,
        decision,
        this.approvals.consumeResolutionSource(d.approvalId) ?? (d.auto ? 'auto' : 'web'),
      );
      this.callbacks.onInteractionResolved?.(d.approvalId);
    }
    if (e.display?.type === 'activity.command') {
      const d = e.display.data as import('@gian/shared').CommandExecutionData;
      this.queueExternalWorktreeDetection(e.session_id, d.command);
    }
  }

  private queueExternalWorktreeDetection(sessionId: string, command: string | undefined): void {
    // Almost every command event is unrelated. Avoid building promise tails
    // for ordinary shell traffic; only the rare worktree candidates need the
    // per-session ordering below.
    if (!command || !command.includes('worktree')) return;
    // Keep at most one latest command behind the active scan. Agent event
    // bursts therefore cannot create an unbounded promise tail or spend
    // minutes replaying obsolete membership checks.
    this.pendingWorktreeDetectionCommands.set(sessionId, command);
    if (this.activeWorktreeDetections.has(sessionId)) return;
    this.activeWorktreeDetections.add(sessionId);
    void this.drainExternalWorktreeDetections(sessionId);
  }

  private async drainExternalWorktreeDetections(sessionId: string): Promise<void> {
    try {
      while (true) {
        const command = this.pendingWorktreeDetectionCommands.get(sessionId);
        if (command === undefined) return;
        this.pendingWorktreeDetectionCommands.delete(sessionId);
        try {
          await this.maybeDetectExternalWorktree(sessionId, command);
        } catch (error) {
          console.warn('[worktree-detect] async membership check failed:', error);
        }
      }
    } finally {
      this.activeWorktreeDetections.delete(sessionId);
    }
  }

  /**
   * Worktree fallback detection: when the agent runs `git worktree add`
   * directly, record the verified path so Web can offer a post-Turn adoption
   * prompt. This path never changes runtime or Terminal cwd.
   *
   * Guards, in order:
   *   1. command must actually parse as `git worktree add <path>`;
   *   2. session must NOT be a Gian-owned worktree session (worktree_path set)
   *      — those are managed by the merge/discard lifecycle, never disturbed;
   *   3. path must differ from what's already stored (idempotent: completion
   *      events re-carry the same command);
   *   4. path must be a CURRENT member of `git worktree list` for the
   *      session's workspace repo — the agent's claim is never trusted on its
   *      own (mirrors the SEC-014 stance in resolveWorkingTree).
   */
  private async maybeDetectExternalWorktree(sessionId: string, command: string | undefined): Promise<void> {
    if (!command || !command.includes('worktree')) return;
    const detected = detectWorktreeAddPath(command);
    if (!detected) return;
    let session: Session;
    try {
      session = this.sessions.get(sessionId);
    } catch {
      return;
    }
    if (session.worktree_path) return;
    if (session.detected_worktree_path === detected) return;
    const workspace = this.db
      .prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { id: string; path: string } | undefined;
    if (!workspace) return;
    const isMember = (await listGitWorktreesAsync(workspace.path)).some(w => w.path === detected);
    if (!isMember) return;
    // The subprocess yielded to the event loop. Revalidate ownership and
    // managed-worktree state before committing the derived path so a stale
    // scan cannot overwrite a concurrent session transition.
    const updated = this.db
      .prepare(
        `UPDATE sessions
         SET detected_worktree_path = ?, detected_worktree_source = 'agent',
             detected_worktree_revision = detected_worktree_revision + 1
         WHERE id = ? AND workspace_id = ? AND worktree_path IS NULL
           AND (detected_worktree_path IS NULL OR detected_worktree_path <> ?)`,
      )
      .run(detected, sessionId, session.workspace_id, detected);
    if (updated.changes > 0) {
      const row = this.db.prepare(
        'SELECT detected_worktree_revision FROM sessions WHERE id = ?',
      ).get(sessionId) as { detected_worktree_revision: number };
      this.broadcastSessionUpdated(sessionId, {
        detected_worktree_path: detected,
        detected_worktree_source: 'agent',
        detected_worktree_revision: row.detected_worktree_revision,
      });
      this.broadcaster.broadcast({
        type: 'workspace:git-updated',
        workspace_id: workspace.id,
        reason: 'worktree-detected',
      });
    }
  }

  /** Pop the next queued message and re-enter sendMessage. Returns true if sent. */
  private maybeAutoSendNext(sessionId: string): boolean {
    let session: Session;
    try { session = this.sessions.get(sessionId); } catch { return false; }
    // Finalized worktrees and user-completed sessions are closed for input:
    // stop before popping so their queues remain intact.
    if (session.worktree_outcome || session.completed_at) return false;
    const next = this.queue.popNext(sessionId);
    if (!next) return false;
    this.broadcastQueueUpdated(sessionId);
    void this.callbacks.sendMessage(
      sessionId,
      next.text,
      next.items,
      next.toolRequestId,
      next.contextItems,
      next.composerDocument,
    ).catch(err => {
      console.error('[queue] auto-send failed', err);
    });
    return true;
  }

  handleProxyExit(sessionId: string, code: number | null): void {
    // Pending approvals that were in flight against this proxy will never
    // resolve now — drop them so the UI's approval list stays accurate.
    this.approvals.clearSession(sessionId);
    // Drop the cached proxy session id regardless of turn state. If we skip
    // this when no turn is active (proxy killed externally, idle exit, …),
    // the next sendMessage hits a stale cache → `no proxy for session`.
    this.proxySessions.forget(sessionId);
    this.watcher?.resume(sessionId);
    this.flushSnapshots(sessionId);
    const active = this.turns.get(sessionId);
    if (!active) return;
    console.error(`[session] proxy exited mid-turn session=${sessionId} code=${code} turn=${active.id}`);
    this.completeTurn(sessionId, 'error');
  }

  handleSessionFault(sessionId: string, error: Error): void {
    this.approvals.clearSession(sessionId);
    this.proxySessions.forget(sessionId);
    this.watcher?.resume(sessionId);
    this.flushSnapshots(sessionId);
    const active = this.turns.get(sessionId);
    console.error(
      `[session] proxy protocol fault session=${sessionId}`
      + `${active ? ` turn=${active.id}` : ''}: ${error.message}`,
    );
    if (active) {
      this.completeTurn(sessionId, 'error');
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET status = 'error', updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    this.broadcastSessionUpdated(sessionId, { status: 'error', updated_at: now });
  }

  /** Finish DB-only turns recovered after the in-memory runtime was lost. */
  settleOrphanedTurns(
    sessionId: string,
    turns: ActiveTurn[],
    status: 'error' | 'stopped',
    completedAt: string,
  ): void {
    for (const turn of turns) {
      this.ensureTerminalBoundary(sessionId, turn, status, completedAt);
      this.compactTerminalTurn(turn.id);
    }
  }

  completeTurn(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
  ): 'completed' | 'error' | 'stopped' | null {
    // Coalesced snapshots still live only in memory until their short timer
    // fires. Persist them before the terminal boundary and before stream
    // compaction, otherwise a fast stop/error can reorder or lose final tool
    // detail relative to the folded turn.
    this.flushSnapshots(sessionId);
    const now = new Date().toISOString();
    const current = this.turns.get(sessionId);
    const terminalStatus = current && this.turns.isStopRequested(sessionId, current.id)
      ? 'stopped'
      : status;
    if (
      current
      && terminalStatus === 'error'
      && !this.history.hasTurnDisplayType(current.id, 'state.error')
    ) {
      const session = this.sessions.get(sessionId);
      const errorData: SessionErrorData = {
        message: 'The agent stopped unexpectedly.',
        retryable: true,
        code: 'TURN_FAILED',
      };
      const error: ChatEvent<'state.error'> = {
        session_id: sessionId,
        turn: current.number,
        call_id: `gian:turn-error:${current.id}`,
        ts: Date.now(),
        provider: session.executor,
        event: 'gian.turn.error',
        // Provider diagnostics remain in their native event/log. Keep this
        // fallback presentation and OS notification intentionally generic.
        data: { status: 'error' },
        display: { type: 'state.error', data: errorData },
      };
      this.persistAndBroadcast(error, current.id);
    }
    const active = this.turns.finish(sessionId, terminalStatus, now);
    if (!active) return null;
    this.ensureTerminalBoundary(sessionId, active, terminalStatus, now);
    this.compactTerminalTurn(active.id);
    // 'stopped' (user-initiated interrupt) is logically a clean termination,
    // not an error — the session lands at 'done' so the UI doesn't show a red
    // error pill. Only true failures land at 'error'.
    const sessionStatus = terminalStatus === 'error' ? 'error' : 'done';
    if (terminalStatus === 'stopped') {
      // User-initiated interrupt: they're looking at it, so don't mark unread.
      this.db
        .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
        .run(sessionStatus, now, sessionId);
      this.broadcastSessionUpdated(sessionId, { status: sessionStatus, updated_at: now });
    } else {
      // Natural completion or failure → the session has a new result to read.
      // The web clears it again for whichever session the user is viewing.
      this.db
        .prepare(`UPDATE sessions SET status = ?, unread = 1, updated_at = ? WHERE id = ?`)
        .run(sessionStatus, now, sessionId);
      this.broadcastSessionUpdated(sessionId, { status: sessionStatus, unread: 1, updated_at: now });
    }
    if (terminalStatus === 'completed') {
      // Issue #57: an unnamed session derives its title from the agent's
      // native title (or the first user message) once turns start completing.
      // Fire-and-forget; failures are logged inside AutoTitleService.
      void this.autoTitle.maybeAutoTitle(sessionId);
    }
    return terminalStatus;
  }

  private ensureTerminalBoundary(
    sessionId: string,
    active: ActiveTurn,
    status: 'completed' | 'error' | 'stopped',
    completedAt: string,
  ): void {
    if (!this.history.hasTurnCompletionBoundary(active.id)) {
      const session = this.sessions.get(sessionId);
      const terminal: ChatEvent<'state.turn-completed'> = {
        session_id: sessionId,
        turn: active.number,
        call_id: `gian:turn-completed:${active.id}`,
        ts: Date.parse(completedAt),
        provider: session.executor,
        event: 'gian.turn.completed',
        data: { turnId: active.id, status },
        display: {
          type: 'state.turn-completed',
          data: { turnId: active.id, status },
        },
      };
      // Broadcast before potentially expensive terminal compaction so every
      // client can fold the turn even when maintenance later fails.
      this.persistAndBroadcast(terminal, active.id);
    }
  }

  private compactTerminalTurn(turnId: string): void {
    try {
      this.history.compactTurnStreams(turnId);
    } catch (error) {
      console.warn(`[session] failed to compact turn streams turn=${turnId}`, error);
    }
  }

  broadcastEvent(
    sessionId: string,
    turn: number,
    callId: string,
    event: string,
    data: Record<string, unknown>,
    ts = Date.now(),
  ): void {
    const envelope: EventEnvelope = {
      session_id: sessionId,
      turn,
      call_id: callId,
      event,
      ts,
      data,
    };
    this.broadcaster.broadcast({ type: 'event', ...envelope });
  }

  private persistLiveSessionStatus(sessionId: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, sessionId);
    if (result.changes <= 0) return;
    this.broadcastSessionUpdated(sessionId, { status, updated_at: now });
  }

  broadcastSessionUpdated(id: string, partial: Partial<Session>): void {
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id, ...partial },
    });
  }

  broadcastQueueUpdated(sessionId: string): void {
    this.broadcaster.broadcast({
      type: 'queue:updated',
      session_id: sessionId,
      queue: this.queue.list(sessionId).map(e => ({
        id: e.id,
        text: e.text,
        ...(e.items ? { items: e.items } : {}),
        ...(e.contextItems ? { context_items: e.contextItems } : {}),
        ...(e.composerDocument ? { composer_document: e.composerDocument } : {}),
      })),
    });
  }

}
