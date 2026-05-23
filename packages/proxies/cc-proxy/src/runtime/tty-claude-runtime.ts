/**
 * Pure-TTY backend for Claude Code.
 *
 * Runs the interactive `claude` CLI inside a PTY (via node-pty), forwards
 * raw bytes both ways, and exposes lifecycle hooks via per-session
 * `--settings` JSON (HTTP hooks → host's `/internal/hooks/claude/...`).
 *
 * Unlike `ClaudeMcpRuntime`, this does NOT implement the structured
 * `ClaudeRuntime` interface — TTY has no permissionRequest / channelReply
 * concept (the user approves directly in the terminal). It's wired as a
 * separate per-session backend the host can swap in via the runtime-mode
 * toggle. The proxy's existing structured path stays untouched.
 *
 * The ring buffer is the trick that lets a user refresh the browser (or
 * reconnect after a network hiccup) and see the screen they had: we keep
 * up to ~1 MiB of raw bytes per session, and the client replays them
 * before subscribing to live output. Past 1 MiB we drop the oldest.
 */

import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
// Pulled in lazily so `import.meta`/native-binding cost is only paid when
// a session actually flips to TTY. cc-proxy boots cold for every Gian
// session, even structured-only ones — no reason to load node-pty when
// nobody asked for a PTY.
let nodePtyPromise: Promise<typeof import('node-pty')> | null = null;
async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) nodePtyPromise = import('node-pty');
  return nodePtyPromise;
}

/** Default ring-buffer cap. Big enough for a few full screens of dense
 *  output (e.g. a `git diff` dump) without unbounded growth. */
const DEFAULT_RING_BUFFER_BYTES = 1024 * 1024;

/**
 * Lifecycle events emitted by the TTY runtime — consumed by the cc-proxy
 * service so it can turn them into JSON-RPC notifications back to the host.
 */
export interface TtyRuntimeEvents {
  /** Raw PTY stdout/stderr bytes (already in the ring buffer). */
  output: [sessionId: string, chunk: Buffer];
  /** PTY process exited. The session is still registered — host may
   *  decide to restart, or the user can re-spawn by sending input. */
  exited: [sessionId: string, code: number | null, signal: string | null];
  debug: [message: string];
}

export interface SpawnPtyOptions {
  /** Gian-side session id (used to key tmp dirs and hook routes). */
  sessionId: string;
  /** Claude-side session uuid; reused across mode flips so history
   *  resumes seamlessly. */
  claudeSessionId: string;
  /** Workspace cwd. Passed as `--add-dir` + as the PTY cwd. */
  cwd: string;
  /** Optional `--model` value (alias or full id). */
  model?: string | null;
  /** True on the *first* spawn of a re-adopted session (initial
   *  `--resume`); false for a brand-new session where we mint the uuid
   *  via `--session-id`. After the first spawn we always resume. */
  isResume: boolean;
  /** xterm columns / rows at spawn time. Resize via `resize()` later. */
  cols: number;
  rows: number;
  /** Hook settings — JSON content the runtime writes to a tmp file and
   *  passes via `--settings`. `null` means "no hooks this spawn"
   *  (useful for smoke tests). */
  hookSettings: Record<string, unknown> | null;
  /** Optional env overrides — primarily PATH so launchd-spawned host can
   *  find `claude` even when its env is minimal. */
  env?: NodeJS.ProcessEnv;
  /** Optional extra CLI args appended after the standard ones. Used by
   *  the host to inject `--remote-control` when the caller wants TTY +
   *  Claude Code remote control. The proxy treats them as opaque — it's
   *  the host's job to keep this list trustworthy. */
  extraArgs?: string[];
}

interface TtySession {
  sessionId: string;
  claudeSessionId: string;
  pty: IPty;
  cwd: string;
  ring: RingBuffer;
  cols: number;
  rows: number;
  /** Path to the per-spawn `--settings` tmp file. Removed on exit. */
  settingsTmpPath: string | null;
  /** True once `--session-id` has been used at least once; subsequent
   *  spawns of the same session must use `--resume`. */
  hasResumedOnce: boolean;
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

  /** Return a copy of all retained chunks as base64 strings. */
  snapshotBase64(): string[] {
    return this.chunks.map(c => c.toString('base64'));
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}

function claudeExecutable(): string {
  // Mirror claude-mcp-runtime: honor explicit override, otherwise PATH lookup.
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return 'claude';
}

export class TtyClaudeRuntime extends EventEmitter<TtyRuntimeEvents> {
  private readonly sessions = new Map<string, TtySession>();
  private readonly ringCap: number;

  constructor(opts: { ringBufferBytes?: number } = {}) {
    super();
    this.ringCap = opts.ringBufferBytes ?? DEFAULT_RING_BUFFER_BYTES;
  }

  /**
   * Spawn the interactive `claude` CLI under a PTY for `sessionId`.
   * Idempotent: if a session is already live, the existing one is torn
   * down first (mirrors `ClaudeMcpRuntime.spawnSession` semantics).
   */
  async spawnSession(options: SpawnPtyOptions): Promise<void> {
    await this.killSession(options.sessionId);

    const pty = await loadNodePty();

    let settingsTmpPath: string | null = null;
    if (options.hookSettings) {
      settingsTmpPath = await this.writeSettings(options.sessionId, options.hookSettings);
    }

    const args = this.buildArgs(options, settingsTmpPath);
    this.emit('debug', `[tty-runtime] spawn ${options.sessionId}: claude ${args.slice(0, 6).join(' ')}...`);

    const ptyProc = pty.spawn(claudeExecutable(), args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    const ring = new RingBuffer(this.ringCap);
    const record: TtySession = {
      sessionId: options.sessionId,
      claudeSessionId: options.claudeSessionId,
      pty: ptyProc,
      cwd: options.cwd,
      ring,
      cols: options.cols,
      rows: options.rows,
      settingsTmpPath,
      hasResumedOnce: options.isResume,
      exited: false,
    };
    this.sessions.set(options.sessionId, record);

    ptyProc.onData((data: string) => {
      // node-pty's `data` is a UTF-8 string; convert to bytes so we don't
      // accidentally re-encode mid-codepoint when chunks split a multi-
      // byte char across an emit boundary. xterm consumes Uint8Array fine.
      const buf = Buffer.from(data, 'utf8');
      ring.push(buf);
      this.emit('output', options.sessionId, buf);
    });

    ptyProc.onExit(({ exitCode, signal }) => {
      record.exited = true;
      const signalName =
        typeof signal === 'number' ? `SIG#${signal}` : (signal ?? null);
      this.emit('debug', `[tty-runtime] ${options.sessionId} exited (code=${exitCode}, signal=${signalName ?? 'null'})`);
      this.emit('exited', options.sessionId, exitCode ?? null, signalName);
      // Drop tmp settings; ring buffer retained until session is removed
      // so reconnect-after-crash can show the final frame.
      if (record.settingsTmpPath) {
        const path = record.settingsTmpPath;
        record.settingsTmpPath = null;
        rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** Write base64-encoded bytes verbatim to the PTY stdin. The host is
   *  expected to handle bracketed paste / line-ending normalization on
   *  its side when forwarding `sendMessage`; live keystroke streams
   *  arrive byte-perfect. */
  writeBytes(sessionId: string, base64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return;
    const decoded = Buffer.from(base64, 'base64');
    // node-pty's write accepts string; convert from utf8. For non-utf8
    // input streams (rare in keystrokes) we'd lose info, but xterm
    // serializes keys as utf8 by convention.
    session.pty.write(decoded.toString('utf8'));
  }

  /**
   * Wrap `text` in a bracketed paste sequence + trailing carriage
   * return and write it to stdin. Use for `sendMessage` from the
   * structured WS message path — the user types straight into xterm
   * for live keystrokes.
   */
  pasteMessage(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return;
    const normalized = text.replace(/\r\n/g, '\n');
    const payload = `\x1b[200~${normalized}\x1b[201~\r`;
    session.pty.write(payload);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    session.cols = Math.floor(cols);
    session.rows = Math.floor(rows);
    try {
      session.pty.resize(session.cols, session.rows);
    } catch (err) {
      this.emit('debug', `[tty-runtime] resize failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** True iff a PTY for this session is registered AND still running. */
  isSessionAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !session.exited;
  }

  /** Replay buffer for fresh connects / mode flips. Empty array when
   *  the session has never run. */
  snapshotBase64(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.ring.snapshotBase64() ?? [];
  }

  /** Kill the PTY and drop tmp settings. Keeps the ring buffer so a
   *  reconnecting client can replay the final state; call
   *  `removeSession` to drop the buffer too. */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.exited) {
      try { session.pty.kill('SIGTERM'); } catch { /* already dying */ }
    }
    if (session.settingsTmpPath) {
      const path = session.settingsTmpPath;
      session.settingsTmpPath = null;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Drop session record entirely (kill + forget ring buffer). Called
   *  when the Gian session is closed or runtime-mode flips back to
   *  Structured. */
  async removeSession(sessionId: string): Promise<void> {
    await this.killSession(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Tear everything down — used when the cc-proxy itself is shutting
   *  down. */
  async stop(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) await this.removeSession(id);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildArgs(options: SpawnPtyOptions, settingsTmpPath: string | null): string[] {
    const args: string[] = [];
    if (settingsTmpPath) {
      args.push('--settings', settingsTmpPath);
    }
    args.push('--add-dir', options.cwd);
    // Session-id flag: brand-new on first spawn, resume thereafter. We
    // also resume on the first spawn when the caller adopted an
    // existing on-disk session (`isResume: true`).
    if (options.isResume) {
      args.push('--resume', options.claudeSessionId);
    } else {
      args.push('--session-id', options.claudeSessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  private async writeSettings(
    sessionId: string,
    settings: Record<string, unknown>,
  ): Promise<string> {
    const dir = join(tmpdir(), `gian-claude-${sessionId}-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify(settings, null, 2), 'utf8');
    return path;
  }
}
