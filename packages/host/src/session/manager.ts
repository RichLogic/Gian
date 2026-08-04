import type {
  ApprovalMode,
  AgentProxyDefaults,
  Executor,
  ExecutorConfigState,
  EventEnvelope,
  NativeConfigOption,
  NativeConfigValue,
  Session,
  ChatEvent,
} from '@gian/shared';
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
import { SessionHistoryStore } from './history-store.js';
import { TurnRuntime } from './turn-runtime.js';
import {
  SessionLifecycleService,
  type CreateSessionInput,
} from './lifecycle-service.js';
import { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import { SessionEventCoordinator } from './event-coordinator.js';
import { SubtaskLifecycle } from './subtask-lifecycle.js';
import { NativeSessionService } from './native-session-service.js';
import { assertApprovalModeAllowed, proxyTurnParamsFor } from './executor-policy.js';
import {
  assertLocalFilesBelongToSession,
  buildAttachmentsFromItems,
  translateItemsForExecutor,
} from './input-items.js';
export type { CreateSessionInput } from './lifecycle-service.js';

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
  private events: SessionEventCoordinator;
  private subtasks: SubtaskLifecycle;
  private nativeSessions: NativeSessionService;

  constructor(
    private db: Db,
    private proxy: ProxyManager,
    broadcaster: WsBroadcaster,
    private approvals: ApprovalManager,
    private queue: QueueManager,
    private dataDir: string,
    /** Live Sync v2 — when present, host mirrors external CLI appends into
     *  events + WS for each active session. Optional so tests can omit. */
    private watcher: NativeJsonlWatcher | null = null,
    private proxyDefaults?: (executor: Executor) => AgentProxyDefaults,
  ) {
    this.sessions = new SessionRepository(db);
    this.history = new SessionHistoryStore(db);
    this.turns = new TurnRuntime(db, this.history);
    this.proxySessions = new ProxySessionCoordinator(
      db,
      proxy,
      this.sessions,
      this.history,
      watcher,
      {
        onNotification: (sessionId, notification) => this.events.handleNotification(sessionId, notification),
        onExit: (sessionId, code) => this.events.handleProxyExit(sessionId, code),
        onSessionUpdated: (sessionId, partial) => this.broadcastSessionUpdated(sessionId, partial),
      },
    );
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
      {
        sendMessage: (sessionId, text, items) => this.sendMessage(sessionId, text, items),
      },
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
        persistKimiReplay: (sessionId, updates, timestamp) =>
          this.persistKimiReplay(sessionId, updates, timestamp),
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

  async listKimiNativeSessions(cwd: string): Promise<import('@gian/shared').NativeSession[]> {
    return this.nativeSessions.listKimi(cwd);
  }

  async adoptKimiNativeSession(input: {
    workspaceId: string;
    cwd: string;
    nativeSessionId: string;
    name?: string;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    return this.nativeSessions.adoptKimi(input);
  }

  async stopTurn(sessionId: string): Promise<void> {
    const proxySessionId = this.proxySessions.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    await client.interruptTurn(proxySessionId);
    // Settle locally: cc-proxy's interruptTurn just kills the runtime and
    // never emits turn.completed/failed, so handleLifecycle won't fire. For
    // codex the turn-failed notification *will* arrive but completeTurn is
    // idempotent (early-returns when activeTurns has nothing). Either way,
    // make sure the UI's spinner clears.
    if (this.turns.has(sessionId)) {
      this.completeTurn(sessionId, 'stopped');
      this.watcher?.resume(sessionId);
    }
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
    this.turns.stopOrphaned(sessionId, now);

    // Force the session row to a clean status. completeTurn already did this
    // if a turn was active in memory; otherwise the row might still say
    // `running` from a prior wedge or `error` from the auto-cleanup.
    this.db
      .prepare(`UPDATE sessions SET status = 'done', updated_at = ? WHERE id = ? AND status != 'done'`)
      .run(now, sessionId);
    this.broadcastSessionUpdated(sessionId, { status: 'done', updated_at: now });

    const client = this.proxy.get(sessionId);
    if (client) client.forceKill();
  }

  async respondApproval(
    sessionId: string,
    approvalId: string,
    decision: import('@gian/shared').ApprovalDecision,
    answers?: Record<string, string | string[]>,
    nativeOptionId?: string,
  ): Promise<void> {
    const gianSession = this.getSession(sessionId);
    const proxySessionId = this.proxySessions.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);

    // Snapshot the pending record before resolving so we can inspect category
    // for plan-mode-exit ceremony below.
    const pending = this.approvals.getPending(approvalId);

    if (gianSession.executor === 'kimi') {
      const option = pending?.nativeOptions?.find(item => item.optionId === nativeOptionId);
      if (!option) {
        throw Object.assign(
          new Error('Select one of the approval options supplied by Kimi.'),
          { code: 'INVALID_APPROVAL_OPTION' },
        );
      }
      const rejected = option.kind.startsWith('reject');
      await client.respondApproval({
        sessionId: proxySessionId,
        approvalId,
        decision: rejected ? 'decline' : 'accept',
        nativeOptionId: option.optionId,
      });
      const resolvedDecision: import('@gian/shared').ApprovalDecision = rejected
        ? 'decline'
        : option.kind === 'allow_always'
          ? 'allow_session'
          : 'allow_once';
      this.approvals.resolve(approvalId, resolvedDecision, 'web');
      return;
    }

    // Plan-mode-exit decisions get mapped to plain allow/deny on the proxy
    // wire; the auto/ask flip happens in the ceremony below. `keep_planning`
    // is a denial — the agent stays in plan mode.
    const isDeny = decision === 'decline' || decision === 'keep_planning';

    if (isDeny) {
      await client.respondApproval({
        sessionId: proxySessionId,
        approvalId,
        decision: 'decline',
      });
    } else {
      await client.respondApproval({
        sessionId: proxySessionId,
        approvalId,
        decision: 'accept',
        // Plan-mode acceptances are inherently one-shot. Session scope only
        // makes sense for repeatable tool approvals (Bash, network, etc.).
        scope: decision === 'allow_session' ? 'session' : 'once',
        ...(answers ? { answers } : {}),
      });
    }

    this.approvals.resolve(approvalId, decision, 'web');

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

  async sendMessage(
    sessionId: string,
    text: string,
    items?: import('@gian/shared').InputItem[],
    oneShotBypass?: boolean,
  ): Promise<void> {
    const session = this.getSession(sessionId);
    assertLocalFilesBelongToSession(sessionId, items);
    if (session.worktree_outcome) {
      throw new Error(`session is ${session.worktree_outcome}; create a new session to continue`);
    }
    // User-completed sessions (completed_at, spec §B) are closed for input
    // until reopened — same rule the web composer enforces visually.
    if (session.completed_at) {
      throw new Error('session is completed; reopen it before sending more messages');
    }
    if (session.executor === 'kimi' && oneShotBypass) {
      throw new Error('Kimi uses its native mode and does not support Gian one-shot bypass.');
    }
    // Reject before any optimistic writes if a turn is already in flight.
    // The downstream `startTurn` would return SESSION_BUSY, and the catch
    // path used to overwrite session.status to 'error' even though the
    // prior turn is still legitimately running on the proxy side.
    // Callers (WS handler) should route to enqueueMessage when this throws.
    if (this.turns.has(sessionId)) {
      throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
    }
    const proxySessionId = await this.proxySessions.ensure(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    const codexAttachmentRoot = session.executor === 'codex'
      ? await ensureSessionAttachmentDir(sessionId, this.dataDir)
      : null;


    const turnId = randomUUID();
    const now = new Date().toISOString();
    const turn = this.turns.start(sessionId, turnId, now);
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
    this.history.appendEvent(sessionId, turnId, randomUUID(), 'user_message', userMessagePayload);
    this.broadcastEvent(sessionId, turnNumber, randomUUID(), 'user_message', userMessagePayload);

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
    const policyParams = session.executor === 'kimi'
      ? {}
      : oneShotBypass
        ? (session.executor === 'claude'
          ? { permissionMode: 'bypassPermissions' as const }
          : {
              sandbox: 'danger-full-access' as const,
              approvalPolicy: 'never' as const,
              approvalsReviewer: 'auto_review' as const,
            })
        : proxyTurnParamsFor(
            session.executor,
            session.approval_mode ?? (() => {
              throw new Error(`${session.executor} session is missing approval_mode`);
            })(),
          );
    // Use structured items when caller supplied them (e.g. codex skill
    // dispatch), fall back to wrapping plain text. cc-proxy doesn't have
    // skill semantics — host translates skill→text for cc just below.
    const dispatchItems = items && items.length > 0
      ? translateItemsForExecutor(session.executor, items)
      : [{ type: 'text' as const, text }];
    try {
      await client.startTurn({
        sessionId: proxySessionId,
        input: dispatchItems,
        ...(codexAttachmentRoot
          ? { additionalWorkspaceRoots: [codexAttachmentRoot] }
          : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.thinking_effort ? { thinking: session.thinking_effort } : {}),
        // codex Fast service tier — set from the composer's Fast toggle. The
        // one-shot bypass path never sets it; only a persisted 'fast' rides here.
        ...(session.executor === 'codex' && session.service_tier
          ? { serviceTier: session.service_tier }
          : {}),
        // SESSION-NAME-001: carry the Gian name so cc-proxy can stamp it onto a
        // brand-new Claude session via `--name` on its first (--session-id) turn.
        // cc-proxy ignores it on resume turns; codex ignores the field entirely.
        ...(session.executor === 'claude' && session.name ? { displayName: session.name } : {}),
        ...policyParams,
      });
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
    if (session.executor === 'kimi') {
      throw new Error('Kimi mode is executor-native; use session:set_native_config.');
    }
    assertApprovalModeAllowed(session.executor, mode);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET approval_mode = ?, updated_at = ? WHERE id = ?`)
      .run(mode, now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      approval_mode: mode,
      updated_at: now,
    });
  }

  setModel(sessionId: string, model: string): void {
    const trimmed = model.trim();
    const stored = trimmed.length > 0 ? trimmed : null;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`)
      .run(stored, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { model: stored, updated_at: now });
  }

  /** Returns cached capabilities or null if no session has booted that
   *  executor yet (in which case the caller should warm by spawning). */
  getCapabilities(executor: string): import('@gian/shared').ProxyCapabilities | null {
    return this.proxySessions.getCapabilities(executor);
  }

  async getNativeConfig(sessionId: string): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }> {
    const session = this.getSession(sessionId);
    await this.proxySessions.ensure(session);
    const client = this.proxy.get(sessionId);
    if (!client?.getNativeConfig) {
      return {
        state: session.executor_config,
        options: session.native_config_options,
      };
    }
    const snapshot = await client.getNativeConfig();
    this.persistNativeConfigSnapshot(sessionId, snapshot.state, snapshot.options);
    return snapshot;
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
    const client = this.proxy.get(sessionId);
    if (!client?.setNativeConfig) {
      throw new Error(`${session.executor} does not expose executor-native session config`);
    }
    const snapshot = await client.setNativeConfig(configId, value);
    this.persistNativeConfigSnapshot(sessionId, snapshot.state, snapshot.options);
    return snapshot;
  }

  async listSessionSlashCommands(
    sessionId: string,
  ): Promise<import('@gian/shared').SlashListResult> {
    const session = this.getSession(sessionId);
    await this.proxySessions.ensure(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    return client.listSlashCommands(this.cwdForSession(session) ?? undefined);
  }

  /** Force-fetch capabilities by spawning a proxy if not cached.
   *  Used by GET /api/proxy/:executor/models when no session exists yet. */
  async warmCapabilities(executor: Executor): Promise<import('@gian/shared').ProxyCapabilities> {
    return this.proxySessions.warmCapabilities(executor);
  }

  /** Slash commands for an executor. With cwd, includes project-level. */
  async listSlashCommands(executor: 'codex' | 'claude', cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    return this.proxySessions.listSlashCommands(executor, cwd);
  }

  setEffort(sessionId: string, effort: import('@gian/shared').ThinkingEffort | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET thinking_effort = ?, updated_at = ? WHERE id = ?`)
      .run(effort, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { thinking_effort: effort, updated_at: now });
  }

  /** codex Fast service tier. 'fast' arms the next codex turn with the Fast
   *  tier; null clears it. Persisted so it survives reloads and rides every
   *  subsequent turn (applies next turn, like /fast). */
  setServiceTier(sessionId: string, tier: 'fast' | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET service_tier = ?, updated_at = ? WHERE id = ?`)
      .run(tier, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { service_tier: tier, updated_at: now });
  }

  renameSession(sessionId: string, name: string): void {
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
   *   - claude: append a `custom-title` line to the on-disk JSONL (instant,
   *     zero ripple — `parseCcLine` ignores non-message lines). Only when the
   *     JSONL already exists; before the first turn the cc-proxy `--name` flag
   *     covers it.
   *   - codex: `thread/name/set` via the live proxy facade, when one is up.
   *     Otherwise the next bring-up re-applies it (see bringUpProxySession).
   */
  private async applyNativeSessionName(sessionId: string, name: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.executor === 'claude') {
      this.writeClaudeCustomTitle(session, name);
    } else if (session.executor === 'codex') {
      const client = this.proxy.get(sessionId);
      if (client?.setName) await client.setName(name);
    }
  }

  /** Append a `custom-title` record to a Claude session's JSONL so the name
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
    assertLocalFilesBelongToSession(sessionId, items);
    this.queue.add(sessionId, text, items);
    this.broadcastQueueUpdated(sessionId);
  }

  removeFromQueue(sessionId: string, queueId: string): void {
    this.queue.remove(sessionId, queueId);
    this.broadcastQueueUpdated(sessionId);
  }

  reorderQueue(sessionId: string, orderedIds: string[]): void {
    this.queue.reorder(sessionId, orderedIds);
    this.broadcastQueueUpdated(sessionId);
  }

  clearQueue(sessionId: string): void {
    this.queue.clear(sessionId);
    this.broadcastQueueUpdated(sessionId);
  }

  async sendQueuedNow(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
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
    const session = this.getSession(sessionId);
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
    this.history.appendEvent(sessionId, active.id, randomUUID(), 'user_message', userMessagePayload);
    this.broadcastEvent(sessionId, active.number, randomUUID(), 'user_message', userMessagePayload);
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

  async mergeWorktree(sessionId: string): Promise<void> {
    await this.lifecycle.mergeWorktree(sessionId);
  }

  async dropWorktree(sessionId: string): Promise<void> {
    await this.lifecycle.dropWorktree(sessionId);
  }

  private async teardownProxy(sessionId: string): Promise<void> {
    const proxyClient = this.proxy.get(sessionId);
    const proxySessionId = this.proxySessions.get(sessionId);
    if (proxyClient && proxySessionId) {
      try { await proxyClient.closeSession(proxySessionId); } catch { /* ignore */ }
    }
    this.proxySessions.forget(sessionId);
    this.turns.forget(sessionId);
    this.watcher?.stop(sessionId);
  }

  archiveSession(sessionId: string, archived: boolean): void {
    this.lifecycle.archive(sessionId, archived);
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

  async deleteSession(sessionId: string): Promise<void> {
    await this.lifecycle.delete(sessionId);
  }

  listEvents(sessionId: string): EventEnvelope[] {
    return this.history.listEvents(sessionId);
  }

  private persistNativeConfigSnapshot(
    sessionId: string,
    state: ExecutorConfigState,
    options: NativeConfigOption[],
  ): void {
    this.events.persistNativeConfigSnapshot(sessionId, state, options);
  }

  private persistKimiReplay(
    sessionId: string,
    updates: unknown[],
    timestamp: string,
  ): { turns: number; events: number } {
    return this.events.persistKimiReplay(sessionId, updates, timestamp);
  }

  private completeTurn(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
  ): void {
    this.events.completeTurn(sessionId, status);
  }

  private broadcastEvent(
    sessionId: string,
    turn: number,
    callId: string,
    event: string,
    data: Record<string, unknown>,
  ): void {
    this.events.broadcastEvent(sessionId, turn, callId, event, data);
  }

  private broadcastSessionUpdated(id: string, partial: Partial<Session>): void {
    this.events.broadcastSessionUpdated(id, partial);
  }

  private broadcastQueueUpdated(sessionId: string): void {
    this.events.broadcastQueueUpdated(sessionId);
  }

}
