import type {
  ApprovalMode,
  ExecutorConfigState,
  EventEnvelope,
  Executor,
  MessageAttachment,
  NativeConfigOption,
  NativeConfigValue,
  ProxyNotification,
  RuntimeMode,
  Session,
  SessionType,
  ThinkingEffort,
  UnifiedEvent,
  WorktreeOutcome,
} from '@gian/shared';
import { MANAGER_SYS_OPEN, MANAGER_SYS_CLOSE } from '@gian/shared';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  ensureSessionAttachmentDir,
  mimeForAttachment,
  resolveAttachmentPath,
} from '../storage/attachments.js';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { purgeSessionAttachments } from '../storage/attachments.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ApprovalManager } from '../approval/index.js';
import type { QueueManager } from '../queue/index.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { CodexTtyManager } from '../tty/codex-manager.js';
import { locateNativeJsonl, locateCcJsonl, appendCcCustomTitle } from '../native/locate-jsonl.js';
import {
  normalizeCcNotification,
  normalizeCodexNotification,
  normalizeKimiNotification,
} from '../event/index.js';
import {
  normalizeKimiConfigOptions,
  normalizeKimiSlashCommands,
} from '../proxy/kimi-proxy-client.js';
import {
  parseAcpUsageUpdate,
  parseTokenUsageUpdate,
  type ParsedTokenUsageUpdate,
} from './token-usage.js';
import {
  createWorktree,
  detectDefaultBranch,
  isGitRepo,
  mergeBranch,
  removeWorktree,
} from '../workspace/git.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  getOrCreateRootWorkspace,
  buildManagerSystemPrompt,
  managerRuntimeFor,
  DEFAULT_MANAGER_EXECUTOR,
} from '../task/manager-session.js';
import {
  summarizeCompletedSubtask,
  applyAbandonWriteback,
  type SubtaskContext,
  type SummaryLlm,
} from '../task/summarizer.js';
import { buildFirstTurnRolePrefix, roleForSessionType } from '../task/role-injector.js';
import { regenerateStateViewIfDirty } from '../workspace/ai-views.js';
import { ActionExecutor, isTerminalStatus, type MessageOutcome } from '../task/action-executor.js';
import { parseGianAction } from '../task/action-parser.js';
import {
  getActiveLoop,
  getLoop,
  insertLoop,
  updateLoop,
  type InsertLoopInput,
} from '../task/task-store.js';
import { advanceLoop } from '../task/loop-engine.js';
import type { SubmitStepParams, TaskAction, TaskLoop } from '@gian/shared';

export interface CreateSessionInput {
  workspace_id: string;
  executor: Executor;
  name?: string;
  model?: string | null;
  approval_mode?: ApprovalMode;
  /** When 'worktree', host creates a dedicated branch + working directory. */
  mode?: 'regular' | 'worktree';
  /** Override for worktree mode (auto-detected from workspace if absent). */
  base_branch?: string;
  /** Override for worktree mode (defaults to worktree/<short-id>). */
  branch?: string;
  /** PRD-v3 Task abstraction. Defaults to 'coding' for standalone sessions.
   *  A Subtask is created with type='subtask'; the executor-selectable
   *  per-Task Manager with type='manager'. */
  type?: SessionType;
  /** The Task this session belongs to (PRD-v3). Null/absent = a standalone
   *  ("scattered") session. */
  task_id?: string | null;
  /** Pin the reasoning effort at create time (Manager forces 'xhigh').
   *  Defaults to the per-executor config default when absent. */
  thinking_effort?: ThinkingEffort | null;
  /** Fork an existing Gian session's native thread (Gian sidechat,
   *  claude-only): the new session shares the parent's cwd (its worktree
   *  when the parent is a worktree session — the parent's JSONL lives
   *  there) and forks the native Claude session on its first turn. */
  fork_from?: string;
}

/**
 * Translate Gian's host-facing ApprovalMode (plan/ask/auto) into the
 * per-turn execution policy params for each executor's proxy.
 *
 *   plan  — read-only exploration; agent constrained to planning behavior
 *   ask   — every risky action surfaces as a user approval
 *   auto  — agent runs autonomously with executor-side safety classifier
 *
 * The two legacy-mode executors expose different primitives:
 *   - cc-proxy: a single `permissionMode` flag (Claude CLI native)
 *   - codex-proxy: four orthogonal fields (sandbox / approvalPolicy /
 *                  approvalsReviewer / collaborationMode)
 * Kimi is intentionally excluded: its ACP config options are passed through
 * by stable option id and never mapped onto Gian's ApprovalMode.
 *
 * Each field is omitted when the proxy doesn't need it; both proxies tolerate
 * unknown extra fields (other proxy's params just get ignored).
 */
function proxyTurnParamsFor(
  executor: Exclude<Executor, 'kimi'>,
  mode: ApprovalMode,
): {
  permissionMode?: 'plan' | 'default' | 'auto' | 'bypassPermissions';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  useConfiguredPermissions?: boolean;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  approvalsReviewer?: 'user' | 'auto_review';
  collaborationMode?: 'plan' | 'default';
} {
  if (executor === 'claude') {
    switch (mode) {
      case 'plan':
        return { permissionMode: 'plan' };
      case 'ask':
        return { permissionMode: 'default' };
      case 'auto':
        return { permissionMode: 'auto' };
      case 'full-access':
      case 'custom':
        // This should be rejected before persistence. If an older/bad row leaks
        // through, fail safe: Ask/default, never persistent bypassPermissions.
        return { permissionMode: 'default' };
    }
  }
  // codex
  switch (mode) {
    case 'plan':
      return {
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        collaborationMode: 'plan',
      };
    case 'ask':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      };
    case 'auto':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'custom':
      return { useConfiguredPermissions: true };
    case 'full-access':
      // "Full access" in the codex composer — persistent, replaces the old
      // per-turn one-shot bypass.
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
      };
  }
}

function assertApprovalModeAllowed(executor: Executor, mode: ApprovalMode): void {
  if ((mode === 'custom' || mode === 'full-access') && executor !== 'codex') {
    throw new Error(`${mode} approval mode is codex-only`);
  }
}

const EMPTY_EXECUTOR_CONFIG: ExecutorConfigState = {
  schemaVersion: 1,
  values: {},
};

type SessionRow = Omit<Session, 'executor_config' | 'native_config_options'> & {
  executor_config_json?: string | null;
  fork_from_session_id?: string | null;
};

function parseExecutorConfig(value: string | null | undefined): ExecutorConfigState {
  if (!value) return { ...EMPTY_EXECUTOR_CONFIG, values: {} };
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      values?: unknown;
    };
    if (
      parsed.schemaVersion === 1
      && parsed.values
      && typeof parsed.values === 'object'
      && !Array.isArray(parsed.values)
    ) {
      return {
        schemaVersion: 1,
        values: parsed.values as ExecutorConfigState['values'],
      };
    }
  } catch {
    // Fall through to an empty, forward-compatible state.
  }
  return { ...EMPTY_EXECUTOR_CONFIG, values: {} };
}

function stateFromOptions(options: NativeConfigOption[]): ExecutorConfigState {
  return {
    schemaVersion: 1,
    values: Object.fromEntries(options.map(option => [option.id, option.currentValue])),
  };
}

function kimiContentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as { type?: unknown; text?: unknown };
  return content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : '';
}

/**
 * Map shared InputItem[] to the items the target executor accepts.
 *   - codex: passes everything through (skill / text / attachments)
 *   - cc:    has no skill concept — translate skill → `/<name>` text so the
 *            existing slash text path runs (cc-proxy does its own intercepts
 *            for known native commands like `/clear` / `/compact`)
 */
function translateItemsForExecutor(
  executor: Executor,
  items: import('@gian/shared').InputItem[],
): import('@gian/shared').InputItem[] {
  if (executor === 'codex') return items;
  return items.map(it => {
    if (it.type === 'skill') return { type: 'text' as const, text: `/${it.name}` };
    return it;
  });
}

/** Build the attachments payload echoed back in `user_message` events from
 *  the attachment items the client supplied. Filenames stored under
 *  `~/.gian/attachments/<sid>/` are UUIDs assigned by writeAttachment, so the
 *  basename of the absolute path is the URL-safe identifier. Falls back to
 *  the on-disk extension when the client doesn't echo a name/mime. */
function buildAttachmentsFromItems(
  sessionId: string,
  items: import('@gian/shared').InputItem[] | undefined,
): MessageAttachment[] {
  if (!items) return [];
  const out: MessageAttachment[] = [];
  for (const it of items) {
    if (it.type !== 'localImage' && it.type !== 'localFile') continue;
    const filename = basename(it.path);
    const mime = it.mime ?? mimeForAttachment(filename);
    out.push({
      name: it.name ?? filename,
      mime,
      url: `/api/sessions/${sessionId}/attachments/${filename}`,
      ...(typeof it.size === 'number' ? { size: it.size } : {}),
    });
  }
  return out;
}

/** Generic files are a more powerful primitive than images because every
 *  executor can read their contents. Only accept files created by this
 *  session's upload route; never let a web client smuggle an arbitrary host
 *  path into an agent prompt. */
function assertLocalFilesBelongToSession(
  sessionId: string,
  items: import('@gian/shared').InputItem[] | undefined,
): void {
  for (const item of items ?? []) {
    if (item.type !== 'localFile') continue;
    const expected = resolveAttachmentPath(sessionId, basename(item.path));
    if (!expected || resolve(item.path) !== expected || !existsSync(expected)) {
      throw new Error(`invalid local file attachment for session ${sessionId}`);
    }
  }
}

/**
 * Bridges WebSocket commands and the proxy layer. Persists sessions, turns,
 * events; subscribes to proxy notifications and broadcasts them to the web
 * client.
 *
 * Every proxy notification flows through normalize-{cc,codex} and exits as a
 * UnifiedEvent. Anything the normalizer doesn't recognize is logged as a
 * warning and dropped — proxy-specific event shapes never leak past this
 * boundary, so DB rows and WS frames stay on the unified taxonomy.
 */
interface JobState {
  totalTurns: number;
  completedTurns: number;
  consecutiveErrors: number;
}

export class SessionManager {
  /** Active turn id per session, used to attribute incoming notifications. */
  private activeTurns = new Map<string, { id: string; number: number }>();
  /** Proxy session ids returned by session.create per Gian session. */
  private proxySessionIds = new Map<string, string>();
  /** Deduplicates concurrent lazy reattachment (for example config refresh
   *  racing the first send after a host restart). */
  private proxyBringUps = new Map<string, Promise<string>>();
  /** Job Mode state keyed by session id. Present only while a job is active. */
  private jobs = new Map<string, JobState>();
  /** Subscribers added via onEvent — receives every dispatched UnifiedEvent. */
  private eventSubscribers: Array<(e: UnifiedEvent) => void> = [];
  /** Capabilities cached on first proxy session create per executor.
   *  GET /api/proxy/:executor/models reads this. */
  private capsByExecutor = new Map<string, import('@gian/shared').ProxyCapabilities>();
  /** Dynamic executor options are not DB columns; exact current values live in
   *  executor_config_json while choices are refreshed from the live proxy. */
  private nativeConfigOptions = new Map<string, NativeConfigOption[]>();
  /** Claude reports conversation totals as per-turn deltas. A proxy reconnect
   *  can replay a terminal notification, so remember which turns were applied. */
  private conversationUsageTurns = new Map<string, Set<string>>();
  /** Gian action executor (lazy — bound to this manager's side effects). */
  private _actionExecutor: ActionExecutor | null = null;

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
    /** Codex TTY runtime coordinator. Injected after construction (circular —
     *  CodexTtyManager doesn't actually depend on SessionManager). Null when
     *  codex CLI mode isn't wired. */
    private codexTtyMgr: CodexTtyManager | null = null,
  ) {}

  setCodexTtyManager(mgr: CodexTtyManager): void {
    this.codexTtyMgr = mgr;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const workspace = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(input.workspace_id) as { id: string; path: string } | undefined;

    if (!workspace) {
      throw new Error(`workspace not found: ${input.workspace_id}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    if (input.executor === 'kimi' && input.approval_mode !== undefined) {
      throw new Error('Kimi uses executor-native mode; approval_mode must be omitted');
    }
    const approvalMode: ApprovalMode | null = input.executor === 'kimi'
      ? null
      : (input.approval_mode ?? 'auto');
    if (approvalMode) assertApprovalModeAllowed(input.executor, approvalMode);

    // Resolve session defaults from system config when the caller didn't pin
    // them. The Settings panel writes `default_{claude,codex}_{model,effort}`
    // but until now nothing read them. Empty strings in config mean "let the
    // proxy / CLI pick" → leave null so we don't override anything.
    const cfg = loadConfig(this.db);
    const defaultModel = input.executor === 'claude'
      ? cfg.default_claude_model.trim()
      : input.executor === 'codex'
        ? cfg.default_codex_model.trim()
        : '';
    const defaultEffort = input.executor === 'claude'
      ? cfg.default_claude_effort.trim()
      : input.executor === 'codex'
        ? cfg.default_codex_effort.trim()
        : '';
    const explicitModel = typeof input.model === 'string' ? input.model.trim() : '';
    const effectiveModel: string | null = explicitModel
      ? explicitModel
      : (defaultModel || null);
    // Explicit effort (Manager pins 'xhigh') wins over the config default.
    const explicitEffort = typeof input.thinking_effort === 'string'
      ? input.thinking_effort.trim()
      : '';
    const effectiveEffort: ThinkingEffort | null = explicitEffort
      ? (explicitEffort as ThinkingEffort)
      : (defaultEffort ? (defaultEffort as ThinkingEffort) : null);

    const sessionType: SessionType = input.type ?? 'coding';
    const taskId: string | null = input.task_id ?? null;

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseBranch: string | null = null;

    // Sidechat fork: resolve the parent session up-front. Claude-only —
    // cc-proxy forks the parent's native session via
    // `claude -p --resume <parent native> --fork-session`. The fork inherits
    // the parent's cwd (its worktree when set — the parent's JSONL lives in
    // that project dir, so `--resume` can find it there).
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
          'SELECT id, workspace_id, executor, native_session_id, worktree_path FROM sessions WHERE id = ?',
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
      // A parent that never ran a turn has no native session yet — nothing
      // to carry, so the fork silently becomes a fresh session.
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
      } catch (err) {
        throw new Error(`worktree creation failed: ${(err as Error).message}`);
      }
    }

    const cwd = forkCwd ?? worktreePath ?? workspace.path;

    // Bring up the proxy and create the upstream session FIRST so we can
    // capture its native session id and persist it on the row. Failure here
    // rolls back the worktree we may have just created — no half-row is ever
    // inserted.
    let proxyResult: {
      proxySessionId: string;
      nativeSessionId: string;
      configOptions: NativeConfigOption[];
    };
    try {
      proxyResult = await this.bringUpProxySession({
        sessionId: id,
        executor: input.executor,
        cwd,
        model: effectiveModel,
        displayName: input.name ?? null,
        forkFromClaudeSessionId,
      });
    } catch (err) {
      await this.proxy.dispose(id).catch(() => undefined);
      this.proxySessionIds.delete(id);
      if (worktreePath && branch) {
        try {
          removeWorktree(workspace.path, worktreePath, branch);
        } catch {
          // best-effort; surface the original proxy error
        }
      }
      throw err;
    }

    this.db
      .prepare(
        `INSERT INTO sessions (id, name, type, task_id, workspace_id, executor, model, approval_mode, executor_config_json, thinking_effort, turns, active_channel, status, archived, worktree_path, branch, base_branch, worktree_outcome, native_session_id, fork_from_session_id, runtime_mode, conversation_usage_complete, created_at, updated_at)
         VALUES (@id, @name, @type, @task_id, @workspace_id, @executor, @model, @approval_mode, @executor_config_json, @thinking_effort, 1, 'web', 'new', 0, @worktree_path, @branch, @base_branch, NULL, @native_session_id, @fork_from_session_id, 'structured', 1, @now, @now)`,
      )
      .run({
        id,
        name: input.name ?? null,
        type: sessionType,
        task_id: taskId,
        workspace_id: input.workspace_id,
        executor: input.executor,
        model: effectiveModel,
        approval_mode: approvalMode,
        executor_config_json: JSON.stringify(stateFromOptions(proxyResult.configOptions)),
        thinking_effort: effectiveEffort,
        worktree_path: worktreePath,
        branch,
        base_branch: baseBranch,
        native_session_id: proxyResult.nativeSessionId,
        fork_from_session_id: forkFromSessionId,
        now,
      });

    this.nativeConfigOptions.set(id, proxyResult.configOptions);

    if (worktreePath) {
      this.broadcastWorkspaceGitUpdated(input.workspace_id, 'worktree-created');
    }

    return this.getSession(id);
  }

  // -------------------------------------------------------------------------
  // Per-Task Manager (PRD-v3 P3)
  // -------------------------------------------------------------------------

  /** Find the existing Manager session for a Task, if any. One per Task. */
  getManagerSession(taskId: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE task_id = ? AND type = 'manager' LIMIT 1`)
      .get(taskId) as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  /**
   * Get-or-create the per-Task Manager session (PRD-v3 P3). The Manager is a
   * `type='manager'` session bound to the hidden root workspace
   * (`workspace_root`), with an executor chosen per Task, NO worktree, and
   * persistence across turns. Claude/Codex use `approval_mode`; Kimi keeps its
   * ACP-provided mode/config vocabulary. No cross-executor policy is forced.
   *
   * Idempotent: returns the existing Manager when one already exists for the
   * Task. Lazy creation — called on the first manager message (or eagerly by
   * the web when a Task detail opens).
   */
  async ensureManagerSession(taskId: string): Promise<Session> {
    const existing = this.getManagerSession(taskId);
    if (existing) return existing;

    const task = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as import('@gian/shared').Task | undefined;
    if (!task) throw new Error(`task not found: ${taskId}`);

    const root = getOrCreateRootWorkspace(this.db);

    // The PM's executor is a per-Task choice (gian-task-pm-engineer §4.2): the
    // Task row carries `manager_executor` (picked at creation via the sidebar
    // "+"). Legacy tasks (NULL) fall back to the `default_task_executor` config
    // default, then to the compile-time default. The model/effort follow from
    // the executor — Codex pins gpt-5.5/xhigh, while Claude/Kimi defer to
    // their own defaults/native config (managerRuntimeFor).
    const executor = task.manager_executor
      ?? loadConfig(this.db).default_task_executor
      ?? DEFAULT_MANAGER_EXECUTOR;
    const runtime = managerRuntimeFor(executor);

    // Reuse the standard create path so the Manager gets the same proxy
    // bring-up + native-session capture as any other session. Legacy
    // executors start in plan; Kimi omits Gian approval_mode entirely.
    return this.createSession({
      workspace_id: root.id,
      executor: runtime.executor,
      name: `Manager · ${task.name}`,
      model: runtime.model,
      thinking_effort: runtime.effort,
      ...(runtime.executor === 'kimi' ? {} : { approval_mode: 'plan' as const }),
      type: 'manager',
      task_id: taskId,
      mode: 'regular',
    });
  }

  /**
   * Build the Manager's system prompt for a Task (role + inlined subtask
   * metadata + signposts to the `.ai/` dirs and workspaces under the root).
   * Pure read — used by the message path to prepend context.
   *
   * TODO(P3-live): the codex-proxy `session.create` / `turn.start` API has no
   * `instructions` / system-prompt channel (see
   * packages/proxies/codex-proxy/src/core/types.ts — StartTurnParams has no
   * such field). So today this prompt is prepended to the Manager's FIRST user
   * message (see sendManagerMessage). If codex-proxy gains a native system /
   * baseInstructions field, switch to passing it there so it doesn't consume
   * turn budget / appear in the transcript.
   */
  buildManagerPrompt(taskId: string): string {
    const task = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as import('@gian/shared').Task | undefined;
    if (!task) throw new Error(`task not found: ${taskId}`);

    const subtasks = this.db
      .prepare(`SELECT * FROM sessions WHERE task_id = ? AND type = 'subtask' ORDER BY created_at ASC`)
      .all(taskId) as Session[];

    // Distinct workspace paths touched by the Task's subtasks.
    const rows = this.db
      .prepare(
        `SELECT DISTINCT w.path AS path
         FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.task_id = ? AND s.type = 'subtask'`,
      )
      .all(taskId) as Array<{ path: string }>;
    const workspacePaths = rows.map(r => r.path);

    const root = getOrCreateRootWorkspace(this.db);
    return buildManagerSystemPrompt({
      task,
      subtasks,
      workspacePaths,
      rootPath: root.path,
    });
  }

  /**
   * Send a message to a Task's Manager (PRD-v3 P3 A1). Ensures the Manager
   * session exists, prepends the system prompt to the FIRST turn (see
   * buildManagerPrompt's TODO(P3-live) about the missing native system
   * channel), then reuses the normal structured `sendMessage` path — the
   * Manager IS a session, so its transcript streams over the same events/WS.
   *
   * Returns the Manager session id so the caller (WS handler) can echo it back
   * to the web, which then renders the Manager session's transcript.
   */
  async sendManagerMessage(taskId: string, text: string): Promise<string> {
    const manager = await this.ensureManagerSession(taskId);
    // The first-turn system-prompt prepend now lives in sendMessage (keyed on
    // type==='manager'), so it applies exactly once to every send path — this
    // REST helper and the structured message:send the web composer uses.
    await this.sendMessage(manager.id, text);
    return manager.id;
  }

  /**
   * Bring the live proxy session for `session` up if it isn't already.
   * Called lazily from sendMessage when proxySessionIds is empty (e.g.
   * after host hot-reload). createSession does its own first-time bring-up
   * directly via bringUpProxySession so it can capture the native id
   * before inserting the row.
   */
  private async ensureProxySession(session: Session): Promise<string> {
    const cached = this.proxySessionIds.get(session.id);
    if (cached) return cached;
    const existing = this.proxyBringUps.get(session.id);
    if (existing) return existing;

    const pending = this.rehydrateProxySession(session);
    this.proxyBringUps.set(session.id, pending);
    try {
      return await pending;
    } catch (error) {
      // In particular, release an unattached Kimi facade after AUTH_REQUIRED
      // so an external `kimi login` followed by Retry can start fresh.
      if (session.executor === 'kimi') {
        await this.proxy.dispose(session.id).catch(() => undefined);
        this.proxySessionIds.delete(session.id);
      }
      throw error;
    } finally {
      if (this.proxyBringUps.get(session.id) === pending) {
        this.proxyBringUps.delete(session.id);
      }
    }
  }

  private async rehydrateProxySession(session: Session): Promise<string> {
    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) {
      throw new Error(`workspace missing for session ${session.id}`);
    }

    const pendingFork = this.db
      .prepare(
        `SELECT parent.native_session_id, parent.worktree_path
         FROM sessions AS child
         JOIN sessions AS parent ON parent.id = child.fork_from_session_id
         WHERE child.id = ?`,
      )
      .get(session.id) as {
        native_session_id: string | null;
        worktree_path: string | null;
      } | undefined;
    const forkFromClaudeSessionId = pendingFork?.native_session_id ?? null;

    const result = await this.bringUpProxySession({
      sessionId: session.id,
      executor: session.executor,
      cwd: pendingFork?.worktree_path ?? session.worktree_path ?? workspace.path,
      model: session.model,
      nativeSessionId: forkFromClaudeSessionId ? null : session.native_session_id,
      forkFromClaudeSessionId,
      executorConfig: session.executor_config,
      displayName: session.name,
    });
    return result.proxySessionId;
  }

  /**
   * Spin up (or attach to) the proxy client for a session and call
   * session.create on it. Returns both the proxy-side session id (used as
   * sessionId in subsequent RPC calls) and the executor-native session id
   * stored in `sessions.native_session_id`.
   *
   * If `nativeSessionId` is provided the proxy treats it as an adoption /
   * resume — cc uses `--resume <id>`, Codex calls `thread/resume <id>`, and
   * Kimi uses ACP `session/load` or `session/resume`. Otherwise the executor
   * generates a fresh native id and we capture it for storage.
   */
  private async bringUpProxySession(args: {
    sessionId: string;
    executor: Executor;
    cwd: string;
    model: string | null;
    nativeSessionId?: string | null;
    /** Claude-only pending sidechat fork. Mutually exclusive with
     *  nativeSessionId adoption. */
    forkFromClaudeSessionId?: string | null;
    executorConfig?: ExecutorConfigState;
    resumeMode?: 'load' | 'resume';
    /** SESSION-NAME-001: Gian session name to stamp onto the native session at
     *  bring-up. codex applies it via `thread/name/set` (covers create-with-name
     *  and idle-rename-then-next-bringup). claude ignores it here — its name is
     *  set via `--name` on the first turn / TTY spawn. */
    displayName?: string | null;
  }): Promise<{
    proxySessionId: string;
    nativeSessionId: string;
    configOptions: NativeConfigOption[];
    replayUpdates: unknown[];
  }> {
    const client = await this.proxy.getOrCreate(args.sessionId, args.executor);
    client.onNotification(notification => this.handleNotification(args.sessionId, notification));
    // If the proxy dies mid-turn (cc-proxy crash, codex host exit, …) the
    // SessionManager would otherwise keep the turn in `running` forever — the
    // user sees a perpetual spinner. Fail the active turn so the UI resolves.
    client.onExit(code => this.handleProxyExit(args.sessionId, code));

    await client.initialize();
    const caps = await client.capabilities();
    this.capsByExecutor.set(args.executor, caps);

    const adoptParams: {
      claudeSessionId?: string;
      forkFromClaudeSessionId?: string;
      threadId?: string;
      nativeSessionId?: string;
      resumeMode?: 'load' | 'resume';
    } = {};
    if (args.nativeSessionId) {
      if (args.executor === 'claude') adoptParams.claudeSessionId = args.nativeSessionId;
      else if (args.executor === 'codex') adoptParams.threadId = args.nativeSessionId;
      else {
        adoptParams.nativeSessionId = args.nativeSessionId;
        adoptParams.resumeMode = args.resumeMode ?? 'resume';
      }
    }
    if (args.executor === 'claude' && args.forkFromClaudeSessionId) {
      adoptParams.forkFromClaudeSessionId = args.forkFromClaudeSessionId;
    }

    // PR2: proxies are stateless across restarts (no state.json). Adoption is
    // expressed through an executor-native id; the proxy resumes or loads the
    // native session. There's no SESSION_ALREADY_EXISTS recovery path anymore.
    let created: {
      session: import('@gian/shared').ProxySession;
      nativeSessionId: string;
      configOptions?: NativeConfigOption[];
      replayUpdates?: unknown[];
    };
    try {
      created = await client.createSession({
        cwd: args.cwd,
        model: args.model ?? undefined,
        ...adoptParams,
      });
    } catch (err) {
      // Adoption fallback: when the on-disk thread/native session is missing
      // (e.g. session created but no turn ever ran, so codex never wrote the
      // rollout file), the proxy throws THREAD_NOT_FOUND / SESSION_NOT_FOUND.
      // If the Gian session has 0 persisted turns there is nothing to lose,
      // so silently start a fresh native session and update the row.
      const message = err instanceof Error ? err.message : String(err);
      const isMissing = args.nativeSessionId && (
        message.includes('THREAD_NOT_FOUND')
        || message.includes('SESSION_NOT_FOUND')
        || message.includes('Could not resume')
      );
      const turnCount = isMissing ? this.persistedTurnCount(args.sessionId) : -1;
      if (!isMissing || turnCount > 0 || args.executor === 'kimi') throw err;

      created = await client.createSession({
        cwd: args.cwd,
        model: args.model ?? undefined,
      });
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ?')
        .run(created.nativeSessionId, now, args.sessionId);
      this.broadcastSessionUpdated(args.sessionId, {
        native_session_id: created.nativeSessionId,
        updated_at: now,
      });
    }

    this.proxySessionIds.set(args.sessionId, created.session.id);

    let configOptions = created.configOptions ?? created.session.configOptions ?? [];
    if (
      args.executor === 'kimi'
      && args.executorConfig
      && client.setNativeConfig
    ) {
      const current = new Map(configOptions.map(option => [option.id, option.currentValue]));
      const saved = args.executorConfig.values;
      const ids = Object.keys(saved).sort((left, right) => {
        const order = ['model', 'thinking', 'thought_level', 'mode'];
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        if (leftIndex !== -1 || rightIndex !== -1) {
          return (leftIndex === -1 ? order.length : leftIndex)
            - (rightIndex === -1 ? order.length : rightIndex);
        }
        return left.localeCompare(right);
      });
      for (const id of ids) {
        const value = saved[id];
        if (value === undefined || Object.is(current.get(id), value)) continue;
        const updated = await client.setNativeConfig(id, value);
        configOptions = updated.options;
        current.clear();
        for (const option of configOptions) current.set(option.id, option.currentValue);
      }
    }
    this.nativeConfigOptions.set(args.sessionId, configOptions);

    const persisted = this.db
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .get(args.sessionId) as { id: string } | undefined;
    if (persisted) {
      const state = stateFromOptions(configOptions);
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE sessions SET executor_config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(state), now, args.sessionId);
      this.broadcastSessionUpdated(args.sessionId, {
        executor_config: state,
        native_config_options: configOptions,
        updated_at: now,
      });
    }

    // Live Sync v2: start watching the on-disk JSONL so external `claude
    // --resume` / `codex resume` appends sync into events + WS.
    if (this.watcher && args.executor !== 'kimi') {
      const filePath = locateNativeJsonl(args.executor, created.nativeSessionId, args.cwd);
      if (filePath) this.watcher.start(args.sessionId, filePath, args.executor);
    }

    // SESSION-NAME-001: stamp the Gian name onto the codex thread on bring-up
    // (covers create-with-name and idle-rename-applied-on-next-bringup). Claude
    // names are handled via `--name` on the first turn, not here. Best-effort.
    const bringUpName = args.displayName?.trim();
    if (args.executor === 'codex' && bringUpName && client.setName) {
      try {
        await client.setName(bringUpName);
      } catch (err) {
        console.warn(`[session] codex setName on bring-up failed for ${args.sessionId}: ${String(err)}`);
      }
    }

    return {
      proxySessionId: created.session.id,
      nativeSessionId: created.nativeSessionId,
      configOptions,
      replayUpdates: created.replayUpdates ?? [],
    };
  }

  async listKimiNativeSessions(cwd: string): Promise<import('@gian/shared').NativeSession[]> {
    const cacheKey = '__native_sessions_kimi__';
    const client = await this.proxy.getOrCreate(cacheKey, 'kimi');
    try {
      await client.initialize();
      if (!client.listNativeSessions) return [];
      const rows: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const result = await client.listNativeSessions({
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        if (!result || typeof result !== 'object') break;
        const page = result as { sessions?: unknown; nextCursor?: unknown };
        if (Array.isArray(page.sessions)) rows.push(...page.sessions);
        const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return rows.flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, unknown>;
        if (typeof item.sessionId !== 'string' || !item.sessionId) return [];
        const title = typeof item.title === 'string' ? item.title : '';
        return [{
          id: item.sessionId,
          executor: 'kimi' as const,
          filePath: '',
          cwd: typeof item.cwd === 'string' ? item.cwd : cwd,
          updatedAt: typeof item.updatedAt === 'string'
            ? item.updatedAt
            : new Date(0).toISOString(),
          fileSize: 0,
          turnCount: 0,
          firstUserMessage: title,
        }];
      });
    } catch (error) {
      // An unauthenticated discovery facade has no native session to protect.
      // Dispose it so external `kimi login` followed by Retry gets a fresh ACP
      // process instead of a permanently stale cached lister.
      await this.proxy.dispose(cacheKey).catch(() => undefined);
      throw error;
    }
  }

  async adoptKimiNativeSession(input: {
    workspaceId: string;
    cwd: string;
    nativeSessionId: string;
    name?: string;
  }): Promise<{
    session: Session;
    replay: { turns: number; events: number };
  }> {
    const duplicate = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE executor = 'kimi' AND native_session_id = ?`,
      )
      .get(input.nativeSessionId) as { id: string } | undefined;
    if (duplicate) {
      throw Object.assign(
        new Error(`Kimi session is already adopted as ${duplicate.id}`),
        { code: 'SESSION_ALREADY_EXISTS', sessionId: duplicate.id },
      );
    }

    const sessionId = randomUUID();
    let broughtUp: Awaited<ReturnType<SessionManager['bringUpProxySession']>>;
    try {
      broughtUp = await this.bringUpProxySession({
        sessionId,
        executor: 'kimi',
        cwd: input.cwd,
        model: null,
        nativeSessionId: input.nativeSessionId,
        resumeMode: 'load',
      });
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessionIds.delete(sessionId);
      throw error;
    }

    const now = new Date().toISOString();
    const name = input.name?.trim() || `adopted ${input.nativeSessionId.slice(0, 8)}`;
    let replay = { turns: 0, events: 0 };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO sessions
              (id, name, type, workspace_id, executor, model, approval_mode,
               executor_config_json, turns, active_channel, status, archived,
               worktree_path, branch, base_branch, worktree_outcome,
               native_session_id, runtime_mode, created_at, updated_at)
             VALUES
              (?, ?, 'coding', ?, 'kimi', NULL, NULL, ?, 1, 'web', 'new', 0,
               NULL, NULL, NULL, NULL, ?, 'structured', ?, ?)`,
          )
          .run(
            sessionId,
            name,
            input.workspaceId,
            JSON.stringify(stateFromOptions(broughtUp.configOptions)),
            input.nativeSessionId,
            now,
            now,
          );
        replay = this.persistKimiReplay(sessionId, broughtUp.replayUpdates, now);
      })();
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessionIds.delete(sessionId);
      this.nativeConfigOptions.delete(sessionId);
      throw error;
    }

    const session = this.getSession(sessionId);
    this.broadcaster.broadcast({ type: 'session:created', session });
    return { session, replay };
  }

  async stopTurn(sessionId: string): Promise<void> {
    const proxySessionId = this.proxySessionIds.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    // Clear job state so no continuation fires after the interrupt completes.
    this.jobs.delete(sessionId);
    await client.interruptTurn(proxySessionId);
    // Settle locally: cc-proxy's interruptTurn just kills the runtime and
    // never emits turn.completed/failed, so handleLifecycle won't fire. For
    // codex the turn-failed notification *will* arrive but completeTurn is
    // idempotent (early-returns when activeTurns has nothing). Either way,
    // make sure the UI's spinner clears.
    if (this.activeTurns.has(sessionId)) {
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
   *      tears down activeTurns / jobs / pending approvals.
   *   2. Eagerly mark any active turn `'stopped'` and the session `'done'`
   *      so the UI doesn't have to wait on the exit handler.
   *   3. Drop our cached `proxySessionIds` entry — next `sendMessage` will
   *      lazily spawn a fresh proxy and adopt the on-disk native session
   *      via the existing `claudeSessionId` / `threadId` resume path.
   *
   * Idempotent. Safe to call when nothing is wedged (no-op if no client).
   */
  async forceRecover(sessionId: string): Promise<void> {
    this.jobs.delete(sessionId);
    if (this.activeTurns.has(sessionId)) {
      this.completeTurn(sessionId, 'stopped');
    }
    this.approvals.clearSession(sessionId);
    this.watcher?.resume(sessionId);
    // If the session is wedged in CLI mode, kill the PTY too — otherwise
    // we drop the cached proxy session id but the PTY keeps running in
    // codex-proxy memory, orphaned from any host state.
    // stop() also persists runtime_mode back to 'structured' so the next
    // session open lands the user in Chat instead of a dead xterm.
    let session: Session | null = null;
    try { session = this.getSession(sessionId); } catch { /* row gone */ }
    if (session?.runtime_mode === 'tty') {
      try {
        if (session.executor === 'codex') await this.codexTtyMgr?.stop(session);
      } catch { /* best-effort */ }
    }
    this.proxySessionIds.delete(sessionId);

    const now = new Date().toISOString();

    // Sweep ANY DB-level `running` turn for this session, regardless of the
    // in-memory `activeTurns` entry. If the host restarted while a turn was
    // running, activeTurns is empty but the row still says 'running' — it's
    // an orphan; mark it 'stopped' so it doesn't haunt later queries.
    this.db
      .prepare(
        `UPDATE turns SET status = 'stopped', completed_at = ? WHERE session_id = ? AND status = 'running'`,
      )
      .run(now, sessionId);

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

  /**
   * Flip the active runtime for a session between `structured` and `tty`.
   * Codex-only — Claude TTY mode was removed, so claude sessions always
   * fail with SWITCH_BLOCKED.
   * Preconditions:
   *   - session exists, executor is `codex`
   *   - the codex TTY manager is wired
   *   - no active turn, no pending approval
   *   - worktree not finalized (merged/discarded)
   *
   * On success the underlying native session uuid is preserved (Codex:
   * `codex resume <uuid>` against the same threadId that codex-proxy's
   * `thread/start` minted), so conversation history survives the toggle in
   * either direction.
   */
  async switchRuntime(
    sessionId: string,
    target: RuntimeMode,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.executor !== 'codex') {
      throw Object.assign(
        new Error(`runtime switch is not available for executor "${session.executor}"`),
        { code: 'SWITCH_BLOCKED' },
      );
    }
    if (!this.codexTtyMgr) {
      throw Object.assign(new Error('codex TTY runtime not configured'), { code: 'SWITCH_BLOCKED' });
    }
    if (session.runtime_mode === target && !opts.force) {
      // No-op; do not error — the toggle button may double-fire. `force`
      // bypasses this to re-spawn a dead PTY (host restart left the session
      // in tty mode without a live PTY).
      return;
    }
    if (session.worktree_outcome !== null) {
      throw Object.assign(
        new Error('cannot switch runtime — session worktree is already finalized (merged or discarded)'),
        { code: 'SWITCH_BLOCKED' },
      );
    }
    if (this.activeTurns.has(sessionId)) {
      throw Object.assign(
        new Error('finish the current turn before switching runtime'),
        { code: 'SWITCH_BLOCKED' },
      );
    }
    if (this.approvals.listPending().some(p => p.sessionId === sessionId)) {
      throw Object.assign(
        new Error('resolve the pending approval before switching runtime'),
        { code: 'SWITCH_BLOCKED' },
      );
    }

    // Ensure the codex proxy client is alive — the TTY manager talks through
    // it. This is also where `native_session_id` gets minted (via
    // `thread/start` inside `bringUpProxySession`) on sessions that have
    // never run a CHAT turn. Side effect: the in-memory `session` variable
    // above is now stale w.r.t. native_session_id.
    await this.ensureProxySession(session);

    if (target === 'tty') {
      // Re-read the session row so `native_session_id` reflects any
      // freshly-minted codex threadId from ensureProxySession.
      const fresh = this.getSession(sessionId);
      // Resolve cwd: worktree path if present, else workspace root.
      const workspace = this.db
        .prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(fresh.workspace_id) as { path: string } | undefined;
      if (!workspace) throw new Error(`workspace missing for session ${sessionId}`);
      const cwd = fresh.worktree_path ?? workspace.path;
      // Pick a conservative default geometry — the UI resizes on mount.
      await this.codexTtyMgr.start(fresh, cwd, { cols: 120, rows: 30 });
    } else {
      await this.codexTtyMgr.stop(session);
    }
  }

  async respondApproval(
    sessionId: string,
    approvalId: string,
    decision: import('@gian/shared').ApprovalDecision,
    answers?: Record<string, string | string[]>,
    nativeOptionId?: string,
  ): Promise<void> {
    const gianSession = this.getSession(sessionId);
    const proxySessionId = this.proxySessionIds.get(sessionId);
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
    const isAcceptPlan = decision === 'accept_with_auto' || decision === 'accept_with_ask';
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
    // CLI runtime guard: in `runtime_mode='tty'` the user is typing directly
    // into the in-PTY claude/codex process. A structured `message:send`
    // would create a ghost turn with no backend (and for codex, also race
    // the TUI for the same on-disk thread). Reject early — caller (web / IM
    // bot / queue) is expected to switch the session back to structured
    // first. See spec §3.4.
    if (session.runtime_mode === 'tty') {
      throw new Error(`session is in CLI mode; switch to Chat before sending structured messages`);
    }
    if (session.executor === 'kimi' && oneShotBypass) {
      throw new Error('Kimi uses its native mode and does not support Gian one-shot bypass.');
    }
    // Reject before any optimistic writes if a turn is already in flight.
    // The downstream `startTurn` would return SESSION_BUSY, and the catch
    // path used to overwrite session.status to 'error' even though the
    // prior turn is still legitimately running on the proxy side.
    // Callers (WS handler) should route to enqueueMessage when this throws.
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
    }
    const proxySessionId = await this.ensureProxySession(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    const codexAttachmentRoot = session.executor === 'codex'
      ? await ensureSessionAttachmentDir(sessionId, this.dataDir)
      : null;

    // Per-Task Manager: neither proxy has a system/instructions channel for a
    // persistent chat session, so the Manager's system prompt is prepended to
    // its FIRST turn, wrapped in sentinels the web strips at render
    // (stripManagerSystemPrefix). Done HERE — not in sendManagerMessage — so it
    // applies exactly once to EVERY entry path: the REST helper AND the
    // structured `message:send` the web now uses for the Manager composer.
    if (session.type === 'manager' && session.task_id && this.persistedTurnCount(sessionId) === 0) {
      const prompt = this.buildManagerPrompt(session.task_id);
      const wrapped = `${MANAGER_SYS_OPEN}\n${prompt}\n${MANAGER_SYS_CLOSE}`;
      text = text.trim() ? `${wrapped}\n\n${text}` : wrapped;
      // When the turn carries structured items (e.g. an image attachment on the
      // very first message), the model reads `items`, not `text` — so fold the
      // prompt into the first text item too (or prepend one if there is none).
      if (items && items.length > 0) {
        const ti = items.findIndex(it => it.type === 'text');
        if (ti >= 0) {
          const orig = (items[ti] as { type: 'text'; text: string }).text;
          items = items.map((it, i) =>
            i === ti
              ? { type: 'text' as const, text: orig.trim() ? `${wrapped}\n\n${orig}` : wrapped }
              : it,
          );
        } else {
          items = [{ type: 'text' as const, text: wrapped }, ...items];
        }
      }
    }

    // gian-task context engine (RoleInjector, §4A.C). Env-gated until the wider
    // feature lands (Slice 2+): with GIAN_TASK_ROLES=1, an INDIVIDUAL (coding)
    // session gets the merged STATE.view refreshed before it orients, and on its
    // FIRST turn a small ROLE header prepended (structured / prepend-first-message
    // path). Best-effort — a scaffold/view hiccup must never block the turn.
    if (process.env.GIAN_TASK_ROLES === '1' && (session.type === 'coding' || session.type === 'subtask')) {
      const wsPath = this.workspacePathFor(session.workspace_id);
      if (wsPath) {
        try {
          regenerateStateViewIfDirty(wsPath);
        } catch {
          /* view refresh is a derived cache — ignore failures */
        }
        if (this.persistedTurnCount(sessionId) === 0) {
          const prefix = buildFirstTurnRolePrefix({
            role: roleForSessionType(session.type),
            sessionId,
            workspacePath: wsPath,
            taskName: session.task_id ? this.taskNameFor(session.task_id) : null,
          });
          text = text.trim() ? `${prefix}\n\n${text}` : prefix;
          if (items && items.length > 0) {
            const ti = items.findIndex(it => it.type === 'text');
            if (ti >= 0) {
              const orig = (items[ti] as { type: 'text'; text: string }).text;
              items = items.map((it, i) =>
                i === ti
                  ? { type: 'text' as const, text: orig.trim() ? `${prefix}\n\n${orig}` : prefix }
                  : it,
              );
            } else {
              items = [{ type: 'text' as const, text: prefix }, ...items];
            }
          }
        }
      }
    }

    const turnNumber = this.nextTurnNumber(sessionId);
    const turnId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(turnId, sessionId, turnNumber, now);

    this.activeTurns.set(sessionId, { id: turnId, number: turnNumber });

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
    this.persistEvent(sessionId, turnId, randomUUID(), 'user_message', userMessagePayload);
    this.broadcastEvent(sessionId, turnNumber, randomUUID(), 'user_message', userMessagePayload);

    // Initialise Job state on the first user-initiated turn of a job. We only
    // start a job when the queue is empty (this is a direct user send, not a
    // job continuation) and the session is configured for auto multi-turn.
    if (
      !this.jobs.has(sessionId) &&
      session.approval_mode === 'auto' &&
      session.turns > 1 &&
      this.queue.list(sessionId).length === 0
    ) {
      this.jobs.set(sessionId, {
        totalTurns: session.turns,
        completedTurns: 0,
        consecutiveErrors: 0,
      });
    }

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
        this.db.prepare(`DELETE FROM events WHERE turn_id = ?`).run(turnId);
        this.db.prepare(`DELETE FROM turns WHERE id = ?`).run(turnId);
        this.activeTurns.delete(sessionId);
      } else {
        this.completeTurn(sessionId, 'error');
      }
      this.watcher?.resume(sessionId);
      this.jobs.delete(sessionId);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle mutations (M1-D Composer + later session menu)
  // -------------------------------------------------------------------------

  setApprovalMode(sessionId: string, mode: ApprovalMode, turns?: number): void {
    const session = this.getSession(sessionId);
    if (session.executor === 'kimi') {
      throw new Error('Kimi mode is executor-native; use session:set_native_config.');
    }
    assertApprovalModeAllowed(session.executor, mode);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET approval_mode = ?, turns = ?, updated_at = ? WHERE id = ?`,
      )
      .run(mode, turns ?? 1, now, sessionId);
    this.broadcastSessionUpdated(sessionId, {
      approval_mode: mode,
      turns: turns ?? 1,
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
    return this.capsByExecutor.get(executor) ?? null;
  }

  async getNativeConfig(sessionId: string): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }> {
    const session = this.getSession(sessionId);
    await this.ensureProxySession(session);
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
    await this.ensureProxySession(session);
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
    await this.ensureProxySession(session);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    return client.listSlashCommands(this.cwdForSession(session) ?? undefined);
  }

  /** Force-fetch capabilities by spawning a proxy if not cached.
   *  Used by GET /api/proxy/:executor/models when no session exists yet. */
  async warmCapabilities(executor: 'codex' | 'claude'): Promise<import('@gian/shared').ProxyCapabilities> {
    const cached = this.capsByExecutor.get(executor);
    // Only return the cache if it actually has models. An empty list usually
    // means capability discovery failed (e.g. CLI binary missing) — caching
    // it forever locks the UI into "no models" until process restart. Retry
    // on each call instead so a fix-up (PATH change, binary install) heals
    // itself without bouncing the host.
    //
    // Also drop the cached proxy when models came back empty so the next
    // attempt actually re-runs discovery inside a fresh runtime instance.
    if (cached && cached.models.length > 0) return cached;
    if (cached) {
      this.capsByExecutor.delete(executor);
      try { await this.proxy.dispose(`__caps__${executor}`); } catch { /* ignore */ }
    }
    const tempKey = `__caps__${executor}`;
    const client = await this.proxy.getOrCreate(tempKey, executor);
    await client.initialize();
    const caps = await client.capabilities();
    this.capsByExecutor.set(executor, caps);
    return caps;
  }

  /** Slash commands for an executor. With cwd, includes project-level. */
  async listSlashCommands(executor: 'codex' | 'claude', cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    const tempKey = `__caps__${executor}`;
    const client = this.proxy.get(tempKey) ?? (await this.proxy.getOrCreate(tempKey, executor));
    await client.initialize();
    return client.listSlashCommands(cwd);
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
    if (session.runtime_mode === 'tty') {
      // Only codex has a TTY runtime now (Claude TTY mode was removed), and
      // codex TTY drain isn't wired — preserve the queue head and reject so
      // the CODEX-TTY-001 contract holds.
      throw new Error(`session is in CLI mode; switch to Chat before draining the queue`);
    }
    if (this.activeTurns.has(sessionId)) {
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
    if (session.runtime_mode === 'tty') {
      throw new Error(`session is in CLI mode; switch to Chat before steering`);
    }
    const client = this.proxy.get(sessionId);
    if (!client?.steerTurn) {
      throw new Error(`${session.executor} does not support steering`);
    }
    const active = this.activeTurns.get(sessionId);
    if (!active) {
      throw new Error(`no active turn for session ${sessionId}; send a normal message instead`);
    }
    const proxySessionId = await this.ensureProxySession(session);

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
    this.persistEvent(sessionId, active.id, randomUUID(), 'user_message', userMessagePayload);
    this.broadcastEvent(sessionId, active.number, randomUUID(), 'user_message', userMessagePayload);
  }

  // -------------------------------------------------------------------------
  // onEvent hook — M3 IM router subscribes here
  // -------------------------------------------------------------------------

  /** Subscribe to every dispatched UnifiedEvent. Returns an unsubscribe fn. */
  onEvent(fn: (e: UnifiedEvent) => void): () => void {
    this.eventSubscribers.push(fn);
    return () => {
      const idx = this.eventSubscribers.indexOf(fn);
      if (idx !== -1) this.eventSubscribers.splice(idx, 1);
    };
  }

  /** Convenience read for IM router to check queue depth without importing QueueManager. */
  getQueueLength(sessionId: string): number {
    return this.queue.list(sessionId).length;
  }

  // -------------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------------

  getSession(id: string): Session {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!row) throw new Error(`session not found: ${id}`);
    return this.hydrateSession(row);
  }

  listSessions(opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Session[] {
    let where = 'archived = 0';
    if (opts.archivedOnly) where = 'archived = 1';
    else if (opts.includeArchived) where = '1=1';
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY updated_at DESC`)
      .all() as SessionRow[];
    return rows.map(row => this.hydrateSession(row));
  }

  // -------------------------------------------------------------------------
  // Subtask completion → `.ai/` write-back (PRD-v3 P4)
  //
  // When a Subtask (type='subtask') is marked complete the session lands at
  // `done` and the summarizer rewrites the workspace's `.ai/` context in the
  // BACKGROUND — the user must never wait (§116). Abandon only appends one
  // SESSION_LOG line (§153).
  // -------------------------------------------------------------------------

  /** Optional cheap-model LLM hook for the summarizer. Null/absent ⇒ the
   *  deterministic template fallback runs. TODO(P4-live): inject a small-model
   *  direct client (NOT the Manager's gpt-5.5). */
  private summaryLlm: SummaryLlm | null = null;

  setSummaryLlm(llm: SummaryLlm | null): void {
    this.summaryLlm = llm;
  }

  /**
   * Mark a Subtask complete: set the USER completion flag `completed_at`
   * (NOT `status` — that stays the turn lifecycle, migration 027), then fire
   * the `.ai/` summarizer in the background. Never blocks. Orthogonal to the
   * turn: callable even while a turn is running/pending (spec §B2).
   */
  completeSubtask(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.type !== 'subtask') {
      throw new Error(`session ${sessionId} is not a subtask (type=${session.type})`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { completed_at: now, updated_at: now });

    // `now` is the version token: the writeback only proceeds if completed_at
    // still equals it (guards reopen, reopen+recomplete, and abandon races).
    this.runSummarizerInBackground(session, 'done', null, now);
  }

  /**
   * Reopen a completed Subtask: clear `completed_at`. No summarizer. The
   * in-flight summarizer writeback (if any) re-checks `completed_at` before
   * touching `.ai/` and bails when it sees null (spec §B2 / R2 #3).
   */
  reopenSubtask(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.type !== 'subtask') {
      throw new Error(`session ${sessionId} is not a subtask (type=${session.type})`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET completed_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    this.broadcastSessionUpdated(sessionId, { completed_at: null, updated_at: now });
  }

  /**
   * Abandon a Subtask (§153): set the session `done` and append ONE
   * SESSION_LOG line (`abandoned: <reason>`). HANDOFF/STATE are NOT rewritten.
   * Runs in the background like completion so it never blocks.
   */
  abandonSubtask(sessionId: string, reason?: string | null): void {
    const session = this.getSession(sessionId);
    if (session.type !== 'subtask') {
      throw new Error(`session ${sessionId} is not a subtask (type=${session.type})`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { completed_at: now, updated_at: now });

    this.runSummarizerInBackground(session, 'abandoned', reason ?? null, now);
  }

  /** Resolve the workspace path for a session, or null when it's gone. */
  private workspacePathFor(workspaceId: string): string | null {
    const ws = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { path: string } | undefined;
    return ws?.path ?? null;
  }

  // -------------------------------------------------------------------------
  // gian-task action protocol (proposal §4A.A / Slice 2-3). Env-gated by
  // GIAN_TASK_ROLES; the executor/loop tables are inert until it's on.
  // -------------------------------------------------------------------------

  /** Lazily-built executor bound to this manager's side effects. */
  private actionExecutor(): ActionExecutor {
    if (this._actionExecutor) return this._actionExecutor;
    this._actionExecutor = new ActionExecutor(this.db, {
      resolveWorkspaceId: nameOrPath => this.resolveWorkspaceId(nameOrPath),
      createSubtask: input => this.createSubtaskFromAction(input),
      messageSubtask: input => this.deliverToSubtask(input),
      writeStepSummary: input => this.writeStepSummary(input.session, input.params),
      onStepSubmitted: input => this.handleStepSubmitted(input.taskId, input.session, input.params),
    });
    return this._actionExecutor;
  }

  /** Reconstruct a completed turn's final assistant text from persisted full
   *  assistant messages (Claude path — `assistant_text` events are whole
   *  messages, not deltas). Codex does NOT come here: it passes the authoritative
   *  `turn_completed` assistantText directly (final-only contract, §4A.A ①), so
   *  we never parse un-persisted `output.text.delta` streams. */
  private finalAssistantTextForTurn(turnId: string): string {
    const parts: string[] = [];
    const rows = this.db
      .prepare(
        `SELECT data FROM events WHERE turn_id = ? AND type IN ('assistant_text','output.text') ORDER BY rowid ASC`,
      )
      .all(turnId) as { data: string }[];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        if (typeof data.text === 'string' && data.text) parts.push(data.text);
      } catch {
        /* skip malformed */
      }
    }
    return parts.join('');
  }

  /** Codex `turn_completed` carries the authoritative final assistant text
   *  (`assistantText` = all agentMessage text joined, service.ts:1188). Returns
   *  it for a codex session, or undefined otherwise (Claude reconstructs from
   *  its own events). */
  private codexFinalTextFromNotification(sessionId: string, n: ProxyNotification): string | undefined {
    let session: Session;
    try {
      session = this.getSession(sessionId);
    } catch {
      return undefined;
    }
    if (session.executor !== 'codex') return undefined;
    const params = (n as { params?: unknown }).params as Record<string, unknown> | undefined;
    const data = ((params?.data ?? params) ?? {}) as Record<string, unknown>;
    const summary = (data.summary ?? {}) as Record<string, unknown>;
    const at = summary.assistantText;
    return typeof at === 'string' && at ? at : undefined;
  }

  /** The gian-task action pipeline (parse a trailing `<<gian:action>>` from a
   *  completed turn's final text) is env-gated by GIAN_TASK_ROLES for
   *  INDIVIDUAL / ENGINEER sessions. The Task Manager's path is ALWAYS on: it
   *  replaces the manager's older `<<gian:create_subtask>>` proposal→card
   *  mechanism with the surface-agnostic action envelope, which works in web AND
   *  worked in Claude TTY (where no confirm chip could render) before that
   *  mode was removed. */
  private taskActionsEnabled(session: Session): boolean {
    return process.env.GIAN_TASK_ROLES === '1' || session.type === 'manager';
  }

  /** Parse + record + execute a trailing gian:action from a completed structured
   *  turn. `explicitFinalText` is the runtime's authoritative final-only text —
   *  Codex passes `turn_completed`'s `assistantText` (§4A.A ①); Claude passes
   *  nothing and we reconstruct from its persisted full assistant_text messages. */
  private processCompletedTurnAction(sessionId: string, turnId: string, explicitFinalText?: string): void {
    let session: Session;
    try {
      session = this.getSession(sessionId);
    } catch {
      return;
    }
    if (!this.taskActionsEnabled(session)) return;
    if (!session.task_id) return; // actions only mean something inside a Task
    const finalText = explicitFinalText ?? this.finalAssistantTextForTurn(turnId);
    if (!finalText) return;
    this.recordAndDriveAction(session, finalText, { hostTurnId: turnId, sourceTurnKey: turnId });
  }

  /**
   * Parse a final-text blob and, if it carries a trailing gian:action,
   * SYNCHRONOUSLY record it (durability floor — the row exists before the async
   * side effect, so a crash is recoverable by the startup scan) then drive it
   * to completion asynchronously.
   */
  private recordAndDriveAction(
    session: Session,
    finalText: string,
    keys: { hostTurnId: string | null; sourceTurnKey: string },
  ): void {
    const parsed = parseGianAction(finalText);
    if (!parsed.ok) return;
    const ex = this.actionExecutor();
    const rec = ex.recordParsed({
      session,
      action: parsed.action,
      blockText: parsed.blockText,
      hostTurnId: keys.hostTurnId,
      sourceTurnKey: keys.sourceTurnKey,
    });
    if (!rec || isTerminalStatus(rec.status) || rec.status === 'staged' || rec.status === 'queued') return;
    void ex.driveRecorded(rec.action_id, session).catch(err =>
      console.error(`[gian-task] action drive failed session=${session.id} action=${rec.action_id}: ${(err as Error).message}`),
    );
  }

  /**
   * Startup reconciliation (durability): re-drive any action rows a crash/restart
   * left non-terminal (parsed/validated/authorized/executing). Idempotent — the
   * executor's guards mark an interrupted `executing` failed and re-authorize the
   * rest. Call once at boot (app.ts). The Task Manager path is always-on; coding
   * / subtask action rows still respect GIAN_TASK_ROLES through taskActionsEnabled.
   */
  resumePendingTaskActions(): void {
    const rows = this.db
      .prepare("SELECT action_id, session_id FROM task_actions WHERE status IN ('parsed','validated','authorized','executing')")
      .all() as { action_id: string; session_id: string }[];
    for (const r of rows) {
      let session: Session;
      try {
        session = this.getSession(r.session_id);
      } catch {
        continue;
      }
      if (!this.taskActionsEnabled(session)) continue;
      void this.actionExecutor().resume(r.action_id, session).catch(err =>
        console.error(`[gian-task] resume failed action=${r.action_id}: ${(err as Error).message}`),
      );
    }
  }

  /** Resolve a workspace name or absolute path to a canonical workspace id. */
  private resolveWorkspaceId(nameOrPath: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM workspaces WHERE name = ? OR path = ? LIMIT 1')
      .get(nameOrPath, nameOrPath) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** create_subtask handler: spawn a subtask under the task and deliver its
   *  brief as the first message. Returns the new subtask session id. */
  private async createSubtaskFromAction(input: {
    taskId: string;
    workspaceId: string;
    executor: Executor;
    name?: string;
    brief: string;
  }): Promise<string> {
    const session = await this.createSession({
      workspace_id: input.workspaceId,
      executor: input.executor,
      type: 'subtask',
      task_id: input.taskId,
      ...(input.name ? { name: input.name } : {}),
    });
    this.broadcaster.broadcast({ type: 'session:created', session });
    // AWAIT the brief handoff (RoleInjector prepends the ENGINEER ROLE header).
    // sendMessage resolves once startTurn is accepted; if the proxy/session
    // fails to start it throws, so the executor marks the action failed and
    // does NOT point the loop at an engineer that never received its brief.
    await this.sendMessage(session.id, input.brief);
    return session.id;
  }

  /** message_subtask handler: deliver to an existing subtask honoring its state
   *  (§4A.A ⑤). idle → send; busy → queue; TTY/terminal → failed. */
  private async deliverToSubtask(input: {
    taskId: string;
    subtaskId: string;
    text: string;
  }): Promise<MessageOutcome> {
    let target: Session;
    try {
      target = this.getSession(input.subtaskId);
    } catch {
      return 'failed';
    }
    if (target.task_id !== input.taskId) return 'failed'; // per-task isolation
    if (target.completed_at || target.worktree_outcome) return 'failed'; // terminal
    // A TTY target is necessarily codex now (Claude TTY mode was removed),
    // and codex has no host automation channel — the message can't be
    // delivered into the PTY, so fail loudly rather than silently lose it.
    if (target.runtime_mode === 'tty') {
      return 'failed';
    }
    // A busy structured turn queues (drains on turn.completed via maybeAutoSendNext).
    if (this.activeTurns.has(input.subtaskId)) {
      this.enqueueMessage(input.subtaskId, input.text);
      return 'queued';
    }
    try {
      await this.sendMessage(input.subtaskId, input.text);
      return 'delivered';
    } catch {
      this.enqueueMessage(input.subtaskId, input.text);
      return 'queued';
    }
  }

  /** submit_step handler: write the engineer's step summary onto its session
   *  (M5 — the action handler now owns sessions.summary for task subtasks). */
  private writeStepSummary(session: Session, params: SubmitStepParams): void {
    const verdict = params.verdict ? ` [${params.verdict}]` : '';
    const points = params.points && params.points.length > 0 ? ` — ${params.points.join('; ')}` : '';
    const summary = `${params.headline}${verdict}${points}`.slice(0, 2000);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now, session.id);
    this.broadcastSessionUpdated(session.id, { summary, updated_at: now });
  }

  /** After an engineer submits its step: advance the loop (if any), wake the PM. */
  private async handleStepSubmitted(taskId: string, session: Session, params: SubmitStepParams): Promise<void> {
    const loop = getActiveLoop(this.db, taskId);
    let loopNote = '';
    if (loop) {
      const decision = advanceLoop(loop, { status: params.status, verdict: params.verdict ?? null });
      updateLoop(this.db, loop.id, { status: decision.nextStatus, round: decision.nextRound });
      loopNote = `loop: ${decision.nextRound}/${loop.max_rounds || '∞'} (${decision.outcome})`;
    }
    await this.wakePmForStep(taskId, session, params, loopNote);
  }

  /** Wake the task's PM (manager session) with a completion digest (§4.8 ④). */
  private async wakePmForStep(taskId: string, subtask: Session, params: SubmitStepParams, loopNote: string): Promise<void> {
    const manager = this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? AND type = 'manager' AND archived = 0 LIMIT 1")
      .get(taskId) as Session | undefined;
    if (!manager) return; // no PM to wake (manual subtask)
    const verdict = params.verdict ? `结论: ${params.verdict}` : `status: ${params.status}`;
    const points = params.points && params.points.length > 0 ? `\n要点: ${params.points.join('; ')}` : '';
    const digest = [
      MANAGER_SYS_OPEN,
      '<<gian:subtask-done>>',
      `${subtask.name ?? subtask.id} [${subtask.executor}] 完成。${verdict}${points}`,
      loopNote,
      '请决定下一步。',
      '<</gian:subtask-done>>',
      MANAGER_SYS_CLOSE,
    ]
      .filter(Boolean)
      .join('\n');
    if (manager.runtime_mode === 'tty') {
      // A TTY manager is necessarily codex now (Claude TTY mode was removed)
      // and has no host automation channel — the wake digest can't be pasted
      // into the PTY, so drop it (the previous automatedInput call was a
      // silent no-op for codex too).
      return;
    }
    if (this.activeTurns.has(manager.id)) {
      // Structured PM mid-turn — enqueue so the completion signal isn't lost;
      // maybeAutoSendNext drains it on the next turn.completed.
      this.enqueueMessage(manager.id, digest);
    } else {
      await this.sendMessage(manager.id, digest);
    }
  }

  /** Start a loop contract for a task (§4.5). Any prior active loop is closed. */
  startLoop(taskId: string, input: Omit<InsertLoopInput, 'id' | 'task_id'>): TaskLoop {
    if (!this.taskNameFor(taskId)) throw new Error(`task not found: ${taskId}`);
    const prior = getActiveLoop(this.db, taskId);
    if (prior) updateLoop(this.db, prior.id, { status: 'done' });
    const id = randomUUID();
    insertLoop(this.db, { id, task_id: taskId, ...input });
    return getLoop(this.db, id) as TaskLoop;
  }

  getTaskLoop(taskId: string): TaskLoop | null {
    return getActiveLoop(this.db, taskId);
  }

  /** Actions recorded for a task, newest first (drives the staged-confirm chip). */
  listTaskActions(taskId: string): TaskAction[] {
    return this.db
      .prepare('SELECT * FROM task_actions WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as TaskAction[];
  }

  /** Confirm a staged action (user clicked confirm). Verifies the action
   *  belongs to `taskId` — a cross-task action id is rejected as not-found. */
  async confirmTaskAction(taskId: string, actionId: string): Promise<TaskAction | null> {
    const row = this.db
      .prepare('SELECT * FROM task_actions WHERE action_id = ?')
      .get(actionId) as TaskAction | undefined;
    if (!row || row.task_id !== taskId) return null;
    const session = this.getSession(row.session_id);
    return this.actionExecutor().confirmStaged(actionId, session);
  }

  /** Reject a staged action (user clicked reject). Task-ownership checked. */
  rejectTaskAction(taskId: string, actionId: string): TaskAction | null {
    const row = this.db
      .prepare('SELECT task_id FROM task_actions WHERE action_id = ?')
      .get(actionId) as { task_id: string } | undefined;
    if (!row || row.task_id !== taskId) return null;
    return this.actionExecutor().rejectStaged(actionId);
  }

  /** Concatenate the session's persisted assistant text into a transcript blob
   *  for the summarizer. Best-effort — empty is fine (template still works). */
  private buildTranscript(sessionId: string): string {
    const rows = this.db
      .prepare(
        `SELECT data FROM events
         WHERE session_id = ? AND type = 'assistant_text'
         ORDER BY rowid ASC`,
      )
      .all(sessionId) as { data: string }[];
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        const text = String(data.text ?? data.delta ?? '');
        if (text) parts.push(text);
      } catch { /* skip unparseable */ }
    }
    return parts.join('');
  }

  /**
   * Fire the `.ai/` writeback off the hot path. Resolves the workspace dir,
   * builds the transcript, runs the (live-or-template) summarizer, and — for
   * completion — persists the one-line summary to `sessions.summary`. All
   * errors are swallowed and logged: a writeback failure must never surface to
   * the user or affect session state (§116/§155).
   */
  private runSummarizerInBackground(
    session: Session,
    status: 'done' | 'abandoned',
    reason: string | null = null,
    /** Version token = the `completed_at` value stamped by this complete/abandon
     *  call. The detached writeback only proceeds while the row's completed_at
     *  STILL equals it — so a reopen (null), a reopen+recomplete (different
     *  timestamp), or an abandon-after-complete (different timestamp) all cancel
     *  the stale writeback. A plain truthiness check would miss recomplete. */
    token: string | null = null,
  ): void {
    const workspaceDir = this.workspacePathFor(session.workspace_id);
    const subtask: SubtaskContext = {
      id: session.id,
      name: session.name,
      status,
      transcript: status === 'done' ? this.buildTranscript(session.id) : undefined,
    };

    // Detach: schedule on the microtask queue so completeTurn/the REST handler
    // returns immediately. Any throw is contained here. The version-token guard
    // (Codex review) is re-checked before touching `.ai/` and again after the
    // async summarize() await.
    const stillCurrent = () => {
      const current = (this.db
        .prepare('SELECT completed_at FROM sessions WHERE id = ?')
        .get(session.id) as { completed_at: string | null } | undefined)?.completed_at ?? null;
      return token !== null && current === token;
    };

    void Promise.resolve().then(async () => {
      try {
        if (!workspaceDir) {
          console.error(`[summarizer] workspace gone for subtask ${session.id}; skipping writeback`);
          return;
        }
        if (!stillCurrent()) return; // reopened / recompleted / abandoned since
        if (status === 'abandoned') {
          applyAbandonWriteback(workspaceDir, subtask, reason);
          return;
        }
        const result = await summarizeCompletedSubtask({
          workspaceDir,
          subtask,
          llm: this.summaryLlm,
        });
        if (!stillCurrent()) return; // reopened / recompleted / abandoned during summarize()
        // Persist the user-editable subtask summary.
        const now = new Date().toISOString();
        this.db
          .prepare(`UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?`)
          .run(result.summary, now, session.id);
        this.broadcastSessionUpdated(session.id, { summary: result.summary, updated_at: now });
      } catch (err) {
        console.error(`[summarizer] writeback failed for subtask ${session.id}:`, err);
      }
    });
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
    const session = this.getSession(sessionId);
    if (!session.branch || !session.base_branch) {
      throw new Error('session is not in worktree mode');
    }
    if (session.worktree_outcome) {
      throw new Error(`session already ${session.worktree_outcome}`);
    }
    const workspace = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${sessionId}`);

    // Checkout base, merge --no-ff. Throws on conflict — caller surfaces
    // the error to the user; the worktree is left intact for inspection.
    mergeBranch(workspace.path, session.branch, session.base_branch);

    // Tear down the proxy session before yanking the dir out from under it.
    await this.teardownProxy(sessionId);

    if (session.worktree_path) {
      removeWorktree(workspace.path, session.worktree_path, session.branch);
    }
    this.finalizeWorktree(sessionId, 'merged');
    this.broadcastWorkspaceGitUpdated(session.workspace_id, 'merge');
  }

  async dropWorktree(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session.branch) throw new Error('session is not in worktree mode');
    if (session.worktree_outcome) {
      throw new Error(`session already ${session.worktree_outcome}`);
    }
    const workspace = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${sessionId}`);

    await this.teardownProxy(sessionId);
    if (session.worktree_path) {
      removeWorktree(workspace.path, session.worktree_path, session.branch);
    }
    this.finalizeWorktree(sessionId, 'discarded');
    this.broadcastWorkspaceGitUpdated(session.workspace_id, 'drop');
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

  private async teardownProxy(sessionId: string): Promise<void> {
    // Kill the CLI-mode PTY before closing the structured session.
    // `closeSession` only tears down the structured wire; without an
    // explicit `ttyKill` the codex-proxy (shared across all codex
    // sessions) keeps `codex resume` running against an already-
    // removed worktree. `stop()` is a no-op when there is no live PTY,
    // so this is safe to call unconditionally for runtime_mode='tty'
    // sessions (which are codex-only since Claude TTY mode was removed).
    let session: Session | null = null;
    try { session = this.getSession(sessionId); } catch { /* row may already be gone */ }
    if (session?.runtime_mode === 'tty' && session.executor === 'codex') {
      try { await this.codexTtyMgr?.stop(session); } catch { /* best-effort cleanup */ }
    }
    const proxyClient = this.proxy.get(sessionId);
    const proxySessionId = this.proxySessionIds.get(sessionId);
    if (proxyClient && proxySessionId) {
      try { await proxyClient.closeSession(proxySessionId); } catch { /* ignore */ }
    }
    this.proxySessionIds.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.watcher?.stop(sessionId);
  }

  archiveSession(sessionId: string, archived: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? 1 : 0, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { archived: archived ? 1 : 0, updated_at: now });
  }

  /**
   * Toggle the unread marker. Deliberately does NOT touch `updated_at` — read/
   * unread is a view-state change and must not reorder the sidebar. Idempotent.
   */
  setUnread(sessionId: string, unread: boolean): void {
    this.db
      .prepare(`UPDATE sessions SET unread = ? WHERE id = ?`)
      .run(unread ? 1 : 0, sessionId);
    this.broadcastSessionUpdated(sessionId, { unread: unread ? 1 : 0 });
  }

  /**
   * Permanently delete a session. If the session is a still-live worktree
   * (no outcome yet), drop the worktree first to avoid orphaning the dir
   * on disk. Then teardown proxy + cascade-delete via FK constraints.
   */
  /** Ids of every session owned by a Task (its PM manager + all subtasks).
   *  Used by the cascade delete path in ws-handler `task:delete`. */
  listSessionIdsForTask(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE task_id = ?')
      .all(taskId) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.branch && !session.worktree_outcome && session.worktree_path) {
      // Drop side-effects: remove worktree + branch. Don't fail the delete
      // if cleanup partially fails — the user wants this gone.
      const workspace = this.db
        .prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(session.workspace_id) as { path: string } | undefined;
      if (workspace) {
        try { removeWorktree(workspace.path, session.worktree_path, session.branch); }
        catch { /* swallow */ }
      }
    }
    await this.teardownProxy(sessionId);
    this.conversationUsageTurns.delete(sessionId);
    // Drop any pending approvals before the session row goes away — otherwise
    // they linger in approvals.pending and re-surface on next state_sync.
    this.approvals.clearSession(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    await purgeSessionAttachments(sessionId);
    this.broadcaster.broadcast({ type: 'session:deleted', session_id: sessionId });
    // If the session owned a worktree branch, removal above changed git
    // state — let the Workspace Git panel pick that up live.
    if (session.branch) {
      this.broadcastWorkspaceGitUpdated(session.workspace_id, 'session-deleted');
    }
  }

  listEvents(sessionId: string): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.call_id, e.type, e.data, e.created_at, t.turn_number
         FROM events e
         LEFT JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ?
         ORDER BY e.rowid ASC`,
      )
      .all(sessionId) as Array<{
        id: string;
        call_id: string;
        type: string;
        data: string;
        created_at: string;
        turn_number: number | null;
      }>;
    return rows.map(r => ({
      session_id: sessionId,
      turn: r.turn_number ?? 0,
      call_id: r.call_id,
      event: r.type,
      ts: Date.parse(r.created_at),
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private nextTurnNumber(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(turn_number) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number | null } | undefined;
    return (row?.n ?? 0) + 1;
  }

  private persistedTurnCount(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private hydrateSession(row: SessionRow): Session {
    const {
      executor_config_json: executorConfigJson,
      fork_from_session_id: _forkFromSessionId,
      ...stored
    } = row;
    return {
      ...stored,
      executor_config: parseExecutorConfig(executorConfigJson),
      native_config_options: this.nativeConfigOptions.get(row.id) ?? [],
    } as Session;
  }

  private persistNativeConfigSnapshot(
    sessionId: string,
    state: ExecutorConfigState,
    options: NativeConfigOption[],
  ): void {
    const now = new Date().toISOString();
    this.nativeConfigOptions.set(sessionId, options);
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

  private persistKimiReplay(
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
      const normalized = normalizeKimiNotification(
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
      for (const event of normalized) {
        insert(
          activeTurnId,
          event.call_id,
          event.type,
          event.data as unknown as Record<string, unknown>,
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

  /** Task display name, or null if unknown. */
  private taskNameFor(taskId: string): string | null {
    const row = this.db
      .prepare('SELECT name FROM tasks WHERE id = ?')
      .get(taskId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  private persistTokenUsage(
    sessionId: string,
    turnId: string | undefined,
    update: ParsedTokenUsageUpdate,
  ): void {
    const session = this.getSession(sessionId);
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

  private handleNotification(
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
      const session = this.getSession(sessionId);
      const update = parseTokenUsageUpdate(notification.params?.data, session.executor);
      if (update) this.persistTokenUsage(sessionId, notification.params?.turnId, update);
      return;
    }

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
        this.persistNativeConfigSnapshot(sessionId, stateFromOptions(options), options);
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

    // TTY runtime notifications get re-broadcast as binary-ish ws messages
    // (`pty:output`) instead of structured transcript events. Hand them
    // straight to the CodexTtyManager and stop — running them through the
    // structured normalizer would either drop them silently or, worse,
    // synthesize bogus turn events that confuse the UI.
    if (
      notification.method === 'tty.output' ||
      notification.method === 'tty.exited'
    ) {
      // Only codex has a TTY runtime now (Claude TTY mode was removed), so
      // these always come from the shared codex-proxy. CodexTtyManager reads
      // `params.gianSessionId` for routing (`sessionId` is the proxy-side key).
      this.codexTtyMgr?.handleProxyNotification(notification as { method?: string; params?: unknown });
      return;
    }

    // Normalize/dispatch BEFORE handleLifecycle. handleLifecycle calls
    // completeTurn on turn.completed/failed, which deletes the activeTurns
    // map entry; if that runs first, dispatchUnified would persist the event
    // with a fresh random turn_id that doesn't exist in `turns` and trip the
    // FK constraint.
    const unified = this.runNormalizer(sessionId, notification);
    for (const e of unified) this.dispatchUnified(e);
    if (unified.length === 0 && notification.method !== 'debug' && notification.method !== 'token_usage.updated') {
      // Anything the normalizer doesn't recognize is a signal that a new
      // proxy event was added without a unified mapping. Log loudly so we
      // notice — but don't persist or broadcast the raw shape, which would
      // leak proxy-specific names through to the WS/DB layer.
      console.warn(`[session] no unified mapping for proxy event: ${notification.method}`);
    }

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
      const session = this.getSession(gianSessionId);
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

  /** Pre-normalization hook for turn lifecycle bookkeeping (status + queue). */
  private handleLifecycle(sessionId: string, n: ProxyNotification): void {
    if (n.method === 'turn.completed') {
      // Codex carries the authoritative final text on the notification; Claude
      // passes nothing here and completeTurn reconstructs from its events.
      this.completeTurn(sessionId, 'completed', this.codexFinalTextFromNotification(sessionId, n));
      // Live Sync v2: proxy finished writing this turn to the JSONL; advance
      // watcher offset to current EOF so we skip our own writes and resume
      // tailing for any external CLI appends from here.
      this.watcher?.resume(sessionId);
      // Queue drain takes priority: if there's a queued message, send it and
      // skip job continuation so the two mechanisms don't double-fire.
      if (this.maybeAutoSendNext(sessionId)) return;
      this.maybeJobContinue(sessionId);
    } else if (n.method === 'turn.failed') {
      this.completeTurn(sessionId, 'error');
      this.watcher?.resume(sessionId);
      if (this.maybeAutoSendNext(sessionId)) return;
      this.maybeJobContinueAfterError(sessionId);
    }
  }

  private runNormalizer(
    sessionId: string,
    notification: ProxyNotification,
  ): UnifiedEvent[] {
    const session = this.getSession(sessionId);
    const turn = this.activeTurns.get(sessionId)?.number ?? 0;
    if (session.executor === 'codex') {
      return normalizeCodexNotification(notification, sessionId, turn);
    }
    if (session.executor === 'kimi') {
      return normalizeKimiNotification(notification, sessionId, turn);
    }
    return normalizeCcNotification(notification, sessionId, turn);
  }

  /** Persist + broadcast a UnifiedEvent. */
  private dispatchUnified(e: UnifiedEvent): void {
    this.persistEvent(e.session_id, this.activeTurnId(e.session_id), e.call_id, e.type, e.data as unknown as Record<string, unknown>);
    this.broadcaster.broadcast({
      type: 'event',
      session_id: e.session_id,
      turn: e.turn,
      call_id: e.call_id,
      event: e.type,
      ts: e.ts,
      data: e.data as unknown as Record<string, unknown>,
    });
    this.afterUnified(e);
    for (const fn of this.eventSubscribers) {
      try { fn(e); } catch {}
    }
  }

  /**
   * Post-broadcast hook for cross-cutting state updates triggered by
   * specific event types — used by Approval (Track C) to register pending
   * approvals into the global list.
   */
  private afterUnified(e: UnifiedEvent): void {
    if (e.type === 'approval_requested') {
      const d = e.data as import('@gian/shared').ApprovalRequestedData;
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
  }

  /** Pop the next queued message and re-enter sendMessage. Returns true if sent. */
  private maybeAutoSendNext(sessionId: string): boolean {
    // CLI runtime guard: don't drain the queue into a session that's now
    // in TTY mode — the message would be rejected by sendMessage anyway,
    // and popNext would burn the head. Leave the queue intact for when
    // the user flips back to Chat.
    let session;
    try { session = this.getSession(sessionId); } catch { return false; }
    if (session.runtime_mode === 'tty') return false;
    const next = this.queue.popNext(sessionId);
    if (!next) return false;
    this.broadcastQueueUpdated(sessionId);
    void this.sendMessage(sessionId, next.text, next.items).catch(err => {
      console.error('[queue] auto-send failed', err);
    });
    return true;
  }

  /**
   * After a successful turn, check job state and auto-send "continue" if we
   * haven't hit the turn limit and the AI hasn't signalled completion.
   */
  private maybeJobContinue(sessionId: string): void {
    const job = this.jobs.get(sessionId);
    if (!job) return;

    job.completedTurns += 1;
    job.consecutiveErrors = 0;

    if (job.completedTurns >= job.totalTurns) {
      this.jobs.delete(sessionId);
      return;
    }

    // Heuristic: if the AI's last assistant_text looks like a completion signal,
    // stop early. False negatives are fine — user can stop manually.
    if (this.lastAssistantSignalsCompletion(sessionId)) {
      this.jobs.delete(sessionId);
      return;
    }

    void this.sendMessage(sessionId, 'continue').catch(err => {
      console.error('[job] auto-continue failed', err);
      this.jobs.delete(sessionId);
    });
  }

  /**
   * After a failed turn, increment consecutive error count. Stop after 3 to
   * avoid a runaway loop hammering a broken session.
   */
  private maybeJobContinueAfterError(sessionId: string): void {
    const job = this.jobs.get(sessionId);
    if (!job) return;

    job.consecutiveErrors += 1;
    if (job.consecutiveErrors >= 3) {
      this.jobs.delete(sessionId);
      return;
    }

    void this.sendMessage(sessionId, 'continue').catch(err => {
      console.error('[job] auto-continue after error failed', err);
      this.jobs.delete(sessionId);
    });
  }

  /**
   * Inspects the raw notification params for a completion signal in the last
   * assistant text chunk. Loose heuristic — false negatives accepted.
   */
  private lastAssistantSignalsCompletion(sessionId: string): boolean {
    // The turn.completed notification itself doesn't carry the assistant text.
    // Instead, look at the most recent assistant_text event in the DB.
    const row = this.db
      .prepare(
        `SELECT e.data FROM events e
         INNER JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ? AND e.type IN ('assistant_text', 'output.text', 'output.text.delta')
         ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(sessionId) as { data: string } | undefined;
    if (!row) return false;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const text = String(data.text ?? data.delta ?? '').toLowerCase();
      return (
        text.includes('done') ||
        text.includes('complete') ||
        text.includes('finished') ||
        text.includes('all set')
      );
    } catch {
      return false;
    }
  }

  private activeTurnId(sessionId: string): string {
    return this.activeTurns.get(sessionId)?.id ?? randomUUID();
  }

  private handleProxyExit(sessionId: string, code: number | null): void {
    // Pending approvals that were in flight against this proxy will never
    // resolve now — drop them so the UI's approval list stays accurate.
    this.approvals.clearSession(sessionId);
    // Drop the cached proxy session id regardless of turn state. If we skip
    // this when no turn is active (proxy killed externally, idle exit, …),
    // the next sendMessage hits a stale cache → `no proxy for session`.
    this.proxySessionIds.delete(sessionId);
    this.jobs.delete(sessionId);
    this.watcher?.resume(sessionId);
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    console.error(`[session] proxy exited mid-turn session=${sessionId} code=${code} turn=${active.id}`);
    this.completeTurn(sessionId, 'error');
  }

  private completeTurn(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
    finalText?: string,
  ): void {
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE turns SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, now, active.id);
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
    // gian-task action protocol (env-gated). Parse the just-completed turn's
    // final assistant text for a trailing <<gian:action>> block; the row is
    // recorded SYNCHRONOUSLY here (durability), then executed async so
    // completion never blocks. Only clean completions.
    if (status === 'completed') {
      // processCompletedTurnAction gates on taskActionsEnabled (env flag OR the
      // Task Manager, whose action path is always-on — see the helper).
      this.processCompletedTurnAction(sessionId, active.id, finalText);
    }
    this.activeTurns.delete(sessionId);
  }

  private persistEvent(
    sessionId: string,
    turnId: string,
    callId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), sessionId, turnId, callId, type, JSON.stringify(data));
  }

  private broadcastEvent(
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

  private broadcastSessionUpdated(id: string, partial: Partial<Session>): void {
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id, ...partial },
    });
  }

  private broadcastQueueUpdated(sessionId: string): void {
    this.broadcaster.broadcast({
      type: 'queue:updated',
      session_id: sessionId,
      queue: this.queue.list(sessionId).map(e => ({ id: e.id, text: e.text })),
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
