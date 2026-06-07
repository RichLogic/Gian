import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  InitializeResult,
  JsonRpcResponse,
  ProxyCapabilities,
  ProxyNotification,
  ProxySession,
} from '@gian/shared';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  RespondApprovalParams,
  StartTurnParams,
} from './types.js';

export interface CodexProxyHostOptions {
  /** Absolute path to codex-proxy spawn.js entry. */
  entry: string;
  /** Shared data dir for codex-proxy (no longer used for state.json since
   *  PR2; kept for any transient runtime artefacts the proxy may write). */
  dataDir: string;
  /** Optional override for the node executable. */
  nodeBin?: string;
  /** Optional codex binary path; falls back to CODEX_BIN env. */
  codexBin?: string;
  /** Logger for stderr / lifecycle events. */
  log?: (msg: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Process-owning client for codex-proxy. Unlike cc-proxy (one process per
 * session), codex-proxy runs one shared process for all codex sessions —
 * notifications carry `params.sessionId` (the proxy-side session id, which
 * equals the codex `threadId`) so we fan them out to the right per-session
 * facade.
 *
 * Most callers should use `CodexProxySessionClient` (returned by
 * `ProxyManager`) instead of touching the host directly.
 */
export class CodexProxyHost {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  /** proxySessionId -> facade. Set when session.create succeeds. */
  private sessions = new Map<string, CodexProxySessionClient>();
  private exitHandlers = new Set<(code: number | null) => void>();
  private log: (msg: string) => void;
  private exited = false;
  private initialized: Promise<InitializeResult> | null = null;
  private capabilities_: Promise<ProxyCapabilities> | null = null;

  constructor(opts: CodexProxyHostOptions) {
    this.log = opts.log ?? (() => {});

    const nodeBin = opts.nodeBin ?? process.execPath;
    const args = ['--data-dir', opts.dataDir];
    if (opts.codexBin) args.push('--codex-bin', opts.codexBin);

    this.child = spawn(nodeBin, [opts.entry, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.bindStdout();
    this.bindStderr();
    this.bindExit();
  }

  /** Idempotent — multiple session clients can call this safely. */
  initialize(): Promise<InitializeResult> {
    if (!this.initialized) {
      this.initialized = this.request<InitializeResult>('initialize');
    }
    return this.initialized;
  }

  /** Idempotent. */
  capabilities(): Promise<ProxyCapabilities> {
    if (!this.capabilities_) {
      this.capabilities_ = this.request<ProxyCapabilities>('capabilities.list');
    }
    return this.capabilities_;
  }

  listSlashCommands(cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    return this.request<import('@gian/shared').SlashListResult>(
      'slash.list',
      cwd ? { cwd } : {},
    );
  }

  async createSession(
    params: CreateSessionParams,
    facade: CodexProxySessionClient,
  ): Promise<{ session: ProxySession; nativeSessionId: string }> {
    const result = await this.request<{ session: ProxySession }>(
      'session.create',
      params,
    );
    // codex-proxy serializes `threadId` on the wire (see
    // packages/proxies/codex-proxy/src/core/service.ts#serializeSession). The
    // shared `ProxySession` type doesn't list it, so cast to read it.
    const threadId = (result.session as unknown as {
      threadId?: unknown;
    }).threadId;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('codex-proxy createSession returned without threadId');
    }
    // Register routing by the proxy-side session id (== threadId) so
    // subsequent notifications find this facade.
    this.sessions.set(result.session.id, facade);
    return { session: result.session, nativeSessionId: threadId };
  }

  startTurn(
    params: StartTurnParams,
  ): Promise<{ session: ProxySession; turn: { id: string } }> {
    return this.request<{ session: ProxySession; turn: { id: string } }>(
      'turn.start',
      params,
    );
  }

  respondApproval(params: RespondApprovalParams): Promise<void> {
    return this.request<void>('approval.respond', params);
  }

  interruptTurn(sessionId: string): Promise<void> {
    return this.request<void>('turn.interrupt', { sessionId });
  }

  /** SESSION-NAME-001: set the codex thread's display name. `sessionId` is the
   *  proxy-side session id (== threadId). Works on the shared connection
   *  without resuming the thread. */
  setThreadName(sessionId: string, name: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('session.setName', { sessionId, name });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    try {
      await this.request<unknown>('session.close', { sessionId });
    } catch (err) {
      this.log(`[codex-proxy] session.close failed: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // TTY runtime (codex CLI mode)
  //
  // These methods route to codex-proxy's `TtyCodexService` (separate from
  // the structured `CodexProxyService`). Notifications come back as
  // `tty.output` / `tty.exited` and follow the same `params.sessionId`
  // routing the host already does in `dispatch()` — each facade only
  // receives the events for its own session.
  // ---------------------------------------------------------------------------

  ttyStart(params: {
    gianSessionId: string;
    proxySessionId: string;
    codexThreadId: string;
    cwd: string;
    cols: number;
    rows: number;
    model?: string | null;
  }): Promise<{ ok: true; replay: string[]; alive: boolean }> {
    return this.request<{ ok: true; replay: string[]; alive: boolean }>('tty.start', params);
  }

  ttyInput(params: { gianSessionId: string; data?: string; text?: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('tty.input', params);
  }

  ttyResize(params: { gianSessionId: string; cols: number; rows: number }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('tty.resize', params);
  }

  ttyReplay(params: { gianSessionId: string }): Promise<{ chunks: string[]; alive: boolean }> {
    return this.request<{ chunks: string[]; alive: boolean }>('tty.replay', params);
  }

  ttyKill(params: { gianSessionId: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('tty.kill', params);
  }

  onHostExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request<unknown>('shutdown');
    } catch {
      // proxy may exit before responding
    }
    if (!this.exited) {
      this.child.kill('SIGTERM');
    }
  }

  private bindStdout(): void {
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.log(`[codex-proxy] non-JSON line: ${trimmed}`);
        return;
      }
      this.dispatch(parsed);
    });
  }

  private bindStderr(): void {
    const rl = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    rl.on('line', line => {
      if (line.trim()) this.log(`[codex-proxy:stderr] ${line}`);
    });
  }

  private bindExit(): void {
    this.child.on('exit', code => {
      this.exited = true;
      const err = new Error(`codex-proxy exited (code=${code ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      for (const session of this.sessions.values()) session.notifyHostExit(code);
      this.sessions.clear();
      for (const handler of this.exitHandlers) handler(code);
    });
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    if ('id' in msg && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        this.log(`[codex-proxy] no pending request for id=${id}`);
        return;
      }
      this.pending.delete(id);
      const response = msg as unknown as JsonRpcResponse;
      if ('error' in response) {
        const err = new Error(
          `codex-proxy error [${response.error.code}]: ${response.error.message}`,
        );
        pending.reject(err);
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const notification = msg as unknown as ProxyNotification;
      const params = notification.params as { sessionId?: string } | undefined;
      const proxySessionId = params?.sessionId;
      if (proxySessionId) {
        const session = this.sessions.get(proxySessionId);
        if (session) {
          session.deliverNotification(notification);
        } else {
          this.log(
            `[codex-proxy] notification for unknown sessionId=${proxySessionId}`,
          );
        }
      } else {
        // host-level notifications (e.g. protocol.error) — fan out to all
        for (const session of this.sessions.values()) {
          session.deliverNotification(notification);
        }
      }
    }
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error('codex-proxy already exited'));
    }
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
      const line = `${JSON.stringify(payload)}\n`;
      this.child.stdin.write(line);
    });
  }
}

/**
 * Per-session facade that implements `ProxyClient`. Created by `ProxyManager`
 * for each codex session — all instances share a single `CodexProxyHost`.
 */
export class CodexProxySessionClient implements ProxyClient {
  readonly executor = 'codex' as const;

  private notificationHandlers = new Set<NotificationHandler>();
  private exitHandlers = new Set<(code: number | null) => void>();
  private proxySessionId: string | null = null;
  private closed = false;

  constructor(private host: CodexProxyHost) {}

  initialize(): Promise<InitializeResult> {
    return this.host.initialize();
  }

  capabilities(): Promise<ProxyCapabilities> {
    return this.host.capabilities();
  }

  listSlashCommands(cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    return this.host.listSlashCommands(cwd);
  }

  async createSession(
    params: CreateSessionParams,
  ): Promise<{ session: ProxySession; nativeSessionId: string }> {
    const result = await this.host.createSession(params, this);
    this.proxySessionId = result.session.id;
    // result already carries nativeSessionId (extracted from session.threadId
    // by CodexProxyHost.createSession).
    return result;
  }

  /** Codex-proxy-side session id (== codex threadId today). The TTY
   *  family needs this on the wire as the notification routing key
   *  (`params.sessionId`). Returns null before `createSession` runs. */
  getProxySessionId(): string | null {
    return this.proxySessionId;
  }

  // ---------------------------------------------------------------------------
  // TTY runtime passthrough — wraps CodexProxyHost.tty* with the per-session
  // proxySessionId discipline. The host doesn't auto-fill `proxySessionId`
  // from the facade because it's a generic wrapper; callers (the host's
  // CodexTtyManager) are expected to read it via `getProxySessionId()` and
  // pass it explicitly so the dual-id contract is visible at the call site.
  // ---------------------------------------------------------------------------

  ttyStart(params: {
    gianSessionId: string;
    proxySessionId: string;
    codexThreadId: string;
    cwd: string;
    cols: number;
    rows: number;
    model?: string | null;
  }): Promise<{ ok: true; replay: string[]; alive: boolean }> {
    if (!this.proxySessionId) {
      throw new Error('CodexProxySessionClient.ttyStart called before createSession populated proxySessionId');
    }
    return this.host.ttyStart(params);
  }

  ttyInput(params: { gianSessionId: string; data?: string; text?: string }): Promise<{ ok: true }> {
    return this.host.ttyInput(params);
  }

  ttyResize(params: { gianSessionId: string; cols: number; rows: number }): Promise<{ ok: true }> {
    return this.host.ttyResize(params);
  }

  ttyReplay(params: { gianSessionId: string }): Promise<{ chunks: string[]; alive: boolean }> {
    return this.host.ttyReplay(params);
  }

  ttyKill(params: { gianSessionId: string }): Promise<{ ok: true }> {
    return this.host.ttyKill(params);
  }

  startTurn(
    params: StartTurnParams,
  ): Promise<{ session: ProxySession; turn: { id: string } }> {
    return this.host.startTurn(params);
  }

  respondApproval(params: RespondApprovalParams): Promise<void> {
    return this.host.respondApproval(params);
  }

  interruptTurn(sessionId: string): Promise<void> {
    return this.host.interruptTurn(sessionId);
  }

  /** SESSION-NAME-001: set the codex thread's display name via the shared
   *  host's `thread/name/set` RPC. No-op if the facade hasn't created its
   *  session yet (no threadId to target). */
  async setName(name: string): Promise<void> {
    if (!this.proxySessionId) return;
    await this.host.setThreadName(this.proxySessionId, name);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.host.closeSession(sessionId);
  }

  /**
   * Closes this session on the shared host without killing the host process.
   * The actual host shutdown is owned by `ProxyManager.closeAll()`.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.proxySessionId) {
      await this.host.closeSession(this.proxySessionId);
    }
  }

  /** Codex shares a single host across sessions, so we can't SIGKILL.
   *  Fire-and-forget the session-close RPC and flip our facade closed; if
   *  the codex side is wedged the call will never return but we don't
   *  block the recovery flow. */
  forceKill(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proxySessionId) {
      void this.host.closeSession(this.proxySessionId).catch(() => {});
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** @internal — called by host when a notification matches our proxySessionId. */
  deliverNotification(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) {
      try {
        h(notification);
      } catch (err) {
        // swallow — handler errors shouldn't poison the host's dispatch loop
        console.error('[codex-proxy] handler threw:', err);
      }
    }
  }

  /** @internal — called when the shared host process exits. */
  notifyHostExit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}
