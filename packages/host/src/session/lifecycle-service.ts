import type {
  AgentProxyDefaults,
  ApprovalMode,
  ConfigOption,
  ConfigValue,
  Executor,
  NativeConfigOption,
  Session,
  SessionType,
  ThinkingEffort,
  UserAgent,
  WorktreeOutcome,
} from '@gian/shared';
import { migrateLegacyGrokProxyDefaults, usesNativeExecutorConfig } from '@gian/shared';
import { randomUUID } from 'node:crypto';
import type { ApprovalManager } from '../approval/index.js';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { purgeSessionAttachments } from '../storage/attachments.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { mergeBranchAsync } from '../workspace/git.js';
import {
  executorConfigFromOptions,
  type SessionRepository,
} from './repository.js';

export interface CreateSessionInput {
  /** Stable Host id used by idempotent non-UI callers. */
  id?: string;
  workspace_id: string;
  /** Owning user Agent. Required for interactive creation (WS
   *  `session:create`); the Proxy kind, defaults, and CLI path resolve from
   *  it. Legacy callers without an Agent keep kind-level `executor`. */
  agent_id?: string;
  executor?: Executor;
  name?: string;
  model?: string | null;
  approval_mode?: ApprovalMode;
  type?: SessionType;
  task_id?: string | null;
  thinking_effort?: ThinkingEffort | null;
  service_tier?: 'fast' | null;
  session_config?: Record<string, ConfigValue>;
  turn_config?: Record<string, ConfigValue>;
}

interface BringUpInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  displayName: string | null;
  /** Owning Agent's resolved CLI path (injected by SessionManager). */
  cliPath?: string | null;
  executorDefaults?: AgentProxyDefaults;
  sessionConfig?: Record<string, ConfigValue>;
}

interface BringUpResult {
  nativeSessionId: string;
  configOptions: NativeConfigOption[];
  turnConfigOptions?: ConfigOption[];
  turnConfigRevision?: string;
  availableActions?: import('@gian/shared').SessionAvailableActions;
}

interface LifecycleRuntime {
  bringUpProxySession(input: BringUpInput): Promise<BringUpResult>;
  discardProxy(sessionId: string): Promise<void>;
  teardownProxy(sessionId: string): Promise<void>;
  forgetConversationUsage(sessionId: string): void;
}

function initialTurnConfigFromCreate(
  explicit: Record<string, ConfigValue> | undefined,
  options: NativeConfigOption[],
  roles: {
    model: string | null;
    effort: ThinkingEffort | null;
    mode: string | null;
    serviceTier: 'fast' | null;
  },
): Record<string, ConfigValue> {
  const config: Record<string, ConfigValue> = { ...(explicit ?? {}) };
  for (const option of options) {
    if (option.scope !== 'turn' || config[option.id] !== undefined) continue;
    if (option.category === 'model' && roles.model) config[option.id] = roles.model;
    else if (option.category === 'effort' && roles.effort) config[option.id] = roles.effort;
    else if (option.category === 'approval_mode' && roles.mode
      && (!option.choices || option.choices.some(choice => Object.is(choice.value, roles.mode)))) {
      config[option.id] = roles.mode;
    } else if (option.category === 'fast') config[option.id] = roles.serviceTier === 'fast';
  }
  return config;
}

function assertApprovalModeAllowed(executor: Executor, mode: ApprovalMode): void {
  const allowedModes = new Set<ApprovalMode>(['plan', 'ask', 'auto', 'custom', 'full-access']);
  if (!allowedModes.has(mode)) {
    throw new Error(`unsupported approval mode: ${mode}`);
  }
  if ((mode === 'custom' || mode === 'full-access') && executor !== 'codex') {
    throw new Error(`${mode} approval mode is codex-only`);
  }
}

export class WorktreeLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeLifecycleConflictError';
  }
}

export class SessionLifecycleBusyError extends Error {
  constructor(sessionId: string) {
    super(`session lifecycle operation already in progress: ${sessionId}`);
    this.name = 'SessionLifecycleBusyError';
  }
}

export class SessionLifecycleService {
  private readonly activeSessionLifecycles = new Set<string>();

  constructor(
    private db: Db,
    private sessions: SessionRepository,
    private approvals: ApprovalManager,
    private broadcaster: WsBroadcaster,
    private runtime: LifecycleRuntime,
    private proxyDefaults?: (executor: Executor) => AgentProxyDefaults | undefined,
    /** Resolves a saved Agent and its runtime CLI path. Must throw when the
     *  Agent id is unknown (deleted Agents cannot start new sessions). */
    private agentRuntime?: (agentId: string) => { agent: UserAgent; cliPath: string | null },
  ) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const workspace = this.db
      .prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(input.workspace_id) as { id: string; path: string } | undefined;
    if (!workspace) throw new Error(`workspace not found: ${input.workspace_id}`);

    const resolvedAgent = input.agent_id !== undefined
      ? this.agentRuntime?.(input.agent_id)
      : undefined;
    if (input.agent_id !== undefined && !resolvedAgent) {
      throw new Error(`agent not found: ${input.agent_id}`);
    }
    const executor = resolvedAgent?.agent.proxy ?? input.executor;
    if (!executor) throw new Error('session requires an agent_id or an executor');
    if (resolvedAgent && input.executor && input.executor !== resolvedAgent.agent.proxy) {
      throw new Error(
        `agent ${input.agent_id} is a ${resolvedAgent.agent.proxy} Agent, not ${input.executor}`,
      );
    }

    if (input.task_id !== undefined && input.task_id !== null) {
      const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.task_id) as
        { status: string } | undefined;
      if (!task) throw new Error(`task not found: ${input.task_id}`);
      if (task.status !== 'open') throw new Error(`task is not open: ${input.task_id}`);
      if (input.type !== 'subtask') throw new Error('task_id requires a subtask session');
    } else if (input.type === 'subtask') {
      throw new Error('subtask session requires task_id');
    }

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    // Treat a blank title exactly like an omitted title at the Host boundary.
    // The Web client already omits blank values, but protocol/API callers can
    // send an empty string. Persisting that value would permanently exclude
    // the session from auto-title, whose unnamed contract is `name IS NULL`.
    const name = typeof input.name === 'string' ? input.name.trim() || null : null;
    if (input.service_tier !== undefined
      && input.service_tier !== null
      && input.service_tier !== 'fast') {
      throw new Error(`unsupported service tier: ${String(input.service_tier)}`);
    }
    if (executor !== 'codex' && input.service_tier != null) {
      throw new Error('service_tier is codex-only');
    }
    const serviceTier = executor === 'codex' ? input.service_tier ?? null : null;
    if (usesNativeExecutorConfig(executor) && input.approval_mode !== undefined) {
      throw new Error(`${executor} uses executor-native mode; approval_mode must be omitted`);
    }
    const managedDefaults = resolvedAgent
      ? resolvedAgent.agent.defaults
      : executor === 'grok'
        ? migrateLegacyGrokProxyDefaults(this.proxyDefaults?.(executor) ?? {
          model: '',
          thinking: '',
          mode: '',
        })
        : this.proxyDefaults?.(executor);
    const configuredMode = managedDefaults?.mode.trim() ?? '';
    const fallbackMode: ApprovalMode = managedDefaults ? 'ask' : 'auto';
    const approvalMode: ApprovalMode | null = usesNativeExecutorConfig(executor)
      ? null
      : (input.approval_mode ?? (configuredMode || fallbackMode) as ApprovalMode);
    if (approvalMode) assertApprovalModeAllowed(executor, approvalMode);

    const cfg = loadConfig(this.db);
    const defaultModel = managedDefaults
      ? managedDefaults.model.trim()
      : executor === 'claude'
        ? cfg.default_claude_model.trim()
        : executor === 'codex'
          ? cfg.default_codex_model.trim()
          : '';
    const defaultEffort = managedDefaults
      ? managedDefaults.thinking.trim()
      : executor === 'claude'
        ? cfg.default_claude_effort.trim()
        : executor === 'codex'
          ? cfg.default_codex_effort.trim()
          : '';
    const explicitModel = typeof input.model === 'string' ? input.model.trim() : '';
    const effectiveModel = explicitModel || defaultModel || null;
    const explicitEffort = typeof input.thinking_effort === 'string'
      ? input.thinking_effort.trim()
      : '';
    const effectiveEffort: ThinkingEffort | null = explicitEffort
      ? explicitEffort as ThinkingEffort
      : defaultEffort
        ? defaultEffort as ThinkingEffort
        : null;

    let proxyResult: BringUpResult;
    try {
      proxyResult = await this.runtime.bringUpProxySession({
        sessionId: id,
        executor,
        cwd: workspace.path,
        model: effectiveModel,
        displayName: name,
        ...(resolvedAgent ? { cliPath: resolvedAgent.cliPath } : {}),
        // Semantic roles owned by Gian Settings. The coordinator resolves
        // each role against this session's catalog before sending config.
        ...(managedDefaults
          ? {
              executorDefaults: {
                model: defaultModel,
                thinking: defaultEffort,
                mode: configuredMode,
              },
            }
          : {}),
        ...(input.session_config ? { sessionConfig: input.session_config } : {}),
      });
    } catch (error) {
      await this.runtime.discardProxy(id);
      throw error;
    }

    const initialTurnConfig = initialTurnConfigFromCreate(
      input.turn_config,
      proxyResult.configOptions,
      {
        model: effectiveModel,
        effort: effectiveEffort,
        mode: usesNativeExecutorConfig(executor)
          ? configuredMode || null
          : approvalMode,
        serviceTier,
      },
    );
    this.db
      .prepare(
        `INSERT INTO sessions
          (id, name, type, task_id, workspace_id, executor, agent_id, agent_name, agent_color,
           model, approval_mode,
           executor_config_json, thinking_effort, service_tier, active_channel, status,
           archived, worktree_path, branch, base_branch, worktree_outcome,
           native_session_id, fork_from_session_id, conversation_usage_complete,
           turn_config_json, turn_config_options_json, turn_config_revision,
           available_actions_json, created_at, updated_at)
         VALUES
          (@id, @name, @type, @task_id, @workspace_id, @executor, @agent_id, @agent_name,
           @agent_color, @model,
           @approval_mode, @executor_config_json, @thinking_effort, @service_tier, 'web', 'new',
           0, NULL, NULL, NULL, NULL, @native_session_id,
           @fork_from_session_id, 1,
           @turn_config_json, @turn_config_options_json, @turn_config_revision,
           @available_actions_json, @now, @now)`,
      )
      .run({
        id,
        name,
        type: input.type ?? 'coding',
        task_id: input.task_id ?? null,
        workspace_id: input.workspace_id,
        executor,
        agent_id: resolvedAgent?.agent.id ?? null,
        agent_name: resolvedAgent?.agent.name ?? null,
        agent_color: resolvedAgent?.agent.color ?? null,
        model: effectiveModel,
        approval_mode: approvalMode,
        executor_config_json: JSON.stringify(executorConfigFromOptions(proxyResult.configOptions)),
        thinking_effort: effectiveEffort,
        service_tier: serviceTier,
        native_session_id: proxyResult.nativeSessionId,
        fork_from_session_id: null,
        turn_config_json: JSON.stringify(initialTurnConfig),
        turn_config_options_json: proxyResult.turnConfigOptions !== undefined
          ? JSON.stringify(proxyResult.turnConfigOptions)
          : null,
        turn_config_revision: proxyResult.turnConfigRevision ?? null,
        available_actions_json: proxyResult.availableActions
          ? JSON.stringify(proxyResult.availableActions)
          : null,
        now,
      });
    this.sessions.setNativeOptions(id, proxyResult.configOptions);

    return this.sessions.get(id);
  }

  async mergeWorktree(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.withExclusiveSessionLifecycle(sessionId, async () => {
      // Read state only after acquiring ownership so a later retry observes
      // the outcome written by the operation that previously held it.
      const session = this.worktreeSession(sessionId);
      if (!session.branch || !session.base_branch) {
        throw new WorktreeLifecycleConflictError('session is not in worktree mode');
      }
      if (session.worktree_outcome) {
        throw new WorktreeLifecycleConflictError(`session already ${session.worktree_outcome}`);
      }
      const workspace = this.workspaceFor(session);
      await mergeBranchAsync(
        workspace.path,
        session.branch,
        session.base_branch,
        signal ? { signal } : {},
      );
      await this.runtime.teardownProxy(sessionId);
      this.finalizeWorktree(sessionId, 'merged');
      if (session.workspace_id != null) {
        this.broadcastWorkspaceGitUpdated(session.workspace_id, 'merge');
      }
    });
  }

  async dropWorktree(sessionId: string): Promise<void> {
    await this.withExclusiveSessionLifecycle(sessionId, async () => {
      const session = this.worktreeSession(sessionId);
      if (!session.branch) {
        throw new WorktreeLifecycleConflictError('session is not in worktree mode');
      }
      if (session.worktree_outcome) {
        throw new WorktreeLifecycleConflictError(`session already ${session.worktree_outcome}`);
      }
      await this.runtime.teardownProxy(sessionId);
      this.finalizeWorktree(sessionId, 'discarded');
      if (session.workspace_id != null) {
        this.broadcastWorkspaceGitUpdated(session.workspace_id, 'drop');
      }
    });
  }

  archive(sessionId: string, archived: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, now, sessionId);
    if (archived) {
      this.broadcastSessionUpdated(sessionId, { archived: 1, updated_at: now });
    } else {
      // Restored sessions are absent from active-only client state. Send the
      // full row so clients can reinsert it rather than merge into nothing.
      this.broadcastSessionUpdated(sessionId, this.sessions.get(sessionId));
    }
  }

  /**
   * File an existing standalone Session under an open Task. The checks and
   * write are one synchronous SQLite transaction so no caller can observe a
   * Task/session eligibility check that no longer matches the committed row.
   */
  assignTask(sessionId: string, taskId: string): void {
    const now = new Date().toISOString();
    const assign = this.db.transaction((): string => {
      const task = this.db
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(taskId) as { status: string } | undefined;
      if (!task) throw new Error(`task not found: ${taskId}`);
      if (task.status !== 'open') throw new Error(`task is not open: ${taskId}`);

      const session = this.db
        .prepare('SELECT type, task_id, archived, updated_at FROM sessions WHERE id = ?')
        .get(sessionId) as {
          type: SessionType;
          task_id: string | null;
          archived: 0 | 1;
          updated_at: string;
        } | undefined;
      if (!session) throw new Error(`session not found: ${sessionId}`);
      if (session.archived !== 0) throw new Error(`session is archived: ${sessionId}`);
      // A retry after a lost result is a successful no-op. Re-broadcast the
      // stored state below so a reconnecting client can still converge.
      if (session.type === 'subtask' && session.task_id === taskId) {
        return session.updated_at;
      }
      if (session.type !== 'coding' || session.task_id !== null) {
        throw new Error(`session is not an independent coding session: ${sessionId}`);
      }

      const result = this.db
        .prepare(
          `UPDATE sessions
           SET type = 'subtask', task_id = ?, updated_at = ?
           WHERE id = ? AND archived = 0 AND type = 'coding' AND task_id IS NULL`,
        )
        .run(taskId, now, sessionId);
      if (result.changes !== 1) {
        throw new Error(`session is not assignable: ${sessionId}`);
      }
      return now;
    });

    const updatedAt = assign();
    this.broadcastSessionUpdated(sessionId, {
      type: 'subtask',
      task_id: taskId,
      updated_at: updatedAt,
    });
  }

  notifyTaskSessionsUpdated(taskId: string): void {
    const ids = this.db
      .prepare('SELECT id FROM sessions WHERE task_id = ?')
      .all(taskId) as Array<{ id: string }>;
    for (const { id } of ids) {
      this.broadcastSessionUpdated(id, this.sessions.get(id));
    }
  }

  setUnread(sessionId: string, unread: boolean): void {
    this.db
      .prepare('UPDATE sessions SET unread = ? WHERE id = ?')
      .run(unread ? 1 : 0, sessionId);
    this.broadcastSessionUpdated(sessionId, { unread: unread ? 1 : 0 });
  }

  /** Toggle the pinned marker. Like unread, deliberately does NOT touch
   *  `updated_at` — the sidebar orders pinned sessions by `pinned_at`. */
  setPinned(sessionId: string, pinned: boolean): void {
    const pinnedAt = pinned ? new Date().toISOString() : null;
    this.db
      .prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?')
      .run(pinnedAt, sessionId);
    this.broadcastSessionUpdated(sessionId, { pinned_at: pinnedAt });
  }

  listSessionIdsForTask(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE task_id = ?')
      .all(taskId) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  async delete(sessionId: string): Promise<void> {
    await this.withExclusiveSessionLifecycle(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      await this.runtime.teardownProxy(sessionId);
      this.runtime.forgetConversationUsage(sessionId);
      this.sessions.forget(sessionId);
      this.approvals.clearSession(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      await purgeSessionAttachments(sessionId);
      this.broadcaster.broadcast({ type: 'session:deleted', session_id: sessionId });
      if (session.branch && session.workspace_id != null) {
        this.broadcastWorkspaceGitUpdated(session.workspace_id, 'session-deleted');
      }
    });
  }

  private async withExclusiveSessionLifecycle<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Lifecycle operations include proxy RPC and filesystem cleanup. Do not
    // build an unbounded per-session promise queue behind a slow/hung owner:
    // callers get a stable conflict response and may retry after it finishes.
    if (this.activeSessionLifecycles.has(sessionId)) {
      throw new SessionLifecycleBusyError(sessionId);
    }
    this.activeSessionLifecycles.add(sessionId);
    try {
      return await operation();
    } finally {
      this.activeSessionLifecycles.delete(sessionId);
    }
  }

  private workspaceFor(session: Session): { path: string } {
    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${session.id}`);
    return workspace;
  }

  private worktreeSession(sessionId: string): Session {
    try {
      return this.sessions.get(sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === `session not found: ${sessionId}`) {
        throw new WorktreeLifecycleConflictError(error.message);
      }
      throw error;
    }
  }

  private finalizeWorktree(sessionId: string, outcome: WorktreeOutcome): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET worktree_outcome = ?, worktree_path = NULL, archived = 1,
             status = 'done', updated_at = ?
         WHERE id = ?`,
      )
      .run(outcome, now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      worktree_outcome: outcome,
      worktree_path: null,
      archived: 1,
      status: 'done',
      updated_at: now,
    });
  }

  private broadcastSessionUpdated(id: string, partial: Partial<Session>): void {
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id, ...partial },
    });
  }

  private broadcastWorkspaceGitUpdated(
    workspaceId: string,
    reason: 'merge' | 'drop' | 'session-deleted',
  ): void {
    this.broadcaster.broadcast({
      type: 'workspace:git-updated',
      workspace_id: workspaceId,
      reason,
    });
  }
}
