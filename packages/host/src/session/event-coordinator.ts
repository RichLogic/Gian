import { randomUUID } from 'node:crypto';
import type {
  EventEnvelope,
  ExecutorConfigState,
  InputItem,
  NativeConfigOption,
  ProxyNotification,
  Session,
  ChatEvent,
} from '@gian/shared';
import type { ApprovalManager } from '../approval/index.js';
import { projectNotification } from '../event/index.js';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import {
  normalizeKimiConfigOptions,
  normalizeKimiSlashCommands,
} from '../proxy/kimi-proxy-client.js';
import type { QueueManager } from '../queue/index.js';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { listGitWorktrees } from '../workspace/git.js';
import { detectWorktreeAddPath } from './worktree-detect.js';
import { executorConfigFromOptions, type SessionRepository } from './repository.js';
import type { SessionHistoryStore } from './history-store.js';
import type { TurnRuntime } from './turn-runtime.js';
import type { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import {
  parseAcpUsageUpdate,
  parseTokenUsageUpdate,
  type ParsedTokenUsageUpdate,
} from './token-usage.js';
import { kimiContentText } from './input-items.js';

interface EventCoordinatorCallbacks {
  sendMessage: (sessionId: string, text: string, items?: InputItem[]) => Promise<void>;
}

export class SessionEventCoordinator {
  private eventSubscribers: Array<(event: ChatEvent) => void> = [];
  private conversationUsageTurns = new Map<string, Set<string>>();

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
    private callbacks: EventCoordinatorCallbacks,
  ) {}

  onEvent(subscriber: (event: ChatEvent) => void): () => void {
    this.eventSubscribers.push(subscriber);
    return () => {
      const index = this.eventSubscribers.indexOf(subscriber);
      if (index !== -1) this.eventSubscribers.splice(index, 1);
    };
  }

  forgetConversationUsage(sessionId: string): void {
    this.conversationUsageTurns.delete(sessionId);
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
  ): { turns: number; events: number } {
    let turnNumber = 0;
    let turnId: string | null = null;
    let eventCount = 0;
    let pendingUserText = '';

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
      return turnId;
    };

    const insert = (
      activeTurnId: string,
      callId: string,
      type: string,
      data: Record<string, unknown>,
    ): void => {
      this.db
        .prepare(
          `INSERT INTO events
            (id, session_id, turn_id, call_id, type, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          sessionId,
          activeTurnId,
          callId,
          type,
          JSON.stringify(data),
          timestamp,
        );
      eventCount += 1;
    };

    const flushUserMessage = (): void => {
      if (!pendingUserText) return;
      turnId = null;
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
        );
      }
    }
    flushUserMessage();

    if (turnNumber > 0) {
      this.db
        .prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`)
        .run(sessionId);
    }
    return { turns: turnNumber, events: eventCount };
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
    // session.rotated: cc-proxy emits this when /clear creates a new native
    // session. Pure host-internal: update sessions.native_session_id and
    // broadcast session:updated. Don't surface as a transcript event.
    if (notification.method === 'session.rotated') {
      this.handleSessionRotated(sessionId, notification);
      return;
    }

    if (notification.method === 'token_usage.updated') {
      const session = this.sessions.get(sessionId);
      const update = parseTokenUsageUpdate(notification.params?.data, session.executor);
      if (update) this.persistTokenUsage(sessionId, notification.params?.turnId, update);
      return;
    }

    // Provider debug chatter is intentionally neither history nor UI state.
    if (notification.method === 'debug') return;

    if (notification.method === 'acp.sessionUpdate') {
      const payload = notification.params?.data as { update?: unknown } | undefined;
      const usage = parseAcpUsageUpdate(payload);
      if (usage) {
        this.persistTokenUsage(sessionId, notification.params?.turnId, usage);
        return;
      }
      const update = payload?.update as
        | { sessionUpdate?: unknown; configOptions?: unknown }
        | undefined;
      if (update?.sessionUpdate === 'config_option_update') {
        const options = normalizeKimiConfigOptions(update.configOptions);
        this.persistNativeConfigSnapshot(sessionId, executorConfigFromOptions(options), options);
        return;
      }
      if (update?.sessionUpdate === 'available_commands_update') {
        const commands = normalizeKimiSlashCommands(
          (update as { availableCommands?: unknown }).availableCommands,
        );
        this.broadcaster.broadcast({
          type: 'session:slash-commands',
          session_id: sessionId,
          commands,
        });
        return;
      }
    }

    // Project/dispatch BEFORE handleLifecycle. handleLifecycle calls
    // completeTurn on turn.completed/failed, which deletes the activeTurns
    // map entry; if that runs first, dispatchChatEvent would persist the event
    // with a fresh random turn_id that doesn't exist in `turns` and trip the
    // FK constraint.
    const events = this.runProjector(sessionId, notification);
    for (const event of events) this.dispatchChatEvent(event);

    this.handleLifecycle(sessionId, notification);
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
  ): void {
    const data = notification.params?.data as
      | { oldNativeSessionId?: string; newNativeSessionId?: string }
      | undefined;
    const newNativeSessionId = data?.newNativeSessionId;
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
    if (this.watcher) {
      this.watcher.stop(gianSessionId);
      const session = this.sessions.get(gianSessionId);
      if (session.executor === 'kimi') return;
      const workspace = this.db
        .prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(session.workspace_id) as { path: string } | undefined;
      if (workspace) {
        const cwd = session.worktree_path ?? workspace.path;
        const filePath = locateNativeJsonl(session.executor, newNativeSessionId, cwd);
        if (filePath) this.watcher.start(gianSessionId, filePath, session.executor);
      }
    }
  }

  /** Provider lifecycle hook for turn bookkeeping (status + queue). */
  private handleLifecycle(sessionId: string, n: ProxyNotification): void {
    if (n.method === 'turn.completed') {
      this.completeTurn(sessionId, 'completed');
      // Live Sync v2: proxy finished writing this turn to the JSONL; advance
      // watcher offset to current EOF so we skip our own writes and resume
      // tailing for any external CLI appends from here.
      this.watcher?.resume(sessionId);
      this.maybeAutoSendNext(sessionId);
    } else if (n.method === 'turn.failed') {
      this.completeTurn(sessionId, 'error');
      this.watcher?.resume(sessionId);
      this.maybeAutoSendNext(sessionId);
    }
  }

  private runProjector(
    sessionId: string,
    notification: ProxyNotification,
  ): ChatEvent[] {
    const session = this.sessions.get(sessionId);
    const turn = this.turns.get(sessionId)?.number ?? 0;
    return projectNotification(session.executor, notification, sessionId, turn);
  }

  /** Persist the native event and broadcast its optional UI projection. */
  private dispatchChatEvent(e: ChatEvent): void {
    const storedData = {
      __gian_event: 2,
      provider: e.provider,
      raw: e.data,
      ...(e.display ? { display: e.display } : {}),
    };
    this.history.appendEvent(
      e.session_id,
      this.activeTurnId(e.session_id),
      e.call_id,
      e.event,
      storedData,
    );
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
    this.afterChatEvent(e);
    for (const fn of this.eventSubscribers) {
      try { fn(e); } catch {}
    }
  }

  /**
   * Post-broadcast hook for cross-cutting state updates triggered by
   * specific event types — used by Approval (Track C) to register pending
   * approvals into the global list.
   */
  private afterChatEvent(e: ChatEvent): void {
    if (e.display?.type === 'interaction.approval' || e.display?.type === 'interaction.question') {
      const d = e.display.data as import('@gian/shared').ApprovalRequestedData;
      void this.approvals.request({
        sessionId: e.session_id,
        turnId: this.activeTurnId(e.session_id),
        category: d.category,
        risk: d.risk,
        description: d.description,
        subject: d.subject,
        payload: { approvalId: d.approvalId },
        nativeOptions: d.nativeOptions,
      }).catch(err => {
        console.error('[approval] request failed', err);
      });
    }
    if (e.display?.type === 'activity.command') {
      const d = e.display.data as import('@gian/shared').CommandExecutionData;
      this.maybeDetectExternalWorktree(e.session_id, d.command);
    }
  }

  /**
   * Worktree auto-detection: when the agent runs `git worktree add` itself
   * (outside Gian's own worktree lifecycle), record the new worktree's path on
   * the session so the web can switch the VIEW-level working tree to it.
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
  private maybeDetectExternalWorktree(sessionId: string, command: string | undefined): void {
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
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) return;
    const isMember = listGitWorktrees(workspace.path).some(w => w.path === detected);
    if (!isMember) return;
    this.db
      .prepare('UPDATE sessions SET detected_worktree_path = ? WHERE id = ?')
      .run(detected, sessionId);
    this.broadcastSessionUpdated(sessionId, { detected_worktree_path: detected });
  }

  /** Pop the next queued message and re-enter sendMessage. Returns true if sent. */
  private maybeAutoSendNext(sessionId: string): boolean {
    let session: Session;
    try { session = this.sessions.get(sessionId); } catch { return false; }
    // A user-completed session is closed for input: STOP the drain without
    // popping — the queue stays intact in case the session is reopened.
    if (session.completed_at) return false;
    const next = this.queue.popNext(sessionId);
    if (!next) return false;
    this.broadcastQueueUpdated(sessionId);
    void this.callbacks.sendMessage(sessionId, next.text, next.items).catch(err => {
      console.error('[queue] auto-send failed', err);
    });
    return true;
  }

  private activeTurnId(sessionId: string): string {
    return this.turns.get(sessionId)?.id ?? randomUUID();
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
    const active = this.turns.get(sessionId);
    if (!active) return;
    console.error(`[session] proxy exited mid-turn session=${sessionId} code=${code} turn=${active.id}`);
    this.completeTurn(sessionId, 'error');
  }

  completeTurn(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
  ): void {
    const now = new Date().toISOString();
    const active = this.turns.finish(sessionId, status, now);
    if (!active) return;
    // 'stopped' (user-initiated interrupt) is logically a clean termination,
    // not an error — the session lands at 'done' so the UI doesn't show a red
    // error pill. Only true failures land at 'error'.
    const sessionStatus = status === 'error' ? 'error' : 'done';
    if (status === 'stopped') {
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
  }

  broadcastEvent(
    sessionId: string,
    turn: number,
    callId: string,
    event: string,
    data: Record<string, unknown>,
  ): void {
    const envelope: EventEnvelope = {
      session_id: sessionId,
      turn,
      call_id: callId,
      event,
      ts: Date.now(),
      data,
    };
    this.broadcaster.broadcast({ type: 'event', ...envelope });
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
      })),
    });
  }

}
