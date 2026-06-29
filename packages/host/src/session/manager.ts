import type {
  ApprovalMode,
  EventEnvelope,
  Executor,
  MessageAttachment,
  ProxyNotification,
  RuntimeMode,
  Session,
  SessionType,
  ThinkingEffort,
  UnifiedEvent,
  WorktreeOutcome,
} from '@gian/shared';
import { MANAGER_SYS_OPEN, MANAGER_SYS_CLOSE } from '@gian/shared';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { mimeForAttachment } from '../storage/attachments.js';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { purgeSessionAttachments } from '../storage/attachments.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ApprovalManager } from '../approval/index.js';
import type { QueueManager } from '../queue/index.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { TtyManager } from '../tty/manager.js';
import type { CodexTtyManager } from '../tty/codex-manager.js';
import { locateNativeJsonl, locateCcJsonl, appendCcCustomTitle } from '../native/locate-jsonl.js';
import {
  normalizeCcNotification,
  normalizeCodexNotification,
} from '../event/index.js';
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
  MANAGER_EXECUTOR,
  MANAGER_MODEL,
  MANAGER_EFFORT,
} from '../task/manager-session.js';
import {
  summarizeCompletedSubtask,
  applyAbandonWriteback,
  type SubtaskContext,
  type SummaryLlm,
} from '../task/summarizer.js';

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
   *  A Subtask is created with type='subtask'; the per-Task read-only Codex
   *  Manager with type='manager'. */
  type?: SessionType;
  /** The Task this session belongs to (PRD-v3). Null/absent = a standalone
   *  ("scattered") session. */
  task_id?: string | null;
  /** Pin the reasoning effort at create time (Manager forces 'xhigh').
   *  Defaults to the per-executor config default when absent. */
  thinking_effort?: ThinkingEffort | null;
}

/**
 * Translate Gian's host-facing ApprovalMode (plan/ask/auto) into the
 * per-turn execution policy params for each executor's proxy.
 *
 *   plan  — read-only exploration; agent constrained to planning behavior
 *   ask   — every risky action surfaces as a user approval
 *   auto  — agent runs autonomously with executor-side safety classifier
 *
 * The two executors expose different primitives:
 *   - cc-proxy: a single `permissionMode` flag (Claude CLI native)
 *   - codex-proxy: four orthogonal fields (sandbox / approvalPolicy /
 *                  approvalsReviewer / collaborationMode)
 *
 * Each field is omitted when the proxy doesn't need it; both proxies tolerate
 * unknown extra fields (other proxy's params just get ignored).
 */
function proxyTurnParamsFor(
  executor: Executor,
  mode: ApprovalMode,
): {
  permissionMode?: 'plan' | 'default' | 'auto' | 'bypassPermissions';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
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
  }
}
/**
 * Map shared InputItem[] to the items the target executor accepts.
 *   - codex: passes everything through (skill / text / localImage all native)
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
 *  the `localImage` items the client supplied. Filenames stored under
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
    if (it.type !== 'localImage') continue;
    const filename = basename(it.path);
    const mime = it.mime ?? mimeForAttachment(filename);
    if (!mime) continue; // unknown extension — skip rather than serve an unreadable URL
    out.push({
      name: it.name ?? filename,
      mime,
      url: `/api/sessions/${sessionId}/attachments/${filename}`,
    });
  }
  return out;
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
  /** Job Mode state keyed by session id. Present only while a job is active. */
  private jobs = new Map<string, JobState>();
  /** Subscribers added via onEvent — receives every dispatched UnifiedEvent. */
  private eventSubscribers: Array<(e: UnifiedEvent) => void> = [];
  /** Capabilities cached on first proxy session create per executor.
   *  GET /api/proxy/:executor/models reads this. */
  private capsByExecutor = new Map<string, import('@gian/shared').ProxyCapabilities>();

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
    /** TTY runtime coordinator. Injected after construction (circular —
     *  TtyManager doesn't actually depend on SessionManager). Null when
     *  TTY mode isn't wired (older tests, mocked envs). */
    private ttyMgr: TtyManager | null = null,
    /** Codex TTY runtime coordinator — same lazy-injection pattern as
     *  `ttyMgr`. Null when codex CLI mode isn't wired. */
    private codexTtyMgr: CodexTtyManager | null = null,
  ) {}

  setTtyManager(mgr: TtyManager): void {
    this.ttyMgr = mgr;
  }

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
    const approvalMode: ApprovalMode = input.approval_mode ?? 'auto';

    // Resolve session defaults from system config when the caller didn't pin
    // them. The Settings panel writes `default_{claude,codex}_{model,effort}`
    // but until now nothing read them. Empty strings in config mean "let the
    // proxy / CLI pick" → leave null so we don't override anything.
    const cfg = loadConfig(this.db);
    const defaultModel = input.executor === 'claude'
      ? cfg.default_claude_model.trim()
      : cfg.default_codex_model.trim();
    const defaultEffort = input.executor === 'claude'
      ? cfg.default_claude_effort.trim()
      : cfg.default_codex_effort.trim();
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

    const cwd = worktreePath ?? workspace.path;

    // Bring up the proxy and create the upstream session FIRST so we can
    // capture the native session id (cc claudeSessionId / codex threadId)
    // and persist it on the row. Failure here rolls back the worktree we
    // may have just created — no half-row is ever inserted.
    let proxyResult: { proxySessionId: string; nativeSessionId: string };
    try {
      proxyResult = await this.bringUpProxySession({
        sessionId: id,
        executor: input.executor,
        cwd,
        model: effectiveModel,
        displayName: input.name ?? null,
      });
    } catch (err) {
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
        `INSERT INTO sessions (id, name, type, task_id, workspace_id, executor, model, approval_mode, thinking_effort, turns, active_channel, status, archived, worktree_path, branch, base_branch, worktree_outcome, native_session_id, runtime_mode, created_at, updated_at)
         VALUES (@id, @name, @type, @task_id, @workspace_id, @executor, @model, @approval_mode, @thinking_effort, 1, 'web', 'new', 0, @worktree_path, @branch, @base_branch, NULL, @native_session_id, 'structured', @now, @now)`,
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
        thinking_effort: effectiveEffort,
        worktree_path: worktreePath,
        branch,
        base_branch: baseBranch,
        native_session_id: proxyResult.nativeSessionId,
        now,
      });

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
      .get(taskId) as Session | undefined;
    return row ?? null;
  }

  /**
   * Get-or-create the per-Task Manager session (PRD-v3 P3). The Manager is a
   * `type='manager'` Codex session bound to the hidden root workspace
   * (`workspace_root`), running `gpt-5.5` / `xhigh`, with NO worktree and
   * persistent across turns. Read-only is enforced per-turn in `sendMessage`
   * (type==='manager' → sandbox:'read-only' + approvalPolicy:'never'), NOT
   * here and NOT via the system prompt.
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

    // Reuse the standard create path so the Manager gets the same proxy
    // bring-up + native-session capture as any other session. `approval_mode`
    // is irrelevant for the Manager (read-only is forced per-turn) but the
    // column is NOT NULL, so set a benign value. No worktree.
    return this.createSession({
      workspace_id: root.id,
      executor: MANAGER_EXECUTOR,
      name: `Manager · ${task.name}`,
      model: MANAGER_MODEL,
      thinking_effort: MANAGER_EFFORT,
      approval_mode: 'plan',
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

    // Prepend the system prompt only on the Manager's very first turn. After
    // that the codex thread retains context, so later messages go through bare.
    const isFirstTurn = this.persistedTurnCount(manager.id) === 0;
    // Wrap the system prompt in sentinels so the web can hide it from the
    // transcript while codex still receives it (codex-proxy has no system
    // channel). See stripManagerSystemPrefix in @gian/shared.
    const payload = isFirstTurn
      ? `${MANAGER_SYS_OPEN}\n${this.buildManagerPrompt(taskId)}\n${MANAGER_SYS_CLOSE}\n\n${text}`
      : text;

    await this.sendMessage(manager.id, payload);
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

    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) {
      throw new Error(`workspace missing for session ${session.id}`);
    }

    const result = await this.bringUpProxySession({
      sessionId: session.id,
      executor: session.executor,
      cwd: session.worktree_path ?? workspace.path,
      model: session.model,
      nativeSessionId: session.native_session_id,
      displayName: session.name,
    });
    return result.proxySessionId;
  }

  /**
   * Spin up (or attach to) the proxy client for a session and call
   * session.create on it. Returns both the proxy-side session id (used as
   * sessionId in subsequent RPC calls) and the native session id (cc
   * claudeSessionId or codex threadId — the JSONL on disk is the source of
   * truth, this id is what host stores in `sessions.native_session_id`).
   *
   * If `nativeSessionId` is provided the proxy treats it as an adoption /
   * resume — cc uses `--resume <id>`, codex calls `thread/resume <id>`,
   * and the existing on-disk session is reused. Otherwise the proxy
   * generates a fresh native id and we capture it for storage.
   */
  private async bringUpProxySession(args: {
    sessionId: string;
    executor: Executor;
    cwd: string;
    model: string | null;
    nativeSessionId?: string | null;
    /** SESSION-NAME-001: Gian session name to stamp onto the native session at
     *  bring-up. codex applies it via `thread/name/set` (covers create-with-name
     *  and idle-rename-then-next-bringup). claude ignores it here — its name is
     *  set via `--name` on the first turn / TTY spawn. */
    displayName?: string | null;
  }): Promise<{ proxySessionId: string; nativeSessionId: string }> {
    const client = await this.proxy.getOrCreate(args.sessionId, args.executor);
    client.onNotification(notification => this.handleNotification(args.sessionId, notification));
    // If the proxy dies mid-turn (cc-proxy crash, codex host exit, …) the
    // SessionManager would otherwise keep the turn in `running` forever — the
    // user sees a perpetual spinner. Fail the active turn so the UI resolves.
    client.onExit(code => this.handleProxyExit(args.sessionId, code));

    await client.initialize();
    const caps = await client.capabilities();
    this.capsByExecutor.set(args.executor, caps);

    const adoptParams: { claudeSessionId?: string; threadId?: string } = {};
    if (args.nativeSessionId) {
      if (args.executor === 'claude') adoptParams.claudeSessionId = args.nativeSessionId;
      else if (args.executor === 'codex') adoptParams.threadId = args.nativeSessionId;
    }

    // PR2: proxies are stateless across restarts (no state.json). Adoption is
    // expressed via `claudeSessionId` / `threadId` — the proxy resumes the
    // on-disk native session. There's no SESSION_ALREADY_EXISTS recovery path
    // anymore.
    let created: { session: import('@gian/shared').ProxySession; nativeSessionId: string };
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
      if (!isMissing || turnCount > 0) throw err;

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

    // Live Sync v2: start watching the on-disk JSONL so external `claude
    // --resume` / `codex resume` appends sync into events + WS.
    if (this.watcher) {
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
    };
  }

  async stopTurn(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    // Claude TTY: the turn runs inside the PTY, so the structured
    // interruptTurn won't reach it. Inject Esc instead. (codex TTY keeps the
    // existing path for now — out of scope for this line.)
    if (session.runtime_mode === 'tty' && session.executor === 'claude') {
      this.jobs.delete(sessionId);
      await this.ttyMgr?.interrupt(sessionId);
      // TTY turns run inside the PTY: they aren't tracked in `activeTurns`, the
      // Esc interrupt emits no turn.completed, and the JSONL watcher marks no
      // boundary for an aborted turn. The web spinner is driven by `pending`
      // (set optimistically on beta-send + from turn_started/completed
      // envelopes), so without an explicit signal it stays stuck "running".
      // Settle the session status — `session:updated{status:done}` is what the
      // web uses to clear pending (mirrors the structured path + force-recover).
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE sessions SET status = 'done', updated_at = ? WHERE id = ? AND status != 'done'`)
        .run(now, sessionId);
      this.broadcastSessionUpdated(sessionId, { status: 'done', updated_at: now });
      return;
    }
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
    // codex-proxy (or cc-proxy) memory, orphaned from any host state.
    // stop() also persists runtime_mode back to 'structured' so the next
    // session open lands the user in Chat instead of a dead xterm.
    let session: Session | null = null;
    try { session = this.getSession(sessionId); } catch { /* row gone */ }
    if (session?.runtime_mode === 'tty') {
      try {
        if (session.executor === 'codex') await this.codexTtyMgr?.stop(session);
        else if (session.executor === 'claude') await this.ttyMgr?.stop(session);
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
   * Preconditions:
   *   - session exists, executor is `claude` OR `codex`
   *   - the per-executor TTY manager is wired
   *   - no active turn, no pending approval
   *   - worktree not finalized (merged/discarded)
   *
   * On success the underlying native session uuid is preserved (Claude:
   * `--session-id` first / `--resume` after; Codex: `codex resume <uuid>`
   * against the same threadId that codex-proxy's `thread/start` minted),
   * so conversation history survives the toggle in either direction.
   */
  async switchRuntime(
    sessionId: string,
    target: RuntimeMode,
    opts: { remoteControl?: boolean } = {},
  ): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.executor !== 'claude' && session.executor !== 'codex') {
      throw Object.assign(
        new Error(`runtime switch is not available for executor "${session.executor}"`),
        { code: 'SWITCH_BLOCKED' },
      );
    }
    if (session.executor === 'claude' && !this.ttyMgr) {
      throw Object.assign(new Error('claude TTY runtime not configured'), { code: 'SWITCH_BLOCKED' });
    }
    if (session.executor === 'codex' && !this.codexTtyMgr) {
      throw Object.assign(new Error('codex TTY runtime not configured'), { code: 'SWITCH_BLOCKED' });
    }
    if (session.runtime_mode === target) {
      // No-op; do not error — the toggle button may double-fire.
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

    // Ensure the per-executor proxy client is alive — both TTY managers
    // talk through it. For codex, this is also where `native_session_id`
    // gets minted (via `thread/start` inside `bringUpProxySession`) on
    // sessions that have never run a CHAT turn. Side effect: the in-memory
    // `session` variable above is now stale w.r.t. native_session_id.
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
      if (fresh.executor === 'claude') {
        // `remote_control` from the WS message becomes a `--remote-control`
        // CLI flag. Codex has no equivalent so we silently drop the bit
        // for codex sessions.
        const extraArgs = opts.remoteControl ? ['--remote-control'] : undefined;
        const { permissionMode } = proxyTurnParamsFor(fresh.executor, fresh.approval_mode);
        await this.ttyMgr!.start(fresh, cwd, {
          cols: 120,
          rows: 30,
          ...(permissionMode ? { permissionMode } : {}),
          ...(extraArgs ? { extraArgs } : {}),
        });
      } else {
        await this.codexTtyMgr!.start(fresh, cwd, { cols: 120, rows: 30 });
      }
    } else {
      if (session.executor === 'claude') {
        await this.ttyMgr!.stop(session);
      } else {
        await this.codexTtyMgr!.stop(session);
      }
    }
  }

  async respondApproval(
    sessionId: string,
    approvalId: string,
    decision: import('@gian/shared').ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ): Promise<void> {
    const proxySessionId = this.proxySessionIds.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);

    // Snapshot the pending record before resolving so we can inspect category
    // for plan-mode-exit ceremony below.
    const pending = this.approvals.getPending(approvalId);

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
    // Manager is WRITABLE (spec 2026-06-28 §A1, supersedes PRD-v3 §A1's
    // read-only Manager). A type='manager' session is the per-Task Codex
    // orchestrator: it may read/write/run within the root workspace (`~/Coding`,
    // spanning all projects) but does NOT do the coding work itself — it
    // proposes Subtasks via a confirm-gated `create_subtask` block. EVERY turn
    // is forced to codex sandbox:'workspace-write' + approvalPolicy:'never'
    // (regardless of approval_mode / one-shot bypass): `never` because the
    // Manager panel has no approval-card UI. Risk: writable at the root spans
    // every project under `~/Coding`.
    const policyParams = session.type === 'manager'
      ? {
          sandbox: 'workspace-write' as const,
          approvalPolicy: 'never' as const,
        }
      : oneShotBypass
      ? (session.executor === 'claude'
        ? { permissionMode: 'bypassPermissions' as const }
        : {
            sandbox: 'danger-full-access' as const,
            approvalPolicy: 'never' as const,
            approvalsReviewer: 'auto_review' as const,
          })
      : proxyTurnParamsFor(session.executor, session.approval_mode);
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
        ...(session.model ? { model: session.model } : {}),
        ...(session.thinking_effort ? { thinking: session.thinking_effort } : {}),
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

  renameSession(sessionId: string, name: string): void {
    const trimmed = name.trim();
    const stored = trimmed.length > 0 ? trimmed : null;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`)
      .run(stored, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { name: stored, updated_at: now });

    // SESSION-NAME-001: propagate the new name down to the underlying native
    // session so it's distinguishable in Claude/Codex own listings (remote
    // control, `--resume`/`codex resume`). Best-effort + fire-and-forget — the
    // rename itself already succeeded above. We never clear a native name when
    // the Gian name is emptied (cleared name → no-op).
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

  enqueueMessage(sessionId: string, text: string): void {
    this.queue.add(sessionId, text);
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

  /**
   * Drain the next queued message into a live Claude TTY. Fired by the
   * TtyManager `Stop` hook — one entry per completed turn, mirroring the
   * structured `maybeAutoSendNext`. Pastes via the TTY input path; no-op when
   * the session left TTY mode (queue is preserved for when it flips back) or
   * the queue is empty.
   */
  drainTtyQueue(sessionId: string): void {
    let session: Session;
    try { session = this.getSession(sessionId); } catch { return; }
    if (session.runtime_mode !== 'tty' || session.executor !== 'claude') return;
    const next = this.queue.popNext(sessionId);
    if (!next) return;
    this.broadcastQueueUpdated(sessionId);
    void this.ttyMgr?.input(sessionId, { text: next.text });
  }

  async sendQueuedNow(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.runtime_mode === 'tty') {
      // codex TTY drain isn't wired — preserve the queue head and reject so
      // the existing CODEX-TTY-001 contract holds. Only claude TTY drains.
      if (session.executor !== 'claude') {
        throw new Error(`session is in CLI mode; switch to Chat before draining the queue`);
      }
      // (d) Claude TTY send_now: paste the head into the PTY immediately. If a
      // turn is still running, Claude's TUI takes it as a supplementary
      // message — we deliberately do NOT wait for the Stop hook (auto-drain).
      const ttyNext = this.queue.popNext(sessionId);
      if (!ttyNext) return;
      this.broadcastQueueUpdated(sessionId);
      await this.ttyMgr?.input(sessionId, { text: ttyNext.text });
      return;
    }
    // Pop only the head entry. Awaiting sendMessage just unblocks the proxy's
    // startTurn (the turn itself is async); kicking off the next entry from
    // here would race with turn 1 still running and trip SESSION_BUSY,
    // burning the queued text. Let `maybeAutoSendNext` walk the rest of the
    // queue on every turn.completed/failed instead — it's already wired.
    const next = this.queue.popNext(sessionId);
    if (!next) return;
    this.broadcastQueueUpdated(sessionId);
    await this.sendMessage(sessionId, next.text);
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
      .get(id) as Session | undefined;
    if (!row) throw new Error(`session not found: ${id}`);
    return row;
  }

  listSessions(opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Session[] {
    let where = 'archived = 0';
    if (opts.archivedOnly) where = 'archived = 1';
    else if (opts.includeArchived) where = '1=1';
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY updated_at DESC`)
      .all() as Session[];
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
    // removed worktree. cc-proxy is per-session so the PTY dies when
    // the subprocess does, but a structured closeSession alone doesn't
    // trigger that — we want the leak closed promptly on both
    // executors. The per-executor `stop()` methods are no-ops when
    // there is no live PTY, so this is safe to call unconditionally
    // for runtime_mode='tty' sessions.
    let session: Session | null = null;
    try { session = this.getSession(sessionId); } catch { /* row may already be gone */ }
    if (session?.runtime_mode === 'tty') {
      try {
        if (session.executor === 'codex') await this.codexTtyMgr?.stop(session);
        else if (session.executor === 'claude') await this.ttyMgr?.stop(session);
      } catch { /* best-effort cleanup */ }
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

    // TTY runtime notifications get re-broadcast as binary-ish ws messages
    // (`pty:output`) instead of structured transcript events. Hand them
    // straight to TtyManager and stop — running them through the
    // structured normalizer would either drop them silently or, worse,
    // synthesize bogus turn events that confuse the UI.
    if (
      notification.method === 'tty.output' ||
      notification.method === 'tty.exited'
    ) {
      // Dispatch by executor: claude TtyManager reads `params.sessionId`
      // as the gianSessionId (cc-proxy is per-session), codex
      // CodexTtyManager reads `params.gianSessionId` separately (codex-proxy
      // is shared and uses `sessionId` as the proxy-side routing key).
      // Routing the wrong notification to the wrong manager would either
      // drop it silently or broadcast with a stale session_id.
      let session: Session | null = null;
      try { session = this.getSession(sessionId); } catch { /* notification can outlive close */ }
      if (session?.executor === 'codex') {
        this.codexTtyMgr?.handleProxyNotification(notification as { method?: string; params?: unknown });
      } else {
        this.ttyMgr?.handleProxyNotification(notification as { method?: string; params?: unknown });
      }
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
    this.db
      .prepare(
        'UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(newNativeSessionId, now, gianSessionId);
    this.broadcastSessionUpdated(gianSessionId, {
      native_session_id: newNativeSessionId,
      updated_at: now,
    });

    // Live Sync v2: native id rotated → JSONL path changed. Stop the old
    // watcher and start a new one against the rotated file.
    if (this.watcher) {
      this.watcher.stop(gianSessionId);
      const session = this.getSession(gianSessionId);
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
      this.completeTurn(sessionId, 'completed');
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
    return session.executor === 'codex'
      ? normalizeCodexNotification(notification, sessionId, turn)
      : normalizeCcNotification(notification, sessionId, turn);
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
    void this.sendMessage(sessionId, next.text).catch(err => {
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

  private completeTurn(sessionId: string, status: 'completed' | 'error' | 'stopped'): void {
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
