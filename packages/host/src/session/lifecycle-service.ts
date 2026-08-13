import type {
  AgentProxyDefaults,
  ApprovalMode,
  Executor,
  NativeConfigOption,
  Session,
  SessionType,
  ThinkingEffort,
  WorktreeOutcome,
} from '@gian/shared';
import { usesNativeExecutorConfig } from '@gian/shared';
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
  workspace_id: string;
  executor: Executor;
  name?: string;
  model?: string | null;
  approval_mode?: ApprovalMode;
  type?: SessionType;
  task_id?: string | null;
  thinking_effort?: ThinkingEffort | null;
  service_tier?: 'fast' | null;
}

interface BringUpInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  displayName: string | null;
  executorDefaults?: AgentProxyDefaults;
}

interface BringUpResult {
  nativeSessionId: string;
  configOptions: NativeConfigOption[];
}

interface LifecycleRuntime {
  bringUpProxySession(input: BringUpInput): Promise<BringUpResult>;
  discardProxy(sessionId: string): Promise<void>;
  teardownProxy(sessionId: string): Promise<void>;
  forgetConversationUsage(sessionId: string): void;
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
  ) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const workspace = this.db
      .prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(input.workspace_id) as { id: string; path: string } | undefined;
    if (!workspace) throw new Error(`workspace not found: ${input.workspace_id}`);

    const id = randomUUID();
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
    if (input.executor !== 'codex' && input.service_tier != null) {
      throw new Error('service_tier is codex-only');
    }
    const serviceTier = input.executor === 'codex' ? input.service_tier ?? null : null;
    if (usesNativeExecutorConfig(input.executor) && input.approval_mode !== undefined) {
      throw new Error(`${input.executor} uses executor-native mode; approval_mode must be omitted`);
    }
    const managedDefaults = this.proxyDefaults?.(input.executor);
    const configuredMode = managedDefaults?.mode.trim() ?? '';
    const fallbackMode: ApprovalMode = managedDefaults ? 'ask' : 'auto';
    const approvalMode: ApprovalMode | null = usesNativeExecutorConfig(input.executor)
      ? null
      : (input.approval_mode ?? (configuredMode || fallbackMode) as ApprovalMode);
    if (approvalMode) assertApprovalModeAllowed(input.executor, approvalMode);

    const cfg = loadConfig(this.db);
    const defaultModel = managedDefaults
      ? managedDefaults.model.trim()
      : input.executor === 'claude'
        ? cfg.default_claude_model.trim()
        : input.executor === 'codex'
          ? cfg.default_codex_model.trim()
          : '';
    const defaultEffort = managedDefaults
      ? managedDefaults.thinking.trim()
      : input.executor === 'claude'
        ? cfg.default_claude_effort.trim()
        : input.executor === 'codex'
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
        executor: input.executor,
        cwd: workspace.path,
        model: effectiveModel,
        displayName: name,
        // These are semantic roles owned by Gian's Settings UI, not ACP
        // config ids. The coordinator resolves each role against the
        // configOptions returned by this exact Kimi session before applying
        // the value.
        ...(usesNativeExecutorConfig(input.executor) && managedDefaults
          ? {
              executorDefaults: {
                model: defaultModel,
                thinking: defaultEffort,
                mode: configuredMode,
              },
            }
          : {}),
      });
    } catch (error) {
      await this.runtime.discardProxy(id);
      throw error;
    }

    this.db
      .prepare(
        `INSERT INTO sessions
          (id, name, type, task_id, workspace_id, executor, model, approval_mode,
           executor_config_json, thinking_effort, service_tier, active_channel, status,
           archived, worktree_path, branch, base_branch, worktree_outcome,
           native_session_id, fork_from_session_id, conversation_usage_complete,
           created_at, updated_at)
         VALUES
          (@id, @name, @type, @task_id, @workspace_id, @executor, @model,
           @approval_mode, @executor_config_json, @thinking_effort, @service_tier, 'web', 'new',
           0, NULL, NULL, NULL, NULL, @native_session_id,
           @fork_from_session_id, 1, @now, @now)`,
      )
      .run({
        id,
        name,
        type: input.type ?? 'coding',
        task_id: input.task_id ?? null,
        workspace_id: input.workspace_id,
        executor: input.executor,
        model: effectiveModel,
        approval_mode: approvalMode,
        executor_config_json: JSON.stringify(executorConfigFromOptions(proxyResult.configOptions)),
        thinking_effort: effectiveEffort,
        service_tier: serviceTier,
        native_session_id: proxyResult.nativeSessionId,
        fork_from_session_id: null,
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
