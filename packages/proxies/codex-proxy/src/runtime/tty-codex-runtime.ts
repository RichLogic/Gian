/**
 * Pure-TTY backend for Codex Code (`codex` interactive TUI).
 *
 * Runs the interactive `codex` CLI inside a PTY (via node-pty), forwards
 * raw bytes both ways, and keeps a per-session ring buffer so reconnects
 * can replay the last screen.
 *
 * Mirrors `packages/proxies/cc-proxy/src/runtime/tty-claude-runtime.ts`
 * in shape, but:
 *
 *   - **No hooks.** Codex has no Claude-style `--settings` / HTTP hook
 *     surface, so this runtime doesn't write any tmp settings file and
 *     doesn't carry hook credentials. Notification parity (turn.started
 *     / completed via JSONL tail) is a separate, deferred concern.
 *   - **No `--session-id` flag.** Codex only supports `codex resume
 *     <UUID>` for an already-existing thread; the caller is expected to
 *     have already minted the codex thread UUID via the existing
 *     app-server `thread/start` path (host's `ensureProxySession` does
 *     this implicitly on first `bringUpProxySession`).
 *   - **`PtyFactory` injection** for unit tests, following the pattern
 *     in `packages/host/src/term/manager.ts` (TERM-001). cc-proxy's
 *     older runtime inlines `node-pty.spawn` directly — we deliberately
 *     don't, so the unit suite can drive this with a fake PTY.
 *
 * Lifecycle events `output` / `exited` carry **both** `gianSessionId`
 * and `proxySessionId` so the upstream JSON-RPC service can include the
 * routing keys host needs. The runtime itself only uses `gianSessionId`
 * to key the session table.
 */

import { EventEmitter } from 'node:events';

import type { IPty } from 'node-pty';
// Lazy load so codex-proxy doesn't pay node-pty's native-binding cost
// when nothing has ever asked for a PTY (every session enters Structured
// mode first; CLI mode is opt-in).
let nodePtyPromise: Promise<typeof import('node-pty')> | null = null;
async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) nodePtyPromise = import('node-pty');
  return nodePtyPromise;
}

/** Default ring-buffer cap. Matches the cc-proxy TTY runtime + the host
 *  workbench terminal manager — keeps reconnect UX uniform. */
const DEFAULT_RING_BUFFER_BYTES = 1024 * 1024;

export interface TtyCodexRuntimeEvents {
  /** Raw PTY stdout/stderr bytes (already in the ring buffer). */
  output: [
    gianSessionId: string,
    proxySessionId: string,
    chunk: Buffer,
  ];
  /** PTY process exited. The session record stays registered (so a
   *  reconnecting client can still pull the ring buffer); call
   *  `removeSession` to drop it entirely. */
  exited: [
    gianSessionId: string,
    proxySessionId: string,
    code: number | null,
    signal: string | null,
  ];
  debug: [message: string];
}

export interface SpawnCodexPtyOptions {
  /** Gian-side session id; the Map's primary key + the broadcast key
   *  host uses on the WS side. */
  gianSessionId: string;
  /** codex-proxy-side session id (`SessionRecord.id`, e.g. `sess_xxx`).
   *  **Distinct** from the codex thread UUID — codex-proxy mints
   *  `sess_xxx` ids in its internal session table and uses those as
   *  the JSON-RPC `params.sessionId` routing key, while the thread
   *  UUID travels separately as `codexThreadId` / `params.threadId`.
   *  The runtime just echoes this back so the upstream service can
   *  set it as the notification routing key. */
  proxySessionId: string;
  /** Codex thread UUID — passed as the positional arg to `codex resume`.
   *  Caller must have ensured the thread already exists on disk; the
   *  runtime does no minting. */
  codexThreadId: string;
  /** Working directory. Used as the PTY cwd, as `-C <cwd>`, and as
   *  `--add-dir <cwd>` (so codex can read+write inside the workspace). */
  cwd: string;
  /** Optional `-m <model>` value. */
  model?: string | null;
  /** xterm columns / rows at spawn time. `resize()` updates later. */
  cols: number;
  rows: number;
  /** Optional env overrides — primarily PATH so launchd-spawned host
   *  can find `codex` even when its env is minimal. Merged onto
   *  `process.env`. */
  env?: NodeJS.ProcessEnv;
}

interface TtySession {
  gianSessionId: string;
  proxySessionId: string;
  codexThreadId: string;
  pty: IPty;
  cwd: string;
  ring: RingBuffer;
  cols: number;
  rows: number;
  exited: boolean;
}

/**
 * Append-only byte buffer with a soft byte cap. Older chunks fall off
 * the front when the cap is exceeded — replay is intentionally lossy.
 */
class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift();
      if (head) this.size -= head.length;
    }
  }

  snapshotBase64(): string[] {
    return this.chunks.map(c => c.toString('base64'));
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}

function codexExecutable(override?: string | null): string {
  // Precedence: explicit constructor override (the spawn.ts `--codex-bin`
  // flag flows through here so structured + TTY both honor it) > env
  // `CODEX_BIN` > hardcoded darwin fallback > PATH lookup. Mirror of
  // `CodexAppServerClient`'s resolution so a session can't end up with
  // structured pointing at one binary and CLI silently spawning another.
  if (override && override.trim()) return override.trim();
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) return configured;
  if (process.platform === 'darwin') return '/opt/homebrew/bin/codex';
  return 'codex';
}

/**
 * Indirection over `node-pty.spawn` so unit tests can inject a fake PTY
 * without needing a real `codex` install. Default factory wraps node-pty
 * via `loadNodePty()` (kept lazy).
 */
export interface PtyFactory {
  spawn(
    bin: string,
    args: string[],
    opts: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): IPty;
}

async function defaultPtyFactory(): Promise<PtyFactory> {
  const m = await loadNodePty();
  return { spawn: (bin, args, opts) => m.spawn(bin, args, opts) };
}

export class TtyCodexRuntime extends EventEmitter<TtyCodexRuntimeEvents> {
  private readonly sessions = new Map<string, TtySession>();
  private readonly ringCap: number;
  private readonly ptyFactory: () => Promise<PtyFactory>;
  private readonly codexBin: string | null;

  constructor(opts: {
    ringBufferBytes?: number;
    ptyFactory?: () => Promise<PtyFactory>;
    /** Override the codex binary path. Same value the structured
     *  `CodexAppServerClient` gets from `--codex-bin`; both paths must
     *  agree or a session's structured CHAT and CLI mode silently
     *  invoke different binaries. */
    codexBin?: string | null;
  } = {}) {
    super();
    this.ringCap = opts.ringBufferBytes ?? DEFAULT_RING_BUFFER_BYTES;
    this.ptyFactory = opts.ptyFactory ?? defaultPtyFactory;
    this.codexBin = opts.codexBin ?? null;
  }

  /**
   * Spawn the interactive `codex` CLI under a PTY for `gianSessionId`.
   * Idempotent: if a session is already live, the existing one is torn
   * down first.
   */
  async spawnSession(options: SpawnCodexPtyOptions): Promise<void> {
    await this.killSession(options.gianSessionId);

    const args = this.buildArgs(options);
    this.emit('debug', `[tty-codex-runtime] spawn ${options.gianSessionId}: codex ${args.join(' ')}`);

    const factory = await this.ptyFactory();
    const ptyProc = factory.spawn(codexExecutable(this.codexBin), args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    const ring = new RingBuffer(this.ringCap);
    const record: TtySession = {
      gianSessionId: options.gianSessionId,
      proxySessionId: options.proxySessionId,
      codexThreadId: options.codexThreadId,
      pty: ptyProc,
      cwd: options.cwd,
      ring,
      cols: options.cols,
      rows: options.rows,
      exited: false,
    };
    this.sessions.set(options.gianSessionId, record);

    ptyProc.onData((data: string) => {
      // node-pty surfaces utf-8 strings; round-trip via Buffer so a
      // multi-byte char split across two emits doesn't re-encode wrong.
      const buf = Buffer.from(data, 'utf8');
      ring.push(buf);
      this.emit('output', options.gianSessionId, options.proxySessionId, buf);
    });

    ptyProc.onExit(({ exitCode, signal }) => {
      record.exited = true;
      const signalName =
        typeof signal === 'number' ? `SIG#${signal}` : (signal ?? null);
      this.emit(
        'debug',
        `[tty-codex-runtime] ${options.gianSessionId} exited (code=${exitCode}, signal=${signalName ?? 'null'})`,
      );
      this.emit(
        'exited',
        options.gianSessionId,
        options.proxySessionId,
        exitCode ?? null,
        signalName,
      );
    });
  }

  /** Write base64-encoded bytes verbatim to the PTY stdin. Live
   *  keystroke stream from xterm. */
  writeBytes(gianSessionId: string, base64: string): void {
    const session = this.sessions.get(gianSessionId);
    if (!session || session.exited) return;
    const decoded = Buffer.from(base64, 'base64');
    session.pty.write(decoded.toString('utf8'));
  }

  /** Wrap `text` in a bracketed-paste sequence + trailing carriage
   *  return and write it to stdin. Reserved for a future `sendMessage`
   *  → PTY-paste bridge (out of scope for the initial CLI shipment;
   *  see spec §8 / §3.4). */
  pasteMessage(gianSessionId: string, text: string): void {
    const session = this.sessions.get(gianSessionId);
    if (!session || session.exited) return;
    const normalized = text.replace(/\r\n/g, '\n');
    const payload = `\x1b[200~${normalized}\x1b[201~\r`;
    session.pty.write(payload);
  }

  resize(gianSessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(gianSessionId);
    if (!session || session.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    session.cols = Math.floor(cols);
    session.rows = Math.floor(rows);
    try {
      session.pty.resize(session.cols, session.rows);
    } catch (err) {
      this.emit(
        'debug',
        `[tty-codex-runtime] resize failed for ${gianSessionId}: ${(err as Error).message}`,
      );
    }
  }

  /** True iff a PTY for this session is registered AND still running. */
  isSessionAlive(gianSessionId: string): boolean {
    const session = this.sessions.get(gianSessionId);
    return !!session && !session.exited;
  }

  /** Replay buffer for fresh connects / mode flips. Empty array when
   *  the session has never run. */
  snapshotBase64(gianSessionId: string): string[] {
    return this.sessions.get(gianSessionId)?.ring.snapshotBase64() ?? [];
  }

  /** Kill the PTY. Keeps the ring buffer so a reconnecting client can
   *  replay the final state; call `removeSession` to drop it entirely. */
  async killSession(gianSessionId: string): Promise<void> {
    const session = this.sessions.get(gianSessionId);
    if (!session) return;
    if (!session.exited) {
      try { session.pty.kill('SIGTERM'); } catch { /* already dying */ }
    }
  }

  /** Drop session record entirely (kill + forget ring buffer). Called
   *  when the Gian session is closed or runtime-mode flips back to
   *  Structured. */
  async removeSession(gianSessionId: string): Promise<void> {
    await this.killSession(gianSessionId);
    this.sessions.delete(gianSessionId);
  }

  /** Tear everything down — used when codex-proxy itself is shutting
   *  down. */
  async stop(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) await this.removeSession(id);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildArgs(options: SpawnCodexPtyOptions): string[] {
    const args: string[] = ['resume', options.codexThreadId, '-C', options.cwd, '--add-dir', options.cwd];
    if (options.model) args.push('-m', options.model);
    return args;
  }
}
