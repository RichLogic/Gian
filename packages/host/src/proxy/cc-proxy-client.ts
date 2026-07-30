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

export interface CcProxyClientOptions {
  /** Absolute path to cc-proxy spawn.js entry. */
  entry: string;
  /** Per-session data dir (passed as --data-dir to cc-proxy). PR2 made the
   *  proxy stateless across restarts — kept for any transient runtime
   *  artefacts the proxy still writes. */
  dataDir: string;
  /** Optional override for the node executable. */
  nodeBin?: string;
  /** Logger for stderr / lifecycle events. */
  log?: (msg: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Stdio JSON-RPC client for cc-proxy. Each instance owns one cc-proxy child
 * process. cc-proxy itself supports multiple sessions per process, but in this
 * codebase we treat cc-proxy as one-process-per-session to match its per-turn
 * spawn model.
 */
export class CcProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;

  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Set<NotificationHandler>();
  private exitHandlers = new Set<(code: number | null) => void>();
  private log: (msg: string) => void;
  private exited = false;

  constructor(opts: CcProxyClientOptions) {
    this.log = opts.log ?? (() => {});

    const nodeBin = opts.nodeBin ?? process.execPath;
    // `detached: true` puts cc-proxy in its own process group. We still
    // wire stdio normally (no `unref()`), so the child stays parented to
    // host for stdout/stderr/exit observation, but `forceKill` can target
    // the whole pgid via `process.kill(-pid, 'SIGKILL')` to also nuke any
    // grandchild claude `-p` processes — they otherwise get orphaned to
    // init when the cc-proxy node is SIGKILLed and keep running idle.
    this.child = spawn(nodeBin, [opts.entry, '--data-dir', opts.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });

    this.bindStdout();
    this.bindStderr();
    this.bindExit();
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  initialize(): Promise<InitializeResult> {
    return this.request<InitializeResult>('initialize');
  }

  capabilities(): Promise<ProxyCapabilities> {
    return this.request<ProxyCapabilities>('capabilities.list');
  }

  listSlashCommands(cwd?: string): Promise<import('@gian/shared').SlashListResult> {
    return this.request<import('@gian/shared').SlashListResult>(
      'slash.list',
      cwd ? { cwd } : {},
    );
  }

  async createSession(
    params: CreateSessionParams,
  ): Promise<{ session: ProxySession; nativeSessionId: string }> {
    const result = await this.request<{ session: ProxySession }>(
      'session.create',
      params,
    );
    // cc-proxy serializes `claudeSessionId` on the wire (see
    // packages/proxies/cc-proxy/src/core/service.ts#serializeSession). The
    // shared `ProxySession` type doesn't list it, so cast to read it.
    const claudeSessionId = (result.session as unknown as {
      claudeSessionId?: unknown;
    }).claudeSessionId;
    if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) {
      throw new Error('cc-proxy createSession returned without claudeSessionId');
    }
    return { session: result.session, nativeSessionId: claudeSessionId };
  }

  async startTurn(
    params: StartTurnParams,
  ): Promise<{ session: ProxySession; turn: { id: string } }> {
    return this.request<{ session: ProxySession; turn: { id: string } }>(
      'turn.start',
      params,
    );
  }

  async interruptTurn(sessionId: string): Promise<void> {
    await this.request<unknown>('turn.interrupt', { sessionId });
  }

  async respondApproval(params: RespondApprovalParams): Promise<void> {
    // cc-proxy uses { behavior: 'allow' | 'deny' }, not the {decision, scope}
    // shape codex-proxy uses. Translate at the boundary; cc-proxy has no
    // session-scope concept, so `scope` is dropped. `answers` (AskUserQuestion)
    // passes straight through.
    await this.request<unknown>('approval.respond', {
      sessionId: params.sessionId,
      approvalId: params.approvalId,
      behavior: params.decision === 'accept' ? 'allow' : 'deny',
      ...(params.answers ? { answers: params.answers } : {}),
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request<unknown>('session.close', { sessionId });
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

  /** SIGKILL the cc-proxy child immediately AND any grandchild it spawned
   *  (claude `-p` processes for in-flight turns). Skips the graceful
   *  `shutdown` RPC because that requires the proxy's stdin loop to be
   *  alive — a stuck proxy would never respond. The pgid-targeting
   *  `process.kill(-pid)` works because we spawn cc-proxy with
   *  `detached: true`, which puts it in its own process group; otherwise
   *  the orphaned claude child inherits to init and keeps spinning. */
  forceKill(): void {
    if (this.exited) return;
    const pid = this.child.pid;
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group may already be gone */ }
    }
    // Belt-and-suspenders: also signal the proxy directly in case the
    // pgid kill failed (e.g. `detached` not honored on some platform).
    try { this.child.kill('SIGKILL'); } catch { /* already exited */ }
  }

  private bindStdout(): void {
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        this.log(`[cc-proxy] non-JSON line: ${trimmed}`);
        return;
      }
      this.dispatch(parsed);
    });
  }

  private bindStderr(): void {
    const rl = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    rl.on('line', line => {
      if (line.trim()) this.log(`[cc-proxy:stderr] ${line}`);
    });
  }

  private bindExit(): void {
    this.child.on('exit', code => {
      this.exited = true;
      const err = new Error(`cc-proxy exited (code=${code ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
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
        this.log(`[cc-proxy] no pending request for id=${id}`);
        return;
      }
      this.pending.delete(id);
      const response = msg as unknown as JsonRpcResponse;
      if ('error' in response) {
        const err = new Error(
          `cc-proxy error [${response.error.code}]: ${response.error.message}`,
        );
        pending.reject(err);
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const notification = msg as unknown as ProxyNotification;
      for (const handler of this.notificationHandlers) {
        try {
          handler(notification);
        } catch (err) {
          this.log(`[cc-proxy] notification handler threw: ${String(err)}`);
        }
      }
    }
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error('cc-proxy already exited'));
    }
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
      const line = `${JSON.stringify(payload)}\n`;
      const ok = this.child.stdin.write(line);
      if (!ok) {
        this.child.stdin.once('drain', () => {});
      }
    });
  }
}
