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
import { join } from 'node:path';
import type { ApprovalManager } from '../approval/index.js';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { purgeSessionAttachments } from '../storage/attachments.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import {
  createWorktree,
  detectDefaultBranch,
  isGitRepo,
  mergeBranch,
  removeWorktree,
} from '../workspace/git.js';
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
  mode?: 'regular' | 'worktree';
  base_branch?: string;
  branch?: string;
  type?: SessionType;
  task_id?: string | null;
  thinking_effort?: ThinkingEffort | null;
  fork_from?: string;
}

interface BringUpInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  displayName: string | null;
  forkFromClaudeSessionId: string | null;
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
    private dataDir: string,
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

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseBranch: string | null = null;
    let forkFromSessionId: string | null = null;
    let forkFromClaudeSessionId: string | null = null;
    let forkCwd: string | null = null;

    if (input.fork_from) {
      if (input.executor !== 'claude') {
        throw new Error('fork_from is only supported for claude sessions');
      }
      if (input.mode === 'worktree') {
        throw new Error('fork_from sessions share the parent cwd and cannot create a worktree');
      }
      const parent = this.db
        .prepare(
          `SELECT id, workspace_id, executor, native_session_id, worktree_path
           FROM sessions WHERE id = ?`,
        )
        .get(input.fork_from) as {
          id: string;
          workspace_id: string;
          executor: Executor;
          native_session_id: string | null;
          worktree_path: string | null;
        } | undefined;
      if (!parent) throw new Error(`fork parent not found: ${input.fork_from}`);
      if (parent.executor !== 'claude') {
        throw new Error('fork_from is only supported for claude sessions');
      }
      if (parent.workspace_id !== input.workspace_id) {
        throw new Error('fork_from parent must belong to the requested workspace');
      }
      forkFromClaudeSessionId = parent.native_session_id;
      forkFromSessionId = parent.native_session_id ? parent.id : null;
      forkCwd = parent.worktree_path;
    }

    if (input.mode === 'worktree') {
      if (!isGitRepo(workspace.path)) {
        throw new Error(`workspace is not a git repo: ${workspace.path}`);
      }
      baseBranch = input.base_branch ?? detectDefaultBranch(workspace.path);
      branch = input.branch ?? `worktree/${id.slice(0, 8)}`;
      worktreePath = join(this.dataDir, 'worktrees', input.workspace_id, id);
      try {
        createWorktree(workspace.path, worktreePath, branch, baseBranch);
      } catch (error) {
        throw new Error(`worktree creation failed: ${(error as Error).message}`);
      }
    }

    let proxyResult: BringUpResult;
    try {
      proxyResult = await this.runtime.bringUpProxySession({
        sessionId: id,
        executor: input.executor,
        cwd: forkCwd ?? worktreePath ?? workspace.path,
        model: effectiveModel,
        displayName: input.name ?? null,
        forkFromClaudeSessionId,
        ...(input.executor === 'kimi' && configuredMode
          ? {
              executorConfig: {
                schemaVersion: 1 as const,
                values: { mode: configuredMode },
              },
            }
          : {}),
      });
    } catch (error) {
      await this.runtime.discardProxy(id);
      if (worktreePath && branch) {
        try {
          removeWorktree(workspace.path, worktreePath, branch);
        } catch {
          // Preserve the proxy error; worktree cleanup remains best-effort.
        }
      }
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
           0, @worktree_path, @branch, @base_branch, NULL, @native_session_id,
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
        worktree_path: worktreePath,
        branch,
        base_branch: baseBranch,
        native_session_id: proxyResult.nativeSessionId,
        fork_from_session_id: forkFromSessionId,
        now,
      });
    this.sessions.setNativeOptions(id, proxyResult.configOptions);

    if (worktreePath) {
      this.broadcastWorkspaceGitUpdated(input.workspace_id, 'worktree-created');
    }
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
    if (session.worktree_path) {
      removeWorktree(workspace.path, session.worktree_path, session.branch);
    }
    this.finalizeWorktree(sessionId, 'merged');
    this.broadcastWorkspaceGitUpdated(session.workspace_id, 'merge');
  }

  async dropWorktree(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session.branch) throw new Error('session is not in worktree mode');
    if (session.worktree_outcome) {
      throw new Error(`session already ${session.worktree_outcome}`);
    }
    const workspace = this.workspaceFor(session);
    await this.runtime.teardownProxy(sessionId);
    if (session.worktree_path) {
      removeWorktree(workspace.path, session.worktree_path, session.branch);
    }
    this.finalizeWorktree(sessionId, 'discarded');
    this.broadcastWorkspaceGitUpdated(session.workspace_id, 'drop');
  }

  archive(sessionId: string, archived: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      archived: archived ? 1 : 0,
      updated_at: now,
    });
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
    if (session.branch && !session.worktree_outcome && session.worktree_path) {
      const workspace = this.db
        .prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(session.workspace_id) as { path: string } | undefined;
      if (workspace) {
        try {
          removeWorktree(workspace.path, session.worktree_path, session.branch);
        } catch {
          // Deletion is authoritative even when best-effort git cleanup fails.
        }
      }
    }
    await this.runtime.teardownProxy(sessionId);
    this.runtime.forgetConversationUsage(sessionId);
    this.sessions.forget(sessionId);
    this.approvals.clearSession(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    await purgeSessionAttachments(sessionId);
    this.broadcaster.broadcast({ type: 'session:deleted', session_id: sessionId });
    if (session.branch) {
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
    reason: 'merge' | 'drop' | 'session-deleted' | 'worktree-created',
  ): void {
    this.broadcaster.broadcast({
      type: 'workspace:git-updated',
      workspace_id: workspaceId,
      reason,
    });
  }
}
