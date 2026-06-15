import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WSContext } from 'hono/ws';
import type { ApprovalMode, ProxyNotification, RemoteControlState, RuntimeMode, Session, SessionStatus, ServerToClientMessage, TtySurface } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { ProxyManager } from '../proxy/manager.js';
import { CcProxyClient } from '../proxy/cc-proxy-client.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { normalizeCcNotification } from '../event/normalize-cc.js';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
import { TtyHookRegistry } from './registry.js';

type ClaudePermissionMode = 'plan' | 'default' | 'auto' | 'bypassPermissions';

/**
 * Reverse of `proxyTurnParamsFor` (session/manager.ts): the interactive
 * `claude` reports its live `permission_mode` in every hook payload. Map the
 * three Gian-modeled values back so the UI reflects what the CLI is actually
 * doing after the user cycles modes inside the terminal. Claude's other native
 * modes (`acceptEdits`, `bypassPermissions`) have no Gian `ApprovalMode`
 * equivalent — return null and leave the stored mode untouched rather than
 * show something wrong.
 */
export function ccPermissionModeToApprovalMode(permissionMode: string): ApprovalMode | null {
  switch (permissionMode) {
    case 'plan': return 'plan';
    case 'default': return 'ask';
    case 'auto': return 'auto';
    default: return null;
  }
}

/** Pull the most recent model id out of a Claude JSONL transcript. Verbatim —
 *  whatever the CLI wrote (`claude-opus-4-7`, `claude-opus-4-7[1m]`, …). The
 *  `system`/`init` line and every `assistant` message carry `model`; we scan
 *  from the end so a mid-session `/model` change wins. Returns null on any
 *  read/parse trouble — the caller just keeps the prior value. */
export function readLatestModelFromCcJsonl(filePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const msg = parsed.message as { model?: unknown } | undefined;
    if (msg && typeof msg.model === 'string' && msg.model) return msg.model;
    if (typeof parsed.model === 'string' && parsed.model) return parsed.model;
  }
  return null;
}

interface TtyLock {
  clientId: string;
  ws: WSContext;
  surface: TtySurface;
  acquiredAt: number;
}

/**
 * Coordinator for the TTY runtime mode on the cc executor.
 *
 * Responsibilities:
 *   - Mint hook tokens and assemble the per-spawn settings.json content
 *     that gets passed to cc-proxy's `tty.start`.
 *   - Tell cc-proxy to start / stop the PTY.
 *   - Fan PTY output (delivered as `tty.output` notifications) out to
 *     subscribed WebSocket clients.
 *   - Persist `sessions.runtime_mode` on every successful switch.
 *
 * Codex TTY mode (planned, separate runtime) is not handled here — the
 * Claude path is the one with first-class hook support, so it ships first.
 */
export class TtyManager {
  readonly registry = new TtyHookRegistry();
  private readonly locks = new Map<string, TtyLock>();
  /** Per-session set of approvalIds we've broadcast as `pending` via
   *  PreToolUse(AskUserQuestion). Used to fire synthetic `approval_resolved`
   *  events on PTY exit / runtime flip so question cards don't strand. */
  private readonly pendingQuestions = new Map<string, Set<string>>();
  /** Per-session Claude Remote Control state, parsed from the PTY status line.
   *  Drives the composer's remote-control toggle. Cleared on PTY exit. */
  private readonly remoteControl = new Map<string, RemoteControlState>();
  /** Rolling, ANSI-stripped tail of recent PTY output per session, so the
   *  Remote Control status line is detectable even when split across chunks. */
  private readonly rcBuf = new Map<string, string>();
  /** Fired when a TTY turn ends (`Stop` hook). The host wires this to the
   *  queue drain so Beta walks its queue one entry per completed turn. */
  private onTtyTurnComplete: ((sessionId: string) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly proxy: ProxyManager,
    private readonly broadcaster: WsBroadcaster,
    /** Public URL the in-PTY claude reaches the host on. Per docs
     *  (`docs/runtime-modes/findings.md`) we lock hooks to 127.0.0.1 via
     *  `allowedHttpHookUrls`. */
    private readonly hookBaseUrl: string,
  ) {}

  /** Wire the host's per-turn queue drain. Set once at startup (app.ts). */
  setTurnCompleteHandler(fn: (sessionId: string) => void): void {
    this.onTtyTurnComplete = fn;
  }

  claim(
    sessionId: string,
    clientId: string,
    ws: WSContext,
    surface: TtySurface,
    opts: { takeover?: boolean } = {},
  ): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.clientId !== clientId) {
      if (!opts.takeover) {
        this.broadcaster.send(ws, {
          type: 'tty:lock',
          session_id: sessionId,
          locked: true,
          owner: false,
          surface: existing.surface,
          reason: 'Claude CLI is already open in another window.',
        });
        return false;
      }
      this.broadcaster.send(existing.ws, {
        type: 'tty:lock',
        session_id: sessionId,
        locked: true,
        owner: false,
        surface: existing.surface,
        reason: 'Claude CLI was taken over by another window.',
      });
    }
    this.locks.set(sessionId, {
      clientId,
      ws,
      surface,
      acquiredAt: Date.now(),
    });
    this.broadcaster.send(ws, {
      type: 'tty:lock',
      session_id: sessionId,
      locked: true,
      owner: true,
      surface,
    });
    return true;
  }

  owns(sessionId: string, clientId: string): boolean {
    return this.locks.get(sessionId)?.clientId === clientId;
  }

  isLockedByOther(sessionId: string, clientId: string): boolean {
    const lock = this.locks.get(sessionId);
    return !!lock && lock.clientId !== clientId;
  }

  release(sessionId: string, clientId?: string): void {
    const lock = this.locks.get(sessionId);
    if (!lock) return;
    if (clientId && lock.clientId !== clientId) return;
    this.locks.delete(sessionId);
  }

  releaseClient(clientId: string): void {
    for (const [sessionId, lock] of this.locks) {
      if (lock.clientId === clientId) this.locks.delete(sessionId);
    }
  }

  /**
   * Bring the TTY runtime up for a session. Caller must have verified
   * idle preconditions (no active turn, no pending approval).
   *
   * Returns the replay buffer so the client can prime xterm with the
   * boot output of the freshly-spawned `claude`.
   */
  async start(
    session: Session,
    cwd: string,
    opts: { cols: number; rows: number; permissionMode?: ClaudePermissionMode; extraArgs?: string[] },
  ): Promise<{ replay: string[]; alive: boolean }> {
    if (session.executor !== 'claude') {
      throw new Error(`TTY mode is only available for claude sessions (got ${session.executor})`);
    }
    if (!session.native_session_id) {
      throw new Error(`session ${session.id} has no native_session_id — bring the proxy session up first`);
    }
    const client = this.proxy.get(session.id);
    if (!(client instanceof CcProxyClient)) {
      throw new Error(`no cc-proxy client for session ${session.id} — bring the session up first`);
    }

    const credentials = this.registry.issue(session.id);
    const hookSettings = this.buildSettings(session.id, credentials.token);

    // SESSION-NAME-001: stamp the Gian name onto the interactive Claude session
    // via `--name` so it shows in `claude --resume` / Remote Control listings.
    // Read fresh on every spawn (no revert vs. a direct-write rename).
    // eslint-disable-next-line no-control-regex
    const displayName = (session.name ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 200);
    const extraArgs = [
      ...(opts.extraArgs ?? []),
      ...(displayName ? ['--name', displayName] : []),
    ];

    const result = await client.ttyStart({
      sessionId: session.id,
      claudeSessionId: session.native_session_id,
      cwd,
      isResume: this.hasPersistedTurns(session.id),
      cols: opts.cols,
      rows: opts.rows,
      model: session.model,
      effort: session.thinking_effort,
      hookSettings,
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
    });

    this.persistMode(session.id, 'tty');
    // Proactively seed the displayed model from the on-disk JSONL instead of
    // waiting for the first turn's events. A resumed session already has prior
    // assistant lines carrying the real (CLI-resolved) model id; a brand-new
    // one won't yet, and gets picked up on the first Stop hook (handleHook).
    this.syncModelFromJsonl(session.id, cwd);
    return { replay: result.replay, alive: result.alive };
  }

  /** Tear the PTY down and revoke hook credentials. Safe to call when
   *  the session is already in structured mode (no-op for the PTY). */
  async stop(session: Session): Promise<void> {
    const client = this.proxy.get(session.id);
    if (client instanceof CcProxyClient) {
      try { await client.ttyKill(session.id); } catch { /* proxy may have exited */ }
    }
    this.registry.revoke(session.id);
    this.release(session.id);
    this.clearPendingQuestions(session.id);
    this.persistMode(session.id, 'structured');
  }

  /** Forward a raw byte chunk (base64) from the WS client to the PTY. */
  async input(sessionId: string, payload: { data?: string; text?: string }): Promise<void> {
    const client = this.proxy.get(sessionId);
    if (!(client instanceof CcProxyClient)) return;
    await client.ttyInput({ sessionId, ...payload });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const client = this.proxy.get(sessionId);
    if (!(client instanceof CcProxyClient)) return;
    await client.ttyResize({ sessionId, cols, rows });
  }

  /** Snapshot the ring buffer — called by the WS replay-request handler. */
  async replay(sessionId: string): Promise<{ chunks: string[]; alive: boolean }> {
    const client = this.proxy.get(sessionId);
    if (!(client instanceof CcProxyClient)) return { chunks: [], alive: false };
    return client.ttyReplay(sessionId);
  }

  /** Route a verified hook payload to broadcasters and keep the session row
   *  status in sync with the interactive Claude lifecycle. Transcript data is
   *  owned by the native JSONL watcher; writing prompt/final text here would
   *  duplicate the same turn in Beta. */
  async handleHook(sessionId: string, event: string, body: unknown): Promise<{ status: number; payload?: unknown }> {
    // Best-effort summarization for the log; full payload preserved in
    // memory only since hooks can be large (Stop carries
    // `last_assistant_message`).
    const summary = typeof body === 'object' && body !== null
      ? Object.keys(body as Record<string, unknown>).join(',')
      : typeof body;
    console.log(`[tty:hook] sess=${sessionId} event=${event} keys=${summary}`);

    if (event === 'UserPromptSubmit') {
      this.persistStatus(sessionId, 'running');
    } else if (event === 'Stop' || event === 'SessionEnd') {
      this.persistStatus(sessionId, 'done');
    } else if (event === 'StopFailure') {
      this.persistStatus(sessionId, 'error');
    } else if (event === 'PreToolUse') {
      this.surfaceInteractiveQuestion(sessionId, body);
    } else if (event === 'PostToolUse') {
      // The question was answered (the tool ran), so it's no longer pending —
      // drop it before any later SessionEnd/exit/stop would auto-decline it.
      this.removePendingQuestion(sessionId, body);
    }

    // Every hook carries the CLI's live `permission_mode` (and most carry
    // `effort`). Sync them so the UI tracks mode/effort the user changed
    // inside the terminal (slash / shift+tab), not the stale spawn-time value.
    this.syncControlsFromHook(sessionId, body);
    // Turn just ended → the JSONL now holds the latest assistant line; refresh
    // the model. Covers a brand-new session (no model at spawn) and a
    // mid-session `/model` switch.
    if (event === 'Stop') this.syncModelFromJsonl(sessionId);
    // Turn ended → let the host drain the next queued Beta message (if any).
    if (event === 'Stop') this.onTtyTurnComplete?.(sessionId);

    // Surface every hook as a generic event the frontend can show in a
    // future debug panel. Status-pill mapping is done client-side based
    // on event name so we don't need to enumerate every flavor here.
    this.broadcaster.broadcast({
      type: 'event',
      session_id: sessionId,
      turn: 0,
      call_id: `tty-hook-${Date.now()}`,
      event: `tty.hook.${event.toLowerCase()}`,
      ts: Date.now(),
      data: (typeof body === 'object' && body !== null) ? (body as Record<string, unknown>) : { raw: body },
    });

    // SessionEnd → drop our local mapping so the next mode flip
    // re-mints credentials. The PTY exit notification from cc-proxy
    // will handle DB updates separately. Any unanswered question card
    // belongs to a dead PTY — decline it so the UI moves on.
    if (event === 'SessionEnd') {
      this.registry.revoke(sessionId);
      this.release(sessionId);
      this.clearPendingQuestions(sessionId);
    }

    return { status: 200 };
  }

  // ---------------------------------------------------------------------------
  // Notification routing — wired by the host once at startup. cc-proxy
  // emits `tty.output` / `tty.exited` notifications; we re-broadcast as
  // `pty:output` / state changes.
  // ---------------------------------------------------------------------------

  handleProxyNotification(notification: { method?: string; params?: unknown }): void {
    if (!notification.method) return;
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    if (!sessionId) return;
    if (notification.method === 'tty.output') {
      const data = typeof params.data === 'string' ? params.data : '';
      this.sendToOwner(sessionId, {
        type: 'pty:output',
        session_id: sessionId,
        data,
      });
      // PTY output is base64 in `params.data`; decode to scan for status lines
      // Claude prints. `sendToOwner` forwards the base64 verbatim to xterm, so
      // decoding here is only for our own parsing.
      const decoded = Buffer.from(data, 'base64').toString('utf8');
      this.detectRemoteControl(sessionId, decoded);
      this.detectInterrupted(sessionId, decoded);
    } else if (notification.method === 'tty.exited') {
      // The PTY-side AskUserQuestion selectors are gone with the process —
      // there's no way left to answer them. Decline any cards still in
      // `pending` before broadcasting the exit so the UI doesn't strand them.
      this.clearPendingQuestions(sessionId);
      // Remote Control dies with the PTY — reset the toggle.
      this.rcBuf.delete(sessionId);
      if (this.remoteControl.delete(sessionId)) {
        this.broadcaster.broadcast({ type: 'tty:remote-control', session_id: sessionId, state: 'disconnected' });
      }
      this.broadcaster.broadcast({
        type: 'event',
        session_id: sessionId,
        turn: 0,
        call_id: `tty-exited-${Date.now()}`,
        event: 'tty.exited',
        ts: Date.now(),
        data: {
          code: params.code ?? null,
          signal: params.signal ?? null,
        },
      });
    }
  }

  /**
   * Toggle Claude Code Remote Control on a live TTY session by injecting the
   * `/remote-control` slash command as raw keystrokes (host-trusted — no
   * web-owner check). No-op when there's no PTY for the session. The resulting
   * connection state comes back asynchronously via the PTY status line, parsed
   * in `detectRemoteControl` and broadcast as `tty:remote-control`.
   */
  async toggleRemoteControl(sessionId: string): Promise<void> {
    // `data` is base64-decoded verbatim into the PTY; encode the keystrokes.
    const keystrokes = Buffer.from('/remote-control\r', 'utf8').toString('base64');
    await this.input(sessionId, { data: keystrokes });
  }

  /**
   * Interrupt the running turn in a live TTY session by injecting Esc — the
   * key Claude Code's TUI uses to stop the current generation. No-op when
   * there's no PTY for the session. Unlike the structured `interruptTurn`,
   * this actually reaches the interactive `claude` running in the PTY.
   *
   * NOTE: single Esc is the first cut; whether Claude needs double-Esc /
   * Ctrl-C is a line-A spike item (see spec §7.3). Keep the byte here in one
   * place so that tweak is one line.
   */
  async interrupt(sessionId: string): Promise<void> {
    const esc = Buffer.from('\x1b', 'utf8').toString('base64');
    await this.input(sessionId, { data: esc });
    // After Esc, Claude's TUI leaves the interrupted prompt sitting in the
    // input box — the next Beta message would then be appended to it. Wait for
    // the interrupt to settle, then clear the line (Ctrl+U = readline kill-line;
    // no exit risk, unlike Ctrl+C) so the box starts blank.
    setTimeout(() => {
      const clearLine = Buffer.from('\x15', 'utf8').toString('base64');
      void this.input(sessionId, { data: clearLine }).catch(() => {});
    }, 500);
  }

  /** Current Remote Control state for a session (undefined = never observed). */
  remoteControlState(sessionId: string): RemoteControlState | undefined {
    return this.remoteControl.get(sessionId);
  }

  /**
   * Scan decoded PTY output for Claude's Remote Control status line and, when it
   * changes, broadcast `tty:remote-control`. Takes the last-appearing status in
   * the chunk so a single redraw carrying a stale + fresh line resolves to the
   * newer state.
   */
  /**
   * Catch a turn that was interrupted directly in the CLI (the user pressed
   * Ctrl+C / Esc in the terminal, not the chat Stop button). Claude's TUI
   * prints "Interrupted · What should Claude do instead?" — when we see it on a
   * session whose row still says `running`, settle it to `done` so the Beta
   * chat spinner clears. The Stop hook covers clean completion / tool aborts;
   * this covers generation aborts where the hook may not fire. Guarded on the
   * current status so it only broadcasts once per interrupt.
   */
  private detectInterrupted(sessionId: string, chunk: string): void {
    // Match the prompt Claude prints after an interrupt. We key on "What should
    // Claude do instead" rather than the word "Interrupted" because the latter
    // is split by a cursor-move escape in the TUI redraw ("Int\x1b[10Grrupted")
    // while this phrase lands contiguously.
    if (!chunk.includes('What should Claude do instead')) return;
    const row = this.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string } | undefined;
    if (row?.status !== 'running') return;
    if (process.env.GIAN_RC_DEBUG) console.error('[interrupt-debug] → done', sessionId);
    this.persistStatus(sessionId, 'done');
  }

  private detectRemoteControl(sessionId: string, chunk: string): void {
    // Claude's TUI paints the status line as part of a redraw: the phrase can
    // be split across PTY chunks and wrapped in ANSI escape sequences. Strip
    // the escapes and scan a rolling per-session tail so a contiguous match is
    // possible regardless of how the bytes were chunked.
    const cleaned = chunk
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences (colors, cursor moves)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (titles)
      .replace(/[\r\b]/g, '');
    const text = ((this.rcBuf.get(sessionId) ?? '') + cleaned).slice(-4000);
    this.rcBuf.set(sessionId, text);

    if (process.env.GIAN_RC_DEBUG && /remote.?control/i.test(chunk)) {
      // Temporary: surface what the PTY actually emits so detection can be tuned.
      console.error('[rc-debug]', sessionId, JSON.stringify(chunk.slice(0, 400)));
    }

    // Claude's actual status-line wording (verified from live PTY output):
    //   connecting → "Remote Control connecting…"
    //   connected  → "Remote Control active"   (NOT "connected")
    //   off        → "Remote Control disconnected" (best-known; also clears)
    const find = (...needles: string[]) => Math.max(...needles.map(n => text.lastIndexOf(n)));
    const at: Record<RemoteControlState, number> = {
      connecting: find('Remote Control connecting'),
      connected: find('Remote Control active', 'Remote Control connected'),
      disconnected: find('Remote Control disconnected', 'Remote Control off'),
    };
    let next: RemoteControlState | null = null;
    let best = -1;
    for (const state of ['connecting', 'connected', 'disconnected'] as RemoteControlState[]) {
      if (at[state] > best) { best = at[state]; next = state; }
    }
    if (best < 0 || !next) return;
    if (this.remoteControl.get(sessionId) === next) return;
    this.remoteControl.set(sessionId, next);
    if (process.env.GIAN_RC_DEBUG) console.error('[rc-debug] →', sessionId, next);
    this.broadcaster.broadcast({ type: 'tty:remote-control', session_id: sessionId, state: next });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Bridge the interactive `AskUserQuestion` selector into a structured Beta
   * question card.
   *
   * In TTY mode the selector renders *inside the PTY* and blocks waiting for a
   * keystroke; crucially, claude does not flush the `tool_use` to the session
   * JSONL until the question is answered. That makes the JSONL watcher — the
   * only other channel — unable to ever see a pending question, so the card
   * never appears and the turn deadlocks. `PreToolUse` fires *before* the tool
   * runs and carries the questions struct, so we feed it through the exact same
   * `approval.requested` normalization the structured/MCP bridge uses. The Beta
   * card and the web answer-routing path (`planApprovalResponseDispatch`) then
   * work unchanged.
   *
   * We deliberately do not return a hook decision: claude still renders its own
   * selector in the (hidden) terminal, and the user's pick is pasted back into
   * the PTY — which resolves it. Only `question`-flavored approvals are
   * surfaced; ordinary tool permissions stay in the terminal where TTY mode
   * already handles them.
   */
  private surfaceInteractiveQuestion(sessionId: string, body: unknown): void {
    if (typeof body !== 'object' || body === null) return;
    const b = body as Record<string, unknown>;
    const toolName = typeof b.tool_name === 'string' ? b.tool_name : '';
    const approvalId = typeof b.tool_use_id === 'string' && b.tool_use_id
      ? b.tool_use_id
      : randomUUID();
    const raw: ProxyNotification = {
      method: 'approval.requested',
      params: {
        sessionId,
        data: { approvalId, toolName, inputPreview: JSON.stringify(b.tool_input ?? {}) },
      },
    } as ProxyNotification;
    for (const ev of normalizeCcNotification(raw, sessionId, 0)) {
      const data = ev.data as unknown as Record<string, unknown>;
      if (ev.type !== 'approval_requested' || data.category !== 'question') continue;
      const trackedId = typeof data.approvalId === 'string' ? data.approvalId : approvalId;
      let set = this.pendingQuestions.get(sessionId);
      if (!set) {
        set = new Set();
        this.pendingQuestions.set(sessionId, set);
      }
      set.add(trackedId);
      this.broadcaster.broadcast({
        type: 'event',
        session_id: ev.session_id,
        turn: ev.turn,
        call_id: ev.call_id,
        event: ev.type,
        ts: ev.ts,
        data,
      });
    }
  }

  /**
   * Drop a question from the pending set once it's been answered (PostToolUse).
   * `tool_use_id` is the same id `surfaceInteractiveQuestion` tracked, so the
   * later `clearPendingQuestions` won't auto-decline an already-answered card.
   */
  private removePendingQuestion(sessionId: string, body: unknown): void {
    if (typeof body !== 'object' || body === null) return;
    const id = (body as Record<string, unknown>).tool_use_id;
    if (typeof id !== 'string' || !id) return;
    const set = this.pendingQuestions.get(sessionId);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.pendingQuestions.delete(sessionId);
  }

  /**
   * Broadcast `approval_resolved` (decline) for every question card we'd
   * previously announced as pending for this session. Called when the PTY
   * exits, the session is torn down, or the runtime flips back to
   * structured — without this, Beta clients keep an interactive card on
   * screen that can never be answered (the PTY selector backing it is
   * gone). The frontend's apply reducer is idempotent on approvalId so a
   * later duplicate from another channel is harmless.
   */
  private clearPendingQuestions(sessionId: string): void {
    const ids = this.pendingQuestions.get(sessionId);
    if (!ids || ids.size === 0) {
      this.pendingQuestions.delete(sessionId);
      return;
    }
    for (const approvalId of ids) {
      this.broadcaster.broadcast({
        type: 'event',
        session_id: sessionId,
        turn: 0,
        call_id: approvalId,
        event: 'approval_resolved',
        ts: Date.now(),
        data: { approvalId, decision: 'decline', auto: true },
      });
    }
    this.pendingQuestions.delete(sessionId);
  }

  /**
   * Sync `approval_mode` / `thinking_effort` from a hook payload's live
   * `permission_mode` / `effort` fields. Only writes (and broadcasts) when a
   * value actually changed, so this is cheap to call on every hook. Claude
   * modes with no Gian equivalent leave the stored mode untouched.
   */
  private syncControlsFromHook(sessionId: string, body: unknown): void {
    if (typeof body !== 'object' || body === null) return;
    const b = body as Record<string, unknown>;
    const updates: Partial<Pick<Session, 'approval_mode' | 'thinking_effort'>> = {};

    if (typeof b.permission_mode === 'string') {
      const mode = ccPermissionModeToApprovalMode(b.permission_mode);
      if (mode) updates.approval_mode = mode;
    }
    if (typeof b.effort === 'string' && b.effort) {
      updates.thinking_effort = b.effort;
    }
    if (Object.keys(updates).length === 0) return;

    const row = this.db
      .prepare('SELECT approval_mode, thinking_effort FROM sessions WHERE id = ?')
      .get(sessionId) as Pick<Session, 'approval_mode' | 'thinking_effort'> | undefined;
    if (!row) return;

    const changed: Partial<Session> = {};
    if (updates.approval_mode != null && updates.approval_mode !== row.approval_mode) {
      changed.approval_mode = updates.approval_mode;
    }
    if (updates.thinking_effort != null && updates.thinking_effort !== row.thinking_effort) {
      changed.thinking_effort = updates.thinking_effort;
    }
    if (Object.keys(changed).length === 0) return;

    const now = new Date().toISOString();
    const sets = Object.keys(changed).map(k => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(changed), now, sessionId);
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, ...changed, updated_at: now },
    });
  }

  /**
   * Read the live model id from the session's Claude JSONL and store it
   * verbatim (no `[1m]`-stripping — the UI shows exactly what the CLI runs).
   * `cwd` is passed at spawn time; otherwise resolved from the worktree /
   * workspace. No-op when nothing changed or the file isn't readable yet.
   */
  private syncModelFromJsonl(sessionId: string, cwd?: string): void {
    const row = this.db
      .prepare('SELECT model, native_session_id, executor, worktree_path, workspace_id FROM sessions WHERE id = ?')
      .get(sessionId) as
        | Pick<Session, 'model' | 'native_session_id' | 'executor' | 'worktree_path' | 'workspace_id'>
        | undefined;
    if (!row || row.executor !== 'claude' || !row.native_session_id) return;

    let dir = cwd;
    if (!dir) {
      if (row.worktree_path) {
        dir = row.worktree_path;
      } else {
        const ws = this.db
          .prepare('SELECT path FROM workspaces WHERE id = ?')
          .get(row.workspace_id) as { path: string } | undefined;
        if (!ws) return;
        dir = ws.path;
      }
    }

    const filePath = locateNativeJsonl('claude', row.native_session_id, dir);
    if (!filePath) return;
    const model = readLatestModelFromCcJsonl(filePath);
    if (!model || model === row.model) return;

    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, now, sessionId);
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, model, updated_at: now },
    });
  }

  private persistMode(sessionId: string, mode: RuntimeMode): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET runtime_mode = ?, updated_at = ? WHERE id = ?')
      .run(mode, now, sessionId);
    this.broadcaster.broadcast({
      type: 'session:runtime-switched',
      session_id: sessionId,
      runtime_mode: mode,
    });
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, runtime_mode: mode, updated_at: now },
    });
  }

  private persistStatus(sessionId: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, sessionId);
    if (result.changes <= 0) return;
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, status, updated_at: now },
    });
  }

  private sendToOwner(sessionId: string, message: ServerToClientMessage): void {
    const lock = this.locks.get(sessionId);
    if (!lock) return;
    this.broadcaster.send(lock.ws, message);
  }

  private hasPersistedTurns(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM turns WHERE session_id = ?')
      .get(sessionId) as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  /**
   * Build the `settings.json` content claude reads on launch. URL is
   * locked to 127.0.0.1 via `allowedHttpHookUrls`. Token is in the
   * query string of every hook URL — the receiver pulls it out.
   *
   * Timeouts mirror Claude's docs: Stop / StopFailure get 30s (the
   * `last_assistant_message` payload can be sizeable); rest 10s.
   */
  private buildSettings(sessionId: string, token: string): Record<string, unknown> {
    const hookUrl = (event: string) =>
      `${this.hookBaseUrl}/internal/hooks/claude/${sessionId}/${event}?t=${token}`;
    const allowedHttpHookUrls = [`${this.hookBaseUrl}/*`];
    const mkHook = (event: string, timeout: number) => ({
      hooks: [{ type: 'http', url: hookUrl(event), timeout }],
    });
    return {
      allowedHttpHookUrls,
      hooks: {
        SessionStart: [mkHook('SessionStart', 10)],
        UserPromptSubmit: [mkHook('UserPromptSubmit', 10)],
        Stop: [mkHook('Stop', 30)],
        StopFailure: [mkHook('StopFailure', 30)],
        // AskUserQuestion renders a blocking selector inside the PTY and is not
        // written to JSONL until answered. PreToolUse fires first and carries
        // the questions struct, so it is the only channel that can surface the
        // Beta question card while the tool is still pending. Scoped to
        // AskUserQuestion — ordinary tool permissions stay in the terminal.
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: hookUrl('PreToolUse'), timeout: 10 }] },
        ],
        // PostToolUse(AskUserQuestion) fires once the user answered → clears the
        // pending id so a later SessionEnd/exit can't auto-decline an answered card.
        PostToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: hookUrl('PostToolUse'), timeout: 10 }] },
        ],
        Notification: [
          { matcher: '*', hooks: [{ type: 'http', url: hookUrl('Notification'), timeout: 10 }] },
        ],
        FileChanged: [mkHook('FileChanged', 10)],
        SessionEnd: [mkHook('SessionEnd', 10)],
      },
    };
  }
}
