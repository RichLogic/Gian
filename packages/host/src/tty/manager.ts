import type { RuntimeMode, Session } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { ProxyManager } from '../proxy/manager.js';
import { CcProxyClient } from '../proxy/cc-proxy-client.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { TtyHookRegistry } from './registry.js';

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

  constructor(
    private readonly db: Db,
    private readonly proxy: ProxyManager,
    private readonly broadcaster: WsBroadcaster,
    /** Public URL the in-PTY claude reaches the host on. Per docs
     *  (`docs/runtime-modes/findings.md`) we lock hooks to 127.0.0.1 via
     *  `allowedHttpHookUrls`. */
    private readonly hookBaseUrl: string,
  ) {}

  /**
   * Bring the TTY runtime up for a session. Caller must have verified
   * idle preconditions (no active turn, no pending approval).
   *
   * Returns the replay buffer so the client can prime xterm with the
   * boot output of the freshly-spawned `claude`.
   */
  async start(session: Session, cwd: string, opts: { cols: number; rows: number }): Promise<{ replay: string[]; alive: boolean }> {
    if (session.executor !== 'claude') {
      throw new Error(`TTY mode is only available for claude sessions (got ${session.executor})`);
    }
    const client = this.proxy.get(session.id);
    if (!(client instanceof CcProxyClient)) {
      throw new Error(`no cc-proxy client for session ${session.id} — bring the session up first`);
    }

    const credentials = this.registry.issue(session.id);
    const hookSettings = this.buildSettings(session.id, credentials.token);

    const result = await client.ttyStart({
      sessionId: session.id,
      claudeSessionId: session.native_session_id ?? '',
      cwd,
      isResume: !!session.native_session_id,
      cols: opts.cols,
      rows: opts.rows,
      model: session.model,
      hookSettings,
    });

    this.persistMode(session.id, 'tty');
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

  /** Route a verified hook payload to broadcasters. v0: log + push a
   *  generic event so the UI can flash a status pill. The detailed
   *  per-event normalizer (UserPromptSubmit → turn.started, Stop →
   *  turn.completed, …) lands in a follow-up — kept simple here so the
   *  TTY backbone works end-to-end first. */
  async handleHook(sessionId: string, event: string, body: unknown): Promise<{ status: number; payload?: unknown }> {
    // Best-effort summarization for the log; full payload preserved in
    // memory only since hooks can be large (Stop carries
    // `last_assistant_message`).
    const summary = typeof body === 'object' && body !== null
      ? Object.keys(body as Record<string, unknown>).join(',')
      : typeof body;
    console.log(`[tty:hook] sess=${sessionId} event=${event} keys=${summary}`);

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
    // will handle DB updates separately.
    if (event === 'SessionEnd') {
      this.registry.revoke(sessionId);
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
      this.broadcaster.broadcast({
        type: 'pty:output',
        session_id: sessionId,
        data,
      });
    } else if (notification.method === 'tty.exited') {
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

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

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
        Notification: [
          { matcher: '*', hooks: [{ type: 'http', url: hookUrl('Notification'), timeout: 10 }] },
        ],
        FileChanged: [mkHook('FileChanged', 10)],
        SessionEnd: [mkHook('SessionEnd', 10)],
      },
    };
  }
}
