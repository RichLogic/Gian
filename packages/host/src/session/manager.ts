import type {
  ApprovalMode,
  AgentProxyDefaults,
  ConfigOption,
  ConfigValue,
  Executor,
  ExecutorConfigState,
  EventEnvelope,
  NativeConfigOption,
  NativeConfigValue,
  ResolvedProxyCatalog,
  Session,
  ChatEvent,
  TraceSnapshot,
} from '@gian/shared';
import { isApprovalMode } from '@gian/shared';
import { existsSync } from 'node:fs';
import { ensureSessionAttachmentDir } from '../storage/attachments.js';
import type { Db } from '../storage/db.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ApprovalManager } from '../approval/index.js';
import type { QueueManager } from '../queue/index.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import { locateCcJsonl, appendCcCustomTitle } from '../native/locate-jsonl.js';
import { randomUUID } from 'node:crypto';
import { SessionRepository } from './repository.js';
import { SessionHistoryStore, type EventHistoryPage } from './history-store.js';
import { TraceEvidenceStore } from '../trace/evidence-store.js';
import { projectTraceSnapshot } from '../trace/projector.js';
import { TurnRuntime } from './turn-runtime.js';
import {
  SessionLifecycleService,
  type CreateSessionInput,
} from './lifecycle-service.js';
import { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import { SessionEventCoordinator } from './event-coordinator.js';
import type { AttentionDispatcher } from './attention.js';
import { AutoTitleService } from './auto-title.js';
import {
  SidechatCoordinator,
  newForkSessionId,
} from './sidechat-coordinator.js';
import { SidechatTransientStore } from './sidechat-store.js';
import { assertInheritedSessionConfig, resolveForkAnchor } from './fork.js';
import { requestViolation } from '@gian/proxy-protocol';
import type { ProtocolV2SessionClient } from '../proxy/protocol-v2-session-client.js';
import type {
  SessionForkFromInput,
  SessionForkFromResult,
  SessionOrigin,
  SideChatPublicSnapshot,
  SidechatCloseResult,
} from '@gian/shared';
import { SubtaskLifecycle } from './subtask-lifecycle.js';
import { NativeSessionService } from './native-session-service.js';
import {
  assertLocalFilesBelongToSession,
  buildAttachmentsFromItems,
  translateItemsForExecutor,
} from './input-items.js';
export type { CreateSessionInput } from './lifecycle-service.js';

const PROXY_CLOSE_TIMEOUT_MS = 5_000;

function assertSessionAcceptsInput(session: Session): void {
  if (session.worktree_outcome) {
    throw new Error(`session is ${session.worktree_outcome}; create a new session to continue`);
  }
  if (session.completed_at) {
    throw new Error('session is completed; reopen it before sending more messages');
  }
}

/**
 * Bridges WebSocket commands and the proxy layer. Persists sessions, turns,
 * events; subscribes to proxy notifications and broadcasts them to the web
 * client.
 *
 * Every proxy notification keeps its provider-native method and payload.
 * Provider adapters attach only an optional UI display projection; events
 * without a current UI mapping remain available in DB/WS for diagnostics.
 */
export class SessionManager {
  private sessions: SessionRepository;
  private history: SessionHistoryStore;
  private turns: TurnRuntime;
  private lifecycle: SessionLifecycleService;
  private proxySessions: ProxySessionCoordinator;
  private autoTitle: AutoTitleService;
  private events: SessionEventCoordinator;
  private subtasks: SubtaskLifecycle;
  private nativeSessions: NativeSessionService;
  private traceEvidence: TraceEvidenceStore;
  private readonly interactionResponseIds = new Map<string, string>();
  private readonly sidechats: SidechatCoordinator;

  constructor(
    private db: Db,
    private proxy: ProxyManager,
    private broadcaster: WsBroadcaster,
    private approvals: ApprovalManager,
    private queue: QueueManager,
    private dataDir: string,
    /** Live Sync v2 — when present, host mirrors external CLI appends into
     *  events + WS for each active session. Optional so tests can omit. */
    private watcher: NativeJsonlWatcher | null = null,
    private proxyDefaults?: (executor: Executor) => AgentProxyDefaults,
    attention?: AttentionDispatcher,
  ) {
    this.sessions = new SessionRepository(db);
    this.history = new SessionHistoryStore(db);
    this.traceEvidence = new TraceEvidenceStore(db);
    this.turns = new TurnRuntime(db, this.history);
    this.sidechats = new SidechatCoordinator(
      new SidechatTransientStore(db),
      proxy,
      broadcaster,
    );
    this.proxySessions = new ProxySessionCoordinator(
      db,
      proxy,
      this.sessions,
      this.history,
      watcher,
      {
        onNotification: (sessionId, notification) => this.events.handleNotification(sessionId, notification),
        onExit: (sessionId, code) => this.events.handleProxyExit(sessionId, code),
        onSessionFault: (sessionId, error) => this.events.handleSessionFault(sessionId, error),
        onSessionUpdated: (sessionId, partial) => this.broadcastSessionUpdated(sessionId, partial),
        onAttached: (sessionId) => {
          void this.sidechats.recoverForParent(sessionId).catch((error) => {
            console.error(`[sidechat] recover failed for ${sessionId}: ${String(error)}`);
          });
        },
      },
      this.dataDir,
    );
    this.autoTitle = new AutoTitleService({
      db,
      sessions: this.sessions,
      history: this.history,
      proxy,
      rename: (sessionId, name) => this.renameSession(sessionId, name),
    });
    this.events = new SessionEventCoordinator(
      db,
      this.sessions,
      this.history,
      this.turns,
      broadcaster,
      approvals,
      queue,
      watcher,
      this.proxySessions,
      this.autoTitle,
      {
        sendMessage: (sessionId, text, items) => this.sendMessage(sessionId, text, items),
        onInteractionResolved: (interactionId) => {
          this.interactionResponseIds.delete(interactionId);
        },
      },
      attention,
    );
    this.subtasks = new SubtaskLifecycle(db, this.sessions, {
      broadcastUpdated: (sessionId, partial) => this.broadcastSessionUpdated(sessionId, partial),
    });
    this.nativeSessions = new NativeSessionService(
      db,
      proxy,
      this.proxySessions,
      this.sessions,
      broadcaster,
      {
        persistKimiReplay: (sessionId, updates, timestamp, replayStreamId) =>
          this.persistKimiReplay(sessionId, updates, timestamp, replayStreamId),
      },
    );
    this.lifecycle = new SessionLifecycleService(
      db,
      this.sessions,
      approvals,
      broadcaster,
      {
        bringUpProxySession: input => this.proxySessions.bringUp(input),
        discardProxy: async sessionId => {
          await this.proxySessions.dispose(sessionId);
          this.sessions.forget(sessionId);
        },
        teardownProxy: sessionId => this.teardownProxy(sessionId),
        forgetConversationUsage: sessionId => {
          this.events.forgetConversationUsage(sessionId);
        },
      },
      executor => this.proxyDefaults?.(executor),
    );
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.lifecycle.create(input);
  }

  listSidechats(): SideChatPublicSnapshot[] {
    return this.sidechats.listPublic();
  }

  async createSidechat(parentSessionId: string, sidechatId?: string): Promise<SideChatPublicSnapshot> {
    const parent = this.sessions.get(parentSessionId);
    await this.proxySessions.ensure(parent);
    await this.sidechats.recoverForParent(parentSessionId);
    return this.sidechats.create(parentSessionId, sidechatId);
  }

  async resumeSidechat(sidechatId: string, parentSessionId: string): Promise<SideChatPublicSnapshot> {
    const parent = this.sessions.get(parentSessionId);
    await this.proxySessions.ensure(parent);
    await this.sidechats.recoverForParent(parentSessionId);
    return this.sidechats.resume(sidechatId, parentSessionId);
  }

  async closeSidechat(sidechatId: string): Promise<SidechatCloseResult> {
    return this.sidechats.close(sidechatId);
  }

  async forkSession(input: SessionForkFromInput): Promise<SessionForkFromResult> {
    if (this.sidechats.has(input.sourceSessionId)) {
      throw requestViolation('SESSION_NOT_FOUND', 'Side Chat cannot be a Fork source');
    }
    const source = this.sessions.get(input.sourceSessionId);
    await this.proxySessions.ensure(source);
    const client = this.proxy.get(source.id);
    if (!client || !isV2Client(client) || !client.forkSession) {
      throw requestViolation('CAPABILITY_NOT_SUPPORTED', 'Parent Session has no session.fork Proxy');
    }
    const initialized = await client.initialize();
    if (initialized.capabilities['session.fork'] === undefined) {
      throw requestViolation('CAPABILITY_NOT_SUPPORTED', 'session.fork is not advertised');
    }
    if (input.anchor.type === 'turn' && initialized.capabilities['session.fork.atTurn'] === undefined) {
      throw requestViolation('CAPABILITY_NOT_SUPPORTED', 'session.fork.atTurn is not advertised');
    }
    const sourceStreamId = client.streamId();
    if (!sourceStreamId) {
      throw requestViolation('SESSION_STALE', 'Source Session has no active attach generation');
    }
    const sessionId = input.sessionId ?? newForkSessionId();
    const published = this.sessions.find(sessionId);
    if (published) {
      const identity = this.readForkRequestIdentity(sessionId);
      if (!isPublishedForkIdentity(published, identity, source.id, sourceStreamId, input.anchor)) {
        throw requestViolation('CONFLICT', 'sessionId already belongs to a different Session');
      }
      return { sessionId, origin: published.origin! };
    }

    const catalog = await client.catalog();
    const inherited = assertInheritedSessionConfig(catalog.configOptions, source.executor_config.values);
    const resolved = resolveForkAnchor(this.db, source.id, input.anchor.type === 'head'
      ? { type: 'head' }
      : { type: 'turn', turnId: input.anchor.turnId, sourceTurnId: input.anchor.sourceTurnId });
    const protocolAnchor = input.anchor.type === 'head'
      ? { type: 'head' as const }
      : { type: 'turn' as const, turnId: resolved.turnId, sourceTurnId: resolved.sourceTurnId };

    const forked = await client.forkSession({ sessionId, anchor: protocolAnchor });
    const nativeSessionId = providerNativeSessionId(forked.session);
    const origin: SessionOrigin = {
      kind: 'fork',
      session_id: forked.origin.sessionId,
      turn_id: forked.origin.turnId,
      source_turn_id: forked.origin.sourceTurnId,
    };
    if (
      origin.session_id !== source.id
      || origin.turn_id !== resolved.turnId
      || origin.source_turn_id !== resolved.sourceTurnId
    ) {
      throwIfForkLeftovers(await this.abandonForkChild(client, sessionId, nativeSessionId));
      throw requestViolation('INTERNAL', 'session.fork origin did not match the Host anchor');
    }
    if (!nativeSessionId) {
      throwIfForkLeftovers(await this.abandonForkChild(client, sessionId, null));
      throw requestViolation('INTERNAL', 'session.fork Result omitted durable nativeSession');
    }

    const now = new Date().toISOString();
    try {
      this.adoptForkChild(client, sessionId);
      const publish = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO sessions
            (id, name, type, task_id, workspace_id, executor, model, approval_mode,
             executor_config_json, thinking_effort, service_tier, active_channel, status,
             archived, worktree_path, branch, base_branch, worktree_outcome,
             native_session_id, fork_from_session_id, conversation_usage_complete,
             turn_config_json, turn_config_options_json, turn_config_revision,
             origin_kind, origin_session_id, origin_turn_id, origin_source_turn_id,
             origin_source_stream_id, origin_anchor_type,
             available_actions_json, created_at, updated_at)
           VALUES
            (@id, @name, @type, @task_id, @workspace_id, @executor, @model,
             @approval_mode, @executor_config_json, @thinking_effort, @service_tier, 'web', 'new',
             0, @worktree_path, @branch, @base_branch, NULL, @native_session_id,
             NULL, 1,
             @turn_config_json, @turn_config_options_json, @turn_config_revision,
             'fork', @origin_session_id, @origin_turn_id, @origin_source_turn_id,
             @origin_source_stream_id, @origin_anchor_type,
             @available_actions_json, @now, @now)`,
        ).run({
          id: sessionId,
          name: source.name,
          type: source.type,
          task_id: source.task_id,
          workspace_id: source.workspace_id,
          executor: source.executor,
          model: source.model,
          approval_mode: source.approval_mode,
          executor_config_json: JSON.stringify({ schemaVersion: 1, values: inherited }),
          thinking_effort: source.thinking_effort,
          service_tier: source.service_tier,
          worktree_path: source.worktree_path,
          branch: source.branch,
          base_branch: source.base_branch,
          native_session_id: nativeSessionId,
          turn_config_json: JSON.stringify(input.turnConfig ?? source.turn_config ?? {}),
          turn_config_options_json: source.turn_config_options
            ? JSON.stringify(source.turn_config_options)
            : null,
          turn_config_revision: source.turn_config_revision ?? null,
          origin_session_id: origin.session_id,
          origin_turn_id: origin.turn_id,
          origin_source_turn_id: origin.source_turn_id,
          origin_source_stream_id: sourceStreamId,
          origin_anchor_type: input.anchor.type,
          available_actions_json: forked.session.availableActions
            ? JSON.stringify(forked.session.availableActions)
            : null,
          now,
        });
        if (forked.replayEvents?.length) {
          this.persistKimiReplay(
            sessionId,
            forked.replayEvents,
            now,
            'replayStreamId' in forked ? forked.replayStreamId : undefined,
          );
        }
      });
      publish();
    } catch (error) {
      const raced = this.sessions.find(sessionId);
      const racedIdentity = raced ? this.readForkRequestIdentity(sessionId) : null;
      if (raced && isPublishedForkIdentity(
        raced,
        racedIdentity,
        source.id,
        sourceStreamId,
        input.anchor,
      )) {
        return { sessionId, origin: raced.origin! };
      }
      throwIfForkLeftovers(await this.abandonForkChild(client, sessionId, nativeSessionId), error);
      if (raced) {
        throw requestViolation('CONFLICT', 'sessionId already belongs to a different Session');
      }
      throw error;
    }

    this.sessions.setNativeOptions(sessionId, source.native_config_options ?? []);
    const session = this.sessions.get(sessionId);
    this.broadcaster.broadcast({
      type: 'session:created',
      session,
      origin: 'session-fork',
    });
    return { sessionId, origin };
  }

  async listKimiNativeSessions(cwd: string): Promise<import('@gian/shared').NativeSession[]> {
    return this.nativeSessions.listKimi(cwd);
  }

  async listPluginNativeSessions(
    executor: Executor,
    cwd: string,
  ): Promise<import('@gian/shared').NativeSession[] | null> {
    return this.nativeSessions.listPlugin(executor, cwd);
  }

  async adoptKimiNativeSession(input: {
    workspaceId: string;
    cwd: string;
    nativeSessionId: string;
    name?: string;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    return this.nativeSessions.adoptKimi(input);
  }

  async deletePluginNativeSession(
    executor: Executor,
    nativeSessionId: string,
    cwd: string,
  ): Promise<void> {
    return this.nativeSessions.deletePluginNativeSession(executor, nativeSessionId, cwd);
  }

  async adoptPluginNativeSession(input: {
    workspaceId: string;
    cwd: string;
    executor: Executor;
    nativeSessionId: string;
    name?: string;
    approvalMode?: ApprovalMode;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    return this.nativeSessions.adopt(input);
  }

  async stopTurn(sessionId: string): Promise<void> {
    if (this.sidechats.has(sessionId)) {
      await this.sidechats.interruptTurn(sessionId);
      return;
    }
    const proxySessionId = this.proxySessions.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);

    // Mark the generation before awaiting the RPC so a synchronous provider
    // terminal is interpreted as the requested stop. Do not settle eagerly:
    // if interrupt rejects, the agent may still be running and Host must keep
    // accepting its events so the user can retry or force-recover.
    const stopping = this.turns.requestStop(sessionId);
    try {
      await client.interruptTurn(proxySessionId);
    } catch (error) {
      if (stopping && this.turns.get(sessionId)?.id !== stopping.id) {
        // A synchronous provider terminal already proved this generation is
        // settled; the interrupt transport's late rejection cannot undo it.
        return;
      }
      if (stopping) this.turns.cancelStop(sessionId, stopping.id);
      throw error;
    }
    // The Result only proves delivery. Keep the generation active until the
    // Proxy emits turn.completed/turn.failed, which is the protocol's
    // authoritative terminal fact.
  }

  /**
   * Last-resort recovery for sessions wedged in ways `stopTurn` can't fix
   * (proxy hung mid-RPC, claude child idle but unresponsive, etc.). Runs
   * fully in-process — no host restart required:
   *
   *   1. SIGKILL the cc-proxy spawn (or fire-and-forget close for codex).
   *      Its `exit` triggers the existing `handleProxyExit` path which
   *      tears down activeTurns / pending approvals.
   *   2. Eagerly mark any active turn `'stopped'` and the session `'done'`
   *      so the UI doesn't have to wait on the exit handler.
   *   3. Drop our cached `proxySessionIds` entry — next `sendMessage` will
   *      lazily spawn a fresh proxy and adopt the on-disk native session
   *      via the existing `claudeSessionId` / `threadId` resume path.
   *
   * Idempotent. Safe to call when nothing is wedged (no-op if no client).
   */
  async forceRecover(sessionId: string): Promise<void> {
    if (this.turns.has(sessionId)) {
      this.completeTurn(sessionId, 'stopped');
    }
    this.approvals.clearSession(sessionId);
    this.watcher?.resume(sessionId);
    this.proxySessions.forget(sessionId);

    const now = new Date().toISOString();

    // Sweep ANY DB-level `running` turn for this session, regardless of the
    // in-memory `activeTurns` entry. If the host restarted while a turn was
    // running, activeTurns is empty but the row still says 'running' — it's
    // an orphan; mark it 'stopped' so it doesn't haunt later queries.
    const orphaned = this.turns.stopOrphaned(sessionId, now);
    this.events.settleOrphanedTurns(sessionId, orphaned, 'stopped', now);

    // Force the session row to a clean status. completeTurn already did this
    // if a turn was active in memory; otherwise the row might still say
    // `running` from a prior wedge or `error` from the auto-cleanup.
    this.db
      .prepare(`UPDATE sessions SET status = 'done', updated_at = ? WHERE id = ? AND status != 'done'`)
      .run(now, sessionId);
    this.broadcastSessionUpdated(sessionId, { status: 'done', updated_at: now });

    await this.proxy.forceDispose(sessionId);
  }

  async respondApproval(
    sessionId: string,
    approvalId: string,
    decision: import('@gian/shared').ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    nativeOptionId?: string,
  ): Promise<void> {
    this.getSession(sessionId);
    const proxySessionId = this.proxySessions.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);

    // Snapshot the pending record before resolving so we can inspect category
    // for plan-mode-exit ceremony below.
    const pending = this.approvals.getPending(approvalId);
    const persisted = this.loadInteraction(sessionId, approvalId);
    const responseId = persisted?.response_id
      ?? this.interactionResponseIds.get(approvalId)
      ?? randomUUID();
    this.interactionResponseIds.set(approvalId, responseId);

    if (!pending && persisted) {
      await client.respondInteraction({
        sessionId: proxySessionId,
        interactionId: approvalId,
        responseId: persisted.response_id,
        actionId: persisted.action_id ?? 'allow_once',
        values: persisted.values,
      });
      return;
    }

    if ((pending?.nativeOptions?.length ?? 0) > 0 || nativeOptionId !== undefined) {
      const option = pending?.nativeOptions?.find(item => item.optionId === nativeOptionId);
      if (!option) {
        throw Object.assign(
          new Error('Select one of the approval options supplied by the Agent.'),
          { code: 'INVALID_APPROVAL_OPTION' },
        );
      }
      await client.respondInteraction({
        sessionId: proxySessionId,
        interactionId: approvalId,
        responseId,
        actionId: option.optionId,
        values: answers ?? {},
      });
      this.saveInteraction(sessionId, approvalId, {
        responseId,
        turnId: pending?.turnId,
        actionId: option.optionId,
        values: answers ?? {},
      });
      return;
    }

    // Plan-mode-exit decisions get mapped to plain allow/deny on the proxy
    // wire; the auto/ask flip happens in the ceremony below. `keep_planning`
    // is a denial — the agent stays in plan mode.
    const isDeny = decision === 'decline' || decision === 'keep_planning';

    if (isDeny) {
      await client.respondInteraction({
        sessionId: proxySessionId,
        interactionId: approvalId,
        responseId,
        actionId: 'decline',
        values: {},
      });
    } else {
      await client.respondInteraction({
        sessionId: proxySessionId,
        interactionId: approvalId,
        responseId,
        actionId: decision === 'allow_session' ? 'allow_session' : 'allow_once',
        values: answers ?? {},
      });
    }
    const actionId = isDeny ? 'decline' : decision === 'allow_session' ? 'allow_session' : 'allow_once';
    this.saveInteraction(sessionId, approvalId, {
      responseId,
      turnId: pending?.turnId,
      actionId,
      values: isDeny ? {} : answers ?? {},
    });

    // Plan-mode exit ceremony: flip session.approval_mode based on which of
    // the three plan-mode-exit actions the user chose. Skip for non-plan
    // approvals or when keep_planning leaves the session in plan mode.
    if (pending?.category === 'exit_plan_mode') {
      const session = this.db
        .prepare('SELECT approval_mode FROM sessions WHERE id = ?')
        .get(sessionId) as { approval_mode: ApprovalMode } | undefined;
      if (session?.approval_mode === 'plan') {
        if (decision === 'accept_with_auto') {
          this.setApprovalMode(sessionId, 'auto');
        } else if (decision === 'accept_with_ask' || decision === 'allow_once' || decision === 'allow_session') {
          // Default behaviour for legacy `allow_once` / `allow_session` is
          // 'ask' — preserves the prior contract for any caller that hasn't
          // adopted the three-way decisions yet.
          this.setApprovalMode(sessionId, 'ask');
        }
        // decline / keep_planning → no flip, agent stays in plan mode.
      }
    }
  }

  private loadInteraction(
    sessionId: string,
    interactionId: string,
  ): { response_id: string; action_id: string | null; values: Record<string, string | boolean | string[]> } | null {
    const row = this.db.prepare(
      `SELECT response_id, action_id, values_json
         FROM proxy_interactions
        WHERE session_id = ? AND interaction_id = ?`,
    ).get(sessionId, interactionId) as {
      response_id: string;
      action_id: string | null;
      values_json: string | null;
    } | undefined;
    if (!row) return null;
    let values: Record<string, string | boolean | string[]> = {};
    if (row.values_json) {
      try {
        const parsed = JSON.parse(row.values_json) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          values = parsed as Record<string, string | boolean | string[]>;
        }
      } catch {
        values = {};
      }
    }
    return { response_id: row.response_id, action_id: row.action_id, values };
  }

  private persistTurnConfig(
    sessionId: string,
    config: Record<string, ConfigValue>,
    extra: Partial<Session> = {},
  ): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET turn_config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), now, sessionId);
    this.broadcastSessionUpdated(sessionId, { turn_config: config, updated_at: now, ...extra });
  }

  private mergeTurnConfig(
    sessionId: string,
    patch: Record<string, ConfigValue>,
    extra: Partial<Session> = {},
  ): Record<string, ConfigValue> {
    const session = this.getSession(sessionId);
    const config = { ...(session.turn_config ?? {}), ...patch };
    this.persistTurnConfig(sessionId, config, extra);
    return config;
  }

  private optionIdForRole(executor: Executor, role: string): string {
    return this.proxySessions.getCapabilities(executor)
      ?.configOptions.find((option) => option.role === role)?.id
      ?? role;
  }

  private saveInteraction(
    sessionId: string,
    interactionId: string,
    record: {
      responseId: string;
      turnId?: string;
      actionId: string;
      values: Record<string, string | boolean | string[]>;
    },
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO proxy_interactions
         (session_id, interaction_id, response_id, turn_id, action_id, outcome, values_json, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(session_id, interaction_id) DO UPDATE SET
         action_id = excluded.action_id,
         values_json = excluded.values_json,
         outcome = NULL,
         resolved_at = NULL`,
    ).run(
      sessionId,
      interactionId,
      record.responseId,
      record.turnId ?? null,
      record.actionId,
      JSON.stringify(record.values),
      now,
    );
  }

  async sendMessage(
    sessionId: string,
    text: string,
    items?: import('@gian/shared').InputItem[],
    oneShotBypass?: boolean,
  ): Promise<void> {
    if (this.sidechats.has(sessionId)) {
      const sidechatItems = items && items.length > 0
        ? items
        : [{ type: 'text' as const, text }];
      await this.sidechats.startTurn(sessionId, sidechatItems);
      return;
    }
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    assertLocalFilesBelongToSession(sessionId, items);
    if (oneShotBypass && session.executor !== 'claude') {
      throw new Error(`One-shot bypass is only supported for Claude sessions; got ${session.executor}.`);
    }
    // Reject before any optimistic writes if a turn is already in flight.
    // The downstream `startTurn` would return SESSION_BUSY, and the catch
    // path used to overwrite session.status to 'error' even though the
    // prior turn is still legitimately running on the proxy side.
    // Callers (WS handler) should route to enqueueMessage when this throws.
    if (this.hasRunningTurn(sessionId)) {
      throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
    }
    const proxySessionId = await this.proxySessions.ensure(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    if (session.executor === 'codex') {
      await ensureSessionAttachmentDir(sessionId, this.dataDir);
    }

    // `ensure()` (and Codex attachment preparation) can yield long enough for
    // an external watcher turn or another send to claim the session. Recheck
    // immediately before the synchronous DB/runtime reservation so neither
    // path can overwrite the active generation.
    if (this.hasRunningTurn(sessionId)) {
      throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
    }

    const turnId = randomUUID();
    const now = new Date().toISOString();
    const turn = this.turns.start(sessionId, turnId, now);
    try {
      this.db.prepare(
        `INSERT INTO proxy_replay_turns
          (session_id, provider_turn_id, turn_id, replay_owned)
         VALUES (?, ?, ?, 0)`,
      ).run(sessionId, turnId, turnId);
    } catch (error) {
      this.turns.rollbackStart(sessionId, turnId);
      throw error;
    }
    const turnNumber = turn.number;

    // Live Sync v2: pause the watcher while a proxy turn is in flight so we
    // don't double-insert events the proxy is also streaming via stdio.
    this.watcher?.pause(sessionId);

    this.db
      .prepare(`UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    this.broadcastSessionUpdated(sessionId, { status: 'running', updated_at: now });

    const attachments = buildAttachmentsFromItems(sessionId, items);
    const userMessagePayload: Record<string, unknown> = { text };
    if (attachments.length > 0) userMessagePayload.attachments = attachments;
    this.persistAndBroadcastUserMessage(
      sessionId,
      turnId,
      turnNumber,
      userMessagePayload,
      Date.parse(now),
    );

    // One-shot bypass: override the per-turn policy without touching
    // session.approval_mode in DB. Applied only for this startTurn — the next
    // user-initiated send falls back to the session's stored mode.
    //
    // The per-Task Manager now honors its `approval_mode` like any other
    // session (decision 2026-06-29, supersedes the earlier forced
    // sandbox:'workspace-write' + approvalPolicy:'never'): its composer is the
    // full session composer, so the mode picker is live and `ask` turns surface
    // real approval cards in the Manager panel. Default mode is 'plan'
    // (read-only + on-request), so a fresh Manager plans/reads until the user
    // escalates it to 'auto' for writes. It still binds the root workspace
    // (`~/Coding`, spanning all projects), so 'auto' there is broad — the mode
    // picker is the gate.
    const catalog = this.proxySessions.getCapabilities(session.executor);
    const turnOptions = session.turn_config_options !== undefined
      ? session.turn_config_options
      : (catalog?.configOptions.filter((option) => option.binding === 'turn') ?? []);
    const config: Record<string, string | boolean | number | null> = {};
    const draft: Record<string, string | boolean | number | null> = {};
    for (const option of turnOptions) {
      const persisted = option.role === 'fast'
        ? undefined
        : session.turn_config?.[option.id]
          ?? session.executor_config.values[option.id];
      const roleValue = option.role === 'model'
        ? session.model
        : option.role === 'effort'
          ? session.thinking_effort
          : option.role === 'approval_mode'
            ? session.approval_mode
            : option.role === 'fast'
              ? session.service_tier === 'fast'
              : undefined;
      const byRole = roleValue === undefined || roleValue === null
        || !option.choices || option.choices.some(choice => Object.is(choice.value, roleValue))
        ? roleValue
        : undefined;
      const draftValue = persisted ?? byRole ?? option.defaultValue;
      let value = draftValue;
      if (oneShotBypass && option.role === 'approval_mode' && option.choices) {
        const bypass = option.choices.find((choice) => (
          String(choice.value).toLowerCase().includes('bypass')
        ));
        if (bypass) value = bypass.value;
      }
      if (draftValue !== undefined && draftValue !== '') draft[option.id] = draftValue;
      if (value !== undefined && value !== '') config[option.id] = value;
    }
    const dispatchItems = items && items.length > 0
      ? translateItemsForExecutor(session.executor, items)
      : [{ type: 'text' as const, text }];
    try {
      const started = await client.startTurn({
        sessionId: proxySessionId,
        turnId,
        input: dispatchItems,
        config,
      });
      this.turns.bindProviderTurn(sessionId, turnId, started.turn.id, true);
      this.persistTurnConfig(sessionId, draft);
    } catch (err) {
      // startTurn rejected. The host already optimistically wrote
      // turn=running / session=running and paused the watcher above; roll
      // it back so the UI doesn't sit on a phantom spinner. The error
      // then bubbles to ws-handler, which forwards it as an `error` WS
      // message.
      //
      // SESSION_BUSY is special: cc-proxy is telling us a prior turn is
      // still alive even though host's activeTurns was empty when this
      // send began (desync — e.g. host restart with orphan proxy). The
      // session and the prior turn aren't broken; only this attempt is.
      // Drop the phantom turn row + user_message event without calling
      // completeTurn, so session.status stays 'running' (the real turn).
      if (err instanceof Error && err.message.includes('[SESSION_BUSY]')) {
        this.turns.rollbackStart(sessionId, turnId);
      } else {
        this.completeTurn(sessionId, 'error');
      }
      this.watcher?.resume(sessionId);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle mutations (M1-D Composer + later session menu)
  // -------------------------------------------------------------------------

  setApprovalMode(sessionId: string, mode: ApprovalMode): void {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const optionId = this.optionIdForRole(session.executor, 'approval_mode');
    const turn_config = { ...(session.turn_config ?? {}), [optionId]: mode };
    this.db
      .prepare(`UPDATE sessions SET approval_mode = ?, turn_config_json = ?, updated_at = ? WHERE id = ?`)
      .run(mode, JSON.stringify(turn_config), now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      approval_mode: mode,
      turn_config,
      updated_at: now,
    });
  }

  setModel(sessionId: string, model: string): void {
    const session = this.getSession(sessionId);
    const trimmed = model.trim();
    const stored = trimmed.length > 0 ? trimmed : null;
    const now = new Date().toISOString();
    const optionId = this.optionIdForRole(session.executor, 'model');
    const turn_config = { ...(session.turn_config ?? {}), [optionId]: stored };
    this.db
      .prepare(`UPDATE sessions SET model = ?, turn_config_json = ?, updated_at = ? WHERE id = ?`)
      .run(stored, JSON.stringify(turn_config), now, sessionId);
    this.broadcastSessionUpdated(sessionId, { model: stored, turn_config, updated_at: now });
  }

  setTurnConfigValue(sessionId: string, optionId: string, value: ConfigValue): void {
    const session = this.getSession(sessionId);
    const option = (session.turn_config_options
      ?? this.proxySessions.getCapabilities(session.executor)?.configOptions)
      ?.find((entry) => entry.id === optionId);
    if (option?.role === 'model') {
      this.setModel(sessionId, value == null ? '' : String(value));
      return;
    }
    if (option?.role === 'effort') {
      this.setEffort(sessionId, value == null ? null : String(value));
      return;
    }
    if (option?.role === 'approval_mode') {
      if (isApprovalMode(value)) this.setApprovalMode(sessionId, value);
      else this.mergeTurnConfig(sessionId, { [optionId]: value });
      return;
    }
    if (option?.role === 'fast') {
      this.setServiceTier(sessionId, value === true ? 'fast' : null);
      return;
    }
    this.mergeTurnConfig(sessionId, { [optionId]: value });
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

  async resolveCatalog(
    executor: Executor,
    params: {
      catalogRevision: string;
      sessionConfig: Record<string, ConfigValue>;
      turnConfig: Record<string, ConfigValue>;
    },
    sessionId?: string,
  ): Promise<ResolvedProxyCatalog> {
    if (sessionId) await this.proxySessions.ensure(this.getSession(sessionId));
    return this.proxySessions.resolveCatalog(executor, params, sessionId);
  }

  /** Returns cached capabilities or null if no session has booted that
   *  executor yet (in which case the caller should warm by spawning). */
  getCapabilities(executor: string): import('@gian/shared').ProxyCatalog | null {
    return this.proxySessions.getCapabilities(executor);
  }

  getProtocolCapabilities(executor: string): Record<string, unknown> | null {
    return this.proxySessions.getProtocolCapabilities(executor);
  }

  async getNativeConfig(sessionId: string): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }> {
    const session = this.getSession(sessionId);
    await this.proxySessions.ensure(session);
    return {
      state: this.getSession(sessionId).executor_config,
      options: this.getSession(sessionId).native_config_options,
    };
  }

  async setNativeConfig(
    sessionId: string,
    configId: string,
    value: NativeConfigValue,
  ): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }> {
    const session = this.getSession(sessionId);
    await this.proxySessions.ensure(session);
    const current = this.getSession(sessionId);
    const state: ExecutorConfigState = {
      schemaVersion: 1,
      values: { ...current.executor_config.values, [configId]: value },
    };
    this.persistNativeConfigSnapshot(sessionId, state, current.native_config_options);
    return { state, options: current.native_config_options };
  }

  async listSessionSlashCommands(
    sessionId: string,
  ): Promise<import('@gian/shared').SlashListResult> {
    const session = this.getSession(sessionId);
    await this.proxySessions.ensure(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    const catalog = await client.catalog();
    return { commands: catalog.slashCommands };
  }

  /** Force-fetch capabilities by spawning a proxy if not cached.
   *  Used by GET /api/proxy/:executor/models when no session exists yet. */
  async warmCapabilities(executor: Executor): Promise<import('@gian/shared').ProxyCatalog> {
    return this.proxySessions.warmCapabilities(executor);
  }

  /** Slash commands for an executor. With cwd, includes project-level. */
  async listSlashCommands(executor: 'codex' | 'claude', cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    return this.proxySessions.listSlashCommands(executor, cwd);
  }

  setEffort(sessionId: string, effort: import('@gian/shared').ThinkingEffort | null): void {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const optionId = this.optionIdForRole(session.executor, 'effort');
    const turn_config = { ...(session.turn_config ?? {}), [optionId]: effort };
    this.db
      .prepare(`UPDATE sessions SET thinking_effort = ?, turn_config_json = ?, updated_at = ? WHERE id = ?`)
      .run(effort, JSON.stringify(turn_config), now, sessionId);
    this.broadcastSessionUpdated(sessionId, { thinking_effort: effort, turn_config, updated_at: now });
  }

  /** codex Fast service tier. 'fast' arms the next codex turn with the Fast
   *  tier; null clears it. Persisted so it survives reloads and rides every
   *  subsequent turn (applies next turn, like /fast). */
  setServiceTier(sessionId: string, tier: 'fast' | null): void {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const optionId = this.optionIdForRole(session.executor, 'fast');
    const turn_config = { ...(session.turn_config ?? {}), [optionId]: tier === 'fast' };
    this.db
      .prepare(`UPDATE sessions SET service_tier = ?, turn_config_json = ?, updated_at = ? WHERE id = ?`)
      .run(tier, JSON.stringify(turn_config), now, sessionId);
    this.broadcastSessionUpdated(sessionId, { service_tier: tier, turn_config, updated_at: now });
  }

  renameSession(sessionId: string, name: string): void {
    this.assertOrdinarySession(sessionId);
    const trimmed = name.trim();
    const stored = trimmed.length > 0 ? trimmed : null;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`)
      .run(stored, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { name: stored, updated_at: now });

    // SESSION-NAME-001: propagate the new name down to the underlying native
    // session so it's distinguishable in the executor's own listings (remote
    // control, resume commands, or ACP session/list). Best-effort +
    // fire-and-forget — the rename itself already succeeded above. We never
    // clear a native name when the Gian name is emptied (cleared name → no-op).
    if (stored) {
      void this.applyNativeSessionName(sessionId, stored).catch(err => {
        console.warn(`[session] native name sync failed for ${sessionId}: ${String(err)}`);
      });
    }
  }

  /**
   * SESSION-NAME-001: push the Gian session name onto the native session.
   *   - claude gian.proxy/1: delegate to the plugin's `session.rename`.
   *   - claude legacy: append a `custom-title` line to the on-disk JSONL.
   *   - codex: `thread/name/set` via the live proxy facade, when one is up.
   *     Otherwise the next bring-up re-applies it (see bringUpProxySession).
   */
  private async applyNativeSessionName(sessionId: string, name: string): Promise<void> {
    const session = this.getSession(sessionId);
    const client = this.proxy.get(sessionId);
    if (client?.setName) {
      await client.setName(name);
      return;
    }
    if (session.executor === 'claude') this.writeClaudeCustomTitle(session, name);
  }

  /** Legacy-only: append a `custom-title` record to a Claude session's JSONL so the name
   *  shows in `claude --resume` / Remote Control listings. No-op when the
   *  session id or file isn't there yet (the first-turn `--name` covers that). */
  private writeClaudeCustomTitle(session: Session, name: string): void {
    const claudeSessionId = session.native_session_id;
    if (!claudeSessionId) return;
    const cwd = this.cwdForSession(session);
    if (!cwd) return;
    const filePath = locateCcJsonl(claudeSessionId, cwd);
    if (!filePath || !existsSync(filePath)) return;
    appendCcCustomTitle(filePath, claudeSessionId, name);
  }

  /** Resolve the working dir for a session (worktree path, else workspace path). */
  private cwdForSession(session: Session): string | null {
    if (session.worktree_path) return session.worktree_path;
    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    return workspace?.path ?? null;
  }

  // -------------------------------------------------------------------------
  // Queue facade (M1-E QueueManager + WS)
  // Track E may refactor; these wrappers exist so ws-handler has a stable
  // call site and the broadcast/popNext machinery lives next to SessionManager.
  // -------------------------------------------------------------------------

  enqueueMessage(sessionId: string, text: string, items?: import('@gian/shared').InputItem[]): void {
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    assertLocalFilesBelongToSession(sessionId, items);
    this.queue.add(sessionId, text, items);
    this.broadcastQueueUpdated(sessionId);
  }

  removeFromQueue(sessionId: string, queueId: string): void {
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    this.queue.remove(sessionId, queueId);
    this.broadcastQueueUpdated(sessionId);
  }

  updateQueueMessage(sessionId: string, queueId: string, text: string): void {
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    this.queue.update(sessionId, queueId, text);
    this.broadcastQueueUpdated(sessionId);
  }

  clearQueue(sessionId: string): void {
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    this.queue.clear(sessionId);
    this.broadcastQueueUpdated(sessionId);
  }

  async sendQueuedNow(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    if (this.turns.has(sessionId)) {
      if (session.executor !== 'codex') {
        // Claude/Kimi have no mid-turn injection — "send now" can't beat the
        // auto-drain. Refuse WITHOUT popping: the old pop-then-SESSION_BUSY
        // path lost the message from both the queue and the transcript.
        throw new Error(`a turn is already running; the queue drains automatically when it completes`);
      }
      // Codex: steer every queued message into the in-flight turn. If the
      // turn completes mid-drain, re-queue whatever hasn't been steered so
      // nothing is lost (auto-drain picks it up next turn).
      const drained = this.queue.sendNow(sessionId);
      if (drained.length === 0) return;
      this.broadcastQueueUpdated(sessionId);
      for (let i = 0; i < drained.length; i++) {
        try {
          await this.steerMessage(sessionId, drained[i]!.text, drained[i]!.items);
        } catch (err) {
          for (let j = i; j < drained.length; j++) {
            this.queue.add(sessionId, drained[j]!.text, drained[j]!.items);
          }
          this.broadcastQueueUpdated(sessionId);
          throw err;
        }
      }
      return;
    }
    // Idle: pop only the head entry. Awaiting sendMessage just unblocks the
    // proxy's startTurn (the turn itself is async); kicking off the next
    // entry from here would race with turn 1 still running and trip
    // SESSION_BUSY, burning the queued text. Let `maybeAutoSendNext` walk the
    // rest of the queue on every turn.completed/failed instead — it's
    // already wired.
    const next = this.queue.popNext(sessionId);
    if (!next) return;
    this.broadcastQueueUpdated(sessionId);
    await this.sendMessage(sessionId, next.text, next.items);
  }

  /** Codex-only mid-turn injection (`turn/steer`): append the message to the
   *  session's ACTIVE turn instead of queueing it for the next one. The user
   *  message is recorded on the active turn so the transcript shows it inline
   *  with the work it steered. */
  async steerMessage(
    sessionId: string,
    text: string,
    items?: import('@gian/shared').InputItem[],
  ): Promise<void> {
    if (this.sidechats.has(sessionId)) {
      await this.sidechats.steerTurn(sessionId, [
        { type: 'text', text },
        ...(items ?? []),
      ]);
      return;
    }
    const session = this.getSession(sessionId);
    assertSessionAcceptsInput(session);
    assertLocalFilesBelongToSession(sessionId, items);
    const client = this.proxy.get(sessionId);
    if (!client?.steerTurn) {
      throw new Error(`${session.executor} does not support steering`);
    }
    const active = this.turns.get(sessionId);
    if (!active) {
      throw new Error(`no active turn for session ${sessionId}; send a normal message instead`);
    }
    const proxySessionId = await this.proxySessions.ensure(session);

    const dispatchItems = items && items.length > 0
      ? translateItemsForExecutor(session.executor, items)
      : [{ type: 'text' as const, text }];
    const attachments = buildAttachmentsFromItems(sessionId, items);
    const userMessagePayload: Record<string, unknown> = { text };
    if (attachments.length > 0) userMessagePayload.attachments = attachments;

    await client.steerTurn({ sessionId: proxySessionId, input: dispatchItems });

    // Only record the message after Codex accepted the steer. Persisting it
    // before the RPC made a rejected steer look successful and caused a
    // re-queued entry to appear twice when it later drained normally.
    this.persistAndBroadcastUserMessage(
      sessionId,
      active.id,
      active.number,
      userMessagePayload,
    );
  }

  // -------------------------------------------------------------------------
  // onEvent hook — M3 IM router subscribes here
  // -------------------------------------------------------------------------

  /** Subscribe to every dispatched provider-native chat event. */
  onEvent(fn: (e: ChatEvent) => void): () => void {
    return this.events.onEvent(fn);
  }

  /** Convenience read for IM router to check queue depth without importing QueueManager. */
  getQueueLength(sessionId: string): number {
    return this.queue.list(sessionId).length;
  }

  // -------------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------------

  getSession(id: string): Session {
    return this.sessions.get(id);
  }

  listSessions(opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Session[] {
    return this.sessions.list(opts);
  }

  completeSubtask(sessionId: string): void {
    this.subtasks.complete(sessionId);
  }

  reopenSubtask(sessionId: string): void {
    this.subtasks.reopen(sessionId);
  }

  abandonSubtask(sessionId: string): void {
    this.subtasks.abandon(sessionId);
  }


  // -------------------------------------------------------------------------
  // Worktree lifecycle (Phase 1)
  //
  // Sessions in worktree mode have a dedicated branch + working directory.
  // After merge or drop, the worktree is gone but the branch+base+outcome
  // remain on the row for history. Terminated sessions are auto-archived;
  // sendMessage is blocked.
  // -------------------------------------------------------------------------

  async mergeWorktree(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.lifecycle.mergeWorktree(sessionId, signal);
  }

  async dropWorktree(sessionId: string): Promise<void> {
    await this.lifecycle.dropWorktree(sessionId);
  }

  private async teardownProxy(sessionId: string): Promise<void> {
    const proxyClient = this.proxy.get(sessionId);
    const proxySessionId = this.proxySessions.get(sessionId);
    if (proxyClient && proxySessionId) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        // Proxy shutdown is best-effort, but it must never hold the session
        // lifecycle guard forever. Catch the RPC promise itself so a late
        // rejection after the deadline cannot become unhandled.
        await Promise.race([
          Promise.resolve()
            .then(() => proxyClient.closeSession(proxySessionId))
            .catch(() => undefined),
          new Promise<void>(resolveTimeout => {
            timeout = setTimeout(resolveTimeout, PROXY_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    this.proxySessions.forget(sessionId);
    this.turns.forget(sessionId);
    this.watcher?.stop(sessionId);
  }

  archiveSession(sessionId: string, archived: boolean): void {
    this.lifecycle.archive(sessionId, archived);
  }

  assignTask(sessionId: string, taskId: string): void {
    this.lifecycle.assignTask(sessionId, taskId);
  }

  notifyTaskSessionsUpdated(taskId: string): void {
    this.lifecycle.notifyTaskSessionsUpdated(taskId);
  }

  /**
   * Toggle the unread marker. Deliberately does NOT touch `updated_at` — read/
   * unread is a view-state change and must not reorder the sidebar. Idempotent.
   */
  setUnread(sessionId: string, unread: boolean): void {
    this.lifecycle.setUnread(sessionId, unread);
  }

  /** Toggle the pinned marker (sidebar ordering). See LifecycleService. */
  setPinned(sessionId: string, pinned: boolean): void {
    this.lifecycle.setPinned(sessionId, pinned);
  }

  /**
   * Permanently delete a session. If the session is a still-live worktree
   * (no outcome yet), drop the worktree first to avoid orphaning the dir
   * on disk. Then teardown proxy + cascade-delete via FK constraints.
   */
  /** Ids of every session owned by a Task (its PM manager + all subtasks).
   *  Used by the cascade delete path in ws-handler `task:delete`. */
  listSessionIdsForTask(taskId: string): string[] {
    return this.lifecycle.listSessionIdsForTask(taskId);
  }

  async deleteSession(sessionId: string, confirmedSidechatIds?: string[]): Promise<void> {
    if (this.sidechats.has(sessionId)) {
      throw requestViolation('SESSION_NOT_FOUND', `session not found: ${sessionId}`);
    }
    await this.sidechats.closeAllForParent(sessionId, confirmedSidechatIds ?? []);
    await this.lifecycle.delete(sessionId);
  }

  listEvents(sessionId: string): EventEnvelope[] {
    this.assertOrdinarySession(sessionId);
    return this.history.listEvents(sessionId);
  }

  listEventPage(sessionId: string, beforeTurn: number | null, pageSize?: number): EventHistoryPage {
    this.assertOrdinarySession(sessionId);
    return this.history.listEventPage(sessionId, beforeTurn, pageSize);
  }

  /**
   * Read-only Trace snapshot for a session. Throws `session not found: <id>`
   * for unknown sessions (same error model as repository-backed reads).
   * Sessions without trace evidence yield an empty partial snapshot.
   */
  getTraceSnapshot(sessionId: string): TraceSnapshot {
    this.assertOrdinarySession(sessionId);
    this.sessions.get(sessionId);
    const rows = this.traceEvidence.listEvidence(sessionId);
    if (rows.length === 0) {
      // A session that never executed a turn has a normal empty trace; only
      // sessions with turns but no recoverable evidence are partial.
      const turnCount = this.db.prepare(
        'SELECT COUNT(*) AS n FROM turns WHERE session_id = ?',
      ).get(sessionId) as { n: number };
      if (turnCount.n === 0) {
        return { sessionId, generatedAt: new Date().toISOString(), partial: false, items: [] };
      }
    }
    return projectTraceSnapshot(sessionId, rows, new Date().toISOString());
  }

  private persistNativeConfigSnapshot(
    sessionId: string,
    state: ExecutorConfigState,
    options: NativeConfigOption[],
  ): void {
    this.events.persistNativeConfigSnapshot(sessionId, state, options);
  }

  private adoptForkChild(client: ProtocolV2SessionClient, sessionId: string): void {
    const existing = this.proxy.get(sessionId);
    if (clientHasAttachedSession(existing)) return;
    if (existing) {
      throw requestViolation('INTERNAL', 'Fork child facade exists without an attachment');
    }
    const child = client.runtimeHost().createSessionClient(sessionId);
    if (!clientHasAttachedSession(child)) {
      throw requestViolation('INTERNAL', 'Fork child was not attached after session.fork');
    }
    this.proxy.adoptExisting(sessionId, child);
    this.proxySessions.attachAdopted(sessionId, sessionId);
  }

  private readForkRequestIdentity(sessionId: string): StoredForkRequestIdentity | null {
    return this.db.prepare(
      `SELECT origin_source_stream_id AS sourceStreamId,
              origin_anchor_type AS anchorType
         FROM sessions
        WHERE id = ? AND origin_kind = 'fork'`,
    ).get(sessionId) as StoredForkRequestIdentity | undefined ?? null;
  }

  private async abandonForkChild(
    client: ProtocolV2SessionClient,
    sessionId: string,
    nativeSessionId?: string | null,
  ): Promise<string[]> {
    const leftovers: string[] = [];
    const host = client.runtimeHost();
    const child = host.createSessionClient(sessionId);
    try {
      await child.closeSession();
    } catch (error) {
      leftovers.push(`session.close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (nativeSessionId && typeof client.deleteNativeSession === 'function') {
      try {
        await client.deleteNativeSession(nativeSessionId);
      } catch (error) {
        leftovers.push(`session.native.delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (typeof host.unregister === 'function') {
      host.unregister(sessionId, child);
    }
    this.proxy.forgetAdopted(sessionId);
    return leftovers;
  }

  private persistKimiReplay(
    sessionId: string,
    updates: unknown[],
    timestamp: string,
    replayStreamId?: string,
  ): { turns: number; events: number } {
    return this.events.persistKimiReplay(sessionId, updates, timestamp, replayStreamId);
  }

  private completeTurn(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
  ): void {
    this.events.completeTurn(sessionId, status);
  }

  private hasRunningTurn(sessionId: string): boolean {
    if (this.turns.has(sessionId)) return true;
    return !!this.db
      .prepare(
        `SELECT 1
         FROM turns
         WHERE session_id = ? AND status = 'running'
         LIMIT 1`,
      )
      .get(sessionId);
  }

  /** Persist and broadcast one canonical user-message envelope. Both paths
   *  must share identity and time so live hydration can converge with history. */
  private persistAndBroadcastUserMessage(
    sessionId: string,
    turnId: string,
    turnNumber: number,
    data: Record<string, unknown>,
    ts = Date.now(),
  ): void {
    const callId = randomUUID();
    this.history.appendEvent(
      sessionId,
      turnId,
      callId,
      'user_message',
      data,
      { createdAt: new Date(ts).toISOString() },
    );
    this.broadcastEvent(sessionId, turnNumber, callId, 'user_message', data, ts);
  }

  private broadcastEvent(
    sessionId: string,
    turn: number,
    callId: string,
    event: string,
    data: Record<string, unknown>,
    ts?: number,
  ): void {
    this.events.broadcastEvent(sessionId, turn, callId, event, data, ts);
  }

  private broadcastSessionUpdated(id: string, partial: Partial<Session>): void {
    this.events.broadcastSessionUpdated(id, partial);
  }

  private broadcastQueueUpdated(sessionId: string): void {
    this.events.broadcastQueueUpdated(sessionId);
  }

  private assertOrdinarySession(sessionId: string): void {
    if (this.sidechats.has(sessionId)) {
      throw requestViolation('SESSION_NOT_FOUND', `session not found: ${sessionId}`);
    }
  }
}

function isV2Client(client: unknown): client is ProtocolV2SessionClient {
  return !!client
    && typeof client === 'object'
    && 'protocolV2' in client
    && (client as { protocolV2?: true }).protocolV2 === true
    && 'runtimeHost' in client;
}

function providerNativeSessionId(session: { nativeSession?: { id?: string } }): string | null {
  const id = session.nativeSession?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

interface StoredForkRequestIdentity {
  sourceStreamId: string | null;
  anchorType: 'head' | 'turn' | null;
}

function isPublishedForkIdentity(
  session: Session,
  identity: StoredForkRequestIdentity | null,
  sourceId: string,
  sourceStreamId: string,
  anchor: SessionForkFromInput['anchor'],
): boolean {
  if (
    session.origin?.kind !== 'fork'
    || session.origin.session_id !== sourceId
    || identity?.sourceStreamId !== sourceStreamId
    || identity.anchorType !== anchor.type
  ) {
    return false;
  }
  if (anchor.type === 'head') return true;
  return session.origin.turn_id === anchor.turnId
    && session.origin.source_turn_id === anchor.sourceTurnId;
}

function clientHasAttachedSession(client: { hasAttachedSession?: () => boolean } | undefined): boolean {
  return typeof client?.hasAttachedSession === 'function' && client.hasAttachedSession();
}

function throwIfForkLeftovers(leftovers: string[], original?: unknown): void {
  if (leftovers.length === 0) return;
  const extra = original instanceof Error ? original.message : original ? String(original) : '';
  throw requestViolation(
    'RUNTIME_ERROR',
    extra
      ? `session.fork left Provider resources: ${leftovers.join('; ')}. ${extra}`
      : `session.fork left Provider resources: ${leftovers.join('; ')}`,
  );
}
