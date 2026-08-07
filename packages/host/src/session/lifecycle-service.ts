import type {
  AgentProxyDefaults,
  ApprovalMode,
  Executor,
  ExecutorConfigState,
  NativeConfigOption,
  Session,
  SessionType,
  ThinkingEffort,
  WorktreeOutcome,
} from '@gian/shared';
import { randomUUID } from 'node:crypto';
import type { ApprovalManager } from '../approval/index.js';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { purgeSessionAttachments } from '../storage/attachments.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { mergeBranch } from '../workspace/git.js';
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
}

interface BringUpInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  displayName: string | null;
  executorConfig?: ExecutorConfigState;
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

export class SessionLifecycleService {
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
    if (input.executor === 'kimi' && input.approval_mode !== undefined) {
      throw new Error('Kimi uses executor-native mode; approval_mode must be omitted');
    }
    const managedDefaults = this.proxyDefaults?.(input.executor);
    const configuredMode = managedDefaults?.mode.trim() ?? '';
    const fallbackMode: ApprovalMode = managedDefaults ? 'ask' : 'auto';
    const approvalMode: ApprovalMode | null = input.executor === 'kimi'
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
      // Kimi applies executor defaults through its ACP config options. The
      // values keys are the native option ids Kimi advertises in
      // configOptions (model / thought_level / mode), applied via
      // setNativeConfig during bring-up.
      const kimiConfigValues: Record<string, string> = {};
      if (input.executor === 'kimi') {
        if (defaultModel) kimiConfigValues.model = defaultModel;
        if (defaultEffort) kimiConfigValues.thought_level = defaultEffort;
        if (configuredMode) kimiConfigValues.mode = configuredMode;
      }
      proxyResult = await this.runtime.bringUpProxySession({
        sessionId: id,
        executor: input.executor,
        cwd: workspace.path,
        model: effectiveModel,
        displayName: input.name ?? null,
        ...(Object.keys(kimiConfigValues).length > 0
          ? {
              executorConfig: {
                schemaVersion: 1 as const,
                values: kimiConfigValues,
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
           executor_config_json, thinking_effort, active_channel, status,
           archived, worktree_path, branch, base_branch, worktree_outcome,
           native_session_id, fork_from_session_id, conversation_usage_complete,
           created_at, updated_at)
         VALUES
          (@id, @name, @type, @task_id, @workspace_id, @executor, @model,
           @approval_mode, @executor_config_json, @thinking_effort, 'web', 'new',
           0, NULL, NULL, NULL, NULL, @native_session_id,
           @fork_from_session_id, 1, @now, @now)`,
      )
      .run({
        id,
        name: input.name ?? null,
        type: input.type ?? 'coding',
        task_id: input.task_id ?? null,
        workspace_id: input.workspace_id,
        executor: input.executor,
        model: effectiveModel,
        approval_mode: approvalMode,
        executor_config_json: JSON.stringify(executorConfigFromOptions(proxyResult.configOptions)),
        thinking_effort: effectiveEffort,
        native_session_id: proxyResult.nativeSessionId,
        fork_from_session_id: null,
        now,
      });
    this.sessions.setNativeOptions(id, proxyResult.configOptions);

    return this.sessions.get(id);
  }

  async mergeWorktree(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session.branch || !session.base_branch) {
      throw new Error('session is not in worktree mode');
    }
    if (session.worktree_outcome) {
      throw new Error(`session already ${session.worktree_outcome}`);
    }
    const workspace = this.workspaceFor(session);
    mergeBranch(workspace.path, session.branch, session.base_branch);
    await this.runtime.teardownProxy(sessionId);
    this.finalizeWorktree(sessionId, 'merged');
    if (session.workspace_id != null) {
      this.broadcastWorkspaceGitUpdated(session.workspace_id, 'merge');
    }
  }

  async dropWorktree(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session.branch) throw new Error('session is not in worktree mode');
    if (session.worktree_outcome) {
      throw new Error(`session already ${session.worktree_outcome}`);
    }
    await this.runtime.teardownProxy(sessionId);
    this.finalizeWorktree(sessionId, 'discarded');
    if (session.workspace_id != null) {
      this.broadcastWorkspaceGitUpdated(session.workspace_id, 'drop');
    }
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
  }

  private workspaceFor(session: Session): { path: string } {
    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${session.id}`);
    return workspace;
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
