import type { RuntimeMode, Session } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { CodexProxySessionClient } from '../proxy/codex-proxy-client.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

/** Subset of `CodexProxySessionClient` this manager touches. Named as
 *  a structural type so test doubles don't have to extend the real
 *  class (which would drag in a real `CodexProxyHost` and a subprocess
 *  spawn at construction time). */
type CodexTtyClient = Pick<CodexProxySessionClient,
  'ttyStart' | 'ttyInput' | 'ttyResize' | 'ttyReplay' | 'ttyKill' | 'getProxySessionId'>;

function isCodexTtyClient(client: unknown): client is CodexTtyClient {
  return !!client
    && typeof (client as { ttyStart?: unknown }).ttyStart === 'function'
    && typeof (client as { getProxySessionId?: unknown }).getProxySessionId === 'function';
}

/**
 * Coordinator for the TTY runtime on the codex executor.
 *
 * Mirrors `packages/host/src/tty/manager.ts` (the claude TTY coordinator)
 * but deliberately drops the entire hook subsystem — codex has no
 * `--settings` / HTTP hook surface, so no token registry, no per-spawn
 * settings.json, no `/internal/hooks/codex/*` route. Notification parity
 * (turn.started / completed via JSONL tail) is a deferred concern.
 *
 * Responsibilities:
 *   - Tell codex-proxy to start / stop the PTY.
 *   - Fan PTY output (delivered as `tty.output` / `tty.exited`
 *     notifications) out to subscribed WebSocket clients, keyed on the
 *     `gianSessionId` the proxy carries alongside its proxySessionId
 *     routing key.
 *   - Persist `sessions.runtime_mode` on every successful switch.
 */
export class CodexTtyManager {
  constructor(
    private readonly db: Db,
    private readonly proxy: ProxyManager,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  /**
   * Bring the TTY runtime up for a session. Caller (SessionManager) must
   * have:
   *   - verified idle preconditions
   *   - run `ensureProxySession(session)` so `native_session_id` is
   *     populated and the codex-proxy facade is alive
   *   - re-read the session row so `native_session_id` reflects any
   *     freshly-minted codex threadId
   *
   * Returns the replay buffer so the client can prime xterm with the
   * boot output of the freshly-spawned `codex resume <uuid>`.
   */
  async start(
    session: Session,
    cwd: string,
    opts: { cols: number; rows: number },
  ): Promise<{ replay: string[]; alive: boolean }> {
    if (session.executor !== 'codex') {
      throw new Error(`CodexTtyManager.start called for non-codex session (${session.executor})`);
    }
    if (!session.native_session_id) {
      throw new Error(`session ${session.id} has no native_session_id — caller must run ensureProxySession before start`);
    }
    const client = this.proxy.get(session.id);
    if (!isCodexTtyClient(client)) {
      throw new Error(`no codex-proxy client for session ${session.id} — bring the session up first`);
    }
    const proxySessionId = client.getProxySessionId();
    if (!proxySessionId) {
      throw new Error(`codex-proxy facade for ${session.id} has no proxySessionId — createSession must run first`);
    }

    const result = await client.ttyStart({
      gianSessionId: session.id,
      proxySessionId,
      codexThreadId: session.native_session_id,
      cwd,
      cols: opts.cols,
      rows: opts.rows,
      model: session.model,
    });

    this.persistMode(session.id, 'tty');
    return { replay: result.replay, alive: result.alive };
  }

  /** Tear the PTY down. Safe to call when the session is already in
   *  structured mode (proxy-side runtime treats kill as a no-op for
   *  unknown sessions). */
  async stop(session: Session): Promise<void> {
    const client = this.proxy.get(session.id);
    if (isCodexTtyClient(client)) {
      try { await client.ttyKill({ gianSessionId: session.id }); } catch { /* proxy may have exited */ }
    }
    this.persistMode(session.id, 'structured');
  }

  /** Forward a raw byte chunk (base64) from the WS client to the PTY. */
  async input(sessionId: string, payload: { data?: string; text?: string }): Promise<void> {
    const client = this.proxy.get(sessionId);
    if (!isCodexTtyClient(client)) return;
    await client.ttyInput({ gianSessionId: sessionId, ...payload });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const client = this.proxy.get(sessionId);
    if (!isCodexTtyClient(client)) return;
    await client.ttyResize({ gianSessionId: sessionId, cols, rows });
  }

  /** Snapshot the ring buffer — called by the WS replay-request handler. */
  async replay(sessionId: string): Promise<{ chunks: string[]; alive: boolean }> {
    const client = this.proxy.get(sessionId);
    if (!isCodexTtyClient(client)) return { chunks: [], alive: false };
    return client.ttyReplay({ gianSessionId: sessionId });
  }

  // ---------------------------------------------------------------------------
  // Notification routing — SessionManager hands us `tty.output` / `tty.exited`
  // notifications for codex sessions. We re-broadcast as `pty:output` (keyed
  // on gianSessionId so the WS layer can route to the right browser) /
  // `event` (so the UI knows the PTY died).
  // ---------------------------------------------------------------------------

  handleProxyNotification(notification: { method?: string; params?: unknown }): void {
    if (!notification.method) return;
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const gianSessionId = typeof params.gianSessionId === 'string' ? params.gianSessionId : null;
    if (!gianSessionId) return;
    if (notification.method === 'tty.output') {
      const data = typeof params.data === 'string' ? params.data : '';
      this.broadcaster.broadcast({
        type: 'pty:output',
        session_id: gianSessionId,
        data,
      });
    } else if (notification.method === 'tty.exited') {
      this.broadcaster.broadcast({
        type: 'event',
        session_id: gianSessionId,
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
}
