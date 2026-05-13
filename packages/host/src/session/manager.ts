import type {
  ApprovalMode,
  EventEnvelope,
  Executor,
  ProxyNotification,
  Session,
  ThinkingEffort,
  UnifiedEvent,
  WorktreeOutcome,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ApprovalManager } from '../approval/index.js';
import type { QueueManager } from '../queue/index.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
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
  /** Override for worktree mode (defaults to gian/<short-id>). */
  branch?: string;
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

/**
 * Bridges WebSocket commands and the proxy layer. Persists sessions, turns,
 * events; subscribes to proxy notifications and broadcasts them to the web
 * client.
 *
 * M1 transition state — the notification pipeline runs the unified
 * normalizer first; if it returns events those are persisted + broadcast as
 * UnifiedEvents. Otherwise we fall back to the legacy raw passthrough so the
 * frontend keeps working until normalize-{cc,codex} cover every notification.
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
  ) {}

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
    // but until now nothing read them, so newly-created sessions always came
    // up on the proxy's hardcoded default. Empty strings in config mean "let
    // the proxy pick" → leave null so we don't override anything.
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
    const effectiveEffort: ThinkingEffort | null = defaultEffort
      ? (defaultEffort as ThinkingEffort)
      : null;

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseBranch: string | null = null;

    if (input.mode === 'worktree') {
      if (!isGitRepo(workspace.path)) {
        throw new Error(`workspace is not a git repo: ${workspace.path}`);
      }
      baseBranch = input.base_branch ?? detectDefaultBranch(workspace.path);
      branch = input.branch ?? `gian/${id.slice(0, 8)}`;
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
        `INSERT INTO sessions (id, name, type, workspace_id, executor, model, approval_mode, thinking_effort, turns, active_channel, status, archived, worktree_path, branch, base_branch, worktree_outcome, native_session_id, created_at, updated_at)
         VALUES (@id, @name, 'coding', @workspace_id, @executor, @model, @approval_mode, @thinking_effort, 1, 'web', 'new', 0, @worktree_path, @branch, @base_branch, NULL, @native_session_id, @now, @now)`,
      )
      .run({
        id,
        name: input.name ?? null,
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

    return this.getSession(id);
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

    return {
      proxySessionId: created.session.id,
      nativeSessionId: created.nativeSessionId,
    };
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

    this.persistEvent(sessionId, turnId, randomUUID(), 'user_message', { text });
    this.broadcastEvent(sessionId, turnNumber, randomUUID(), 'user_message', { text });

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
    const policyParams = oneShotBypass
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
        ...policyParams,
      });
    } catch (err) {
      // startTurn rejected (proxy busy, bad params, runtime crash). The host
      // already optimistically wrote turn=running / session=running and
      // paused the watcher above; roll all of that back so the UI doesn't
      // sit on a phantom spinner. The error then bubbles to ws-handler,
      // which forwards it as an `error` WS message.
      this.completeTurn(sessionId, 'error');
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
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`)
      .run(model, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { model, updated_at: now });
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
    // means the first probe failed (e.g. `claude` binary missing) — caching
    // it forever locks the UI into "no models" until process restart. Retry
    // on each call instead so a fix-up (PATH change, binary install) heals
    // itself without bouncing the host.
    //
    // Also drop the cached proxy when models came back empty so the next
    // attempt actually re-runs the probe inside a fresh runtime instance.
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

  async sendQueuedNow(sessionId: string): Promise<void> {
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
    this.broadcaster.broadcast({ type: 'session:deleted', session_id: sessionId });
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

    // Normalize/dispatch BEFORE handleLifecycle. handleLifecycle calls
    // completeTurn on turn.completed/failed, which deletes the activeTurns
    // map entry; if that runs first, dispatchUnified would persist the event
    // with a fresh random turn_id that doesn't exist in `turns` and trip the
    // FK constraint.
    const unified = this.runNormalizer(sessionId, notification);
    if (unified.length > 0) {
      for (const e of unified) this.dispatchUnified(e);
    } else {
      this.legacyRawDispatch(sessionId, notification);
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

  private legacyRawDispatch(sessionId: string, notification: ProxyNotification): void {
    const turnId = this.activeTurnId(sessionId);
    const turnNumber = this.activeTurns.get(sessionId)?.number ?? 0;
    const callId = randomUUID();
    const data = (notification.params?.data ?? {}) as Record<string, unknown>;

    if (notification.method !== 'debug') {
      this.persistEvent(sessionId, turnId, callId, notification.method, data);
    }
    this.broadcastEvent(sessionId, turnNumber, callId, notification.method, data);
  }

  private activeTurnId(sessionId: string): string {
    return this.activeTurns.get(sessionId)?.id ?? randomUUID();
  }

  private handleProxyExit(sessionId: string, code: number | null): void {
    // Pending approvals that were in flight against this proxy will never
    // resolve now — drop them so the UI's approval list stays accurate.
    this.approvals.clearSession(sessionId);
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    console.error(`[session] proxy exited mid-turn session=${sessionId} code=${code} turn=${active.id}`);
    this.completeTurn(sessionId, 'error');
    this.proxySessionIds.delete(sessionId);
    this.jobs.delete(sessionId);
    this.watcher?.resume(sessionId);
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
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(sessionStatus, now, sessionId);
    this.broadcastSessionUpdated(sessionId, { status: sessionStatus, updated_at: now });
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
}
