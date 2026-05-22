/**
 * Workbench terminal manager.
 *
 * Owns a pool of plain-old shell PTYs surfaced as xterm tabs in the
 * workbench pane. Nothing to do with Claude / Codex sessions — these
 * are just `$SHELL` running in the user's workspace, the way a
 * built-in IDE terminal works.
 *
 * Keyed by an opaque client-minted `term_id` (uuid-ish) — one PTY per
 * id, ring buffer per PTY for replay-on-reconnect. WS frames are JSON
 * with base64-encoded payloads, same shape as the session TTY path
 * (see `pty:output` in cc-proxy land) so the xterm component on the
 * client can stay one mostly-shared piece of code.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import type { IPty } from 'node-pty';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

let nodePtyPromise: Promise<typeof import('node-pty')> | null = null;
async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) nodePtyPromise = import('node-pty');
  return nodePtyPromise;
}

/** Default ring-buffer cap per terminal (~1 MiB). Mirrors the session
 *  TTY runtime so xterm reconnects feel the same regardless of which
 *  surface the user is in. */
const DEFAULT_RING_BUFFER_BYTES = 1024 * 1024;

interface WorkbenchTerminalRec {
  termId: string;
  pty: IPty;
  cwd: string;
  shell: string;
  ring: RingBuffer;
  cols: number;
  rows: number;
  exited: boolean;
}

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
}

export interface WorkbenchTerminalEvents {
  output: [termId: string, chunk: Buffer];
  exited: [termId: string, code: number | null, signal: string | null];
}

export interface SpawnOptions {
  termId: string;
  /** Working directory for the shell. Falls back to $HOME if missing. */
  cwd?: string;
  cols: number;
  rows: number;
  /** Optional override of the shell binary. Defaults to $SHELL → /bin/zsh
   *  → /bin/bash → /bin/sh. */
  shell?: string;
}

/**
 * Indirection over `node-pty.spawn` so TERM-001 tests can inject a fake
 * PTY without needing a real shell. Production callers pass the real
 * node-pty loader (default).
 */
export interface PtyFactory {
  spawn(shell: string, args: string[], opts: {
    name?: string; cols: number; rows: number; cwd: string;
    env: NodeJS.ProcessEnv;
  }): IPty;
}

async function defaultPtyFactory(): Promise<PtyFactory> {
  const m = await loadNodePty();
  return { spawn: (shell, args, opts) => m.spawn(shell, args, opts) };
}

export class WorkbenchTerminalManager extends EventEmitter<WorkbenchTerminalEvents> {
  private readonly terms = new Map<string, WorkbenchTerminalRec>();
  private readonly ptyFactory: () => Promise<PtyFactory>;

  constructor(
    private readonly broadcaster: WsBroadcaster,
    ptyFactory?: () => Promise<PtyFactory>,
  ) {
    super();
    this.ptyFactory = ptyFactory ?? defaultPtyFactory;
    this.on('output', (termId, chunk) => {
      this.broadcaster.broadcast({
        type: 'term:output',
        term_id: termId,
        data: chunk.toString('base64'),
      });
    });
    this.on('exited', (termId, code, signal) => {
      this.broadcaster.broadcast({
        type: 'term:exited',
        term_id: termId,
        code,
        signal,
      });
    });
  }

  /** Spawn (or restart, if a terminal with this id already exists) a
   *  shell PTY. Idempotent: a second call with the same `termId` first
   *  kills the previous PTY. */
  async spawn(opts: SpawnOptions): Promise<{ replay: string[]; alive: boolean }> {
    await this.kill(opts.termId);

    const cwd = resolveCwd(opts.cwd);
    const shell = resolveShell(opts.shell);

    const pty = await this.ptyFactory();
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(1, Math.floor(opts.cols)),
      rows: Math.max(1, Math.floor(opts.rows)),
      cwd,
      // Pass through the user's env, but force TERM to xterm-256color so
      // colored output works no matter what TERM was set to in the parent.
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const ring = new RingBuffer(DEFAULT_RING_BUFFER_BYTES);
    const record: WorkbenchTerminalRec = {
      termId: opts.termId,
      pty: proc,
      cwd,
      shell,
      ring,
      cols: opts.cols,
      rows: opts.rows,
      exited: false,
    };
    this.terms.set(opts.termId, record);

    proc.onData((data: string) => {
      const buf = Buffer.from(data, 'utf8');
      ring.push(buf);
      this.emit('output', opts.termId, buf);
    });
    proc.onExit(({ exitCode, signal }) => {
      record.exited = true;
      const signalName =
        typeof signal === 'number' ? `SIG#${signal}` : (signal ?? null);
      this.emit('exited', opts.termId, exitCode ?? null, signalName);
    });

    return { replay: ring.snapshotBase64(), alive: true };
  }

  input(termId: string, data: string): void {
    const rec = this.terms.get(termId);
    if (!rec || rec.exited) return;
    const bytes = Buffer.from(data, 'base64');
    // node-pty's write wants a string; round-trip through utf8. xterm
    // serializes keys as utf8, so this is lossless for keystrokes; truly
    // binary input (rare in a shell) gets best-effort.
    rec.pty.write(bytes.toString('utf8'));
  }

  resize(termId: string, cols: number, rows: number): void {
    const rec = this.terms.get(termId);
    if (!rec || rec.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    rec.cols = Math.floor(cols);
    rec.rows = Math.floor(rows);
    try {
      rec.pty.resize(rec.cols, rec.rows);
    } catch {
      // PTY may have died between input and resize; the next data event
      // will surface the exit.
    }
  }

  replay(termId: string): { chunks: string[]; alive: boolean } {
    const rec = this.terms.get(termId);
    if (!rec) return { chunks: [], alive: false };
    return { chunks: rec.ring.snapshotBase64(), alive: !rec.exited };
  }

  async kill(termId: string): Promise<void> {
    const rec = this.terms.get(termId);
    if (!rec) return;
    if (!rec.exited) {
      try { rec.pty.kill('SIGTERM'); } catch { /* already dying */ }
    }
    this.terms.delete(termId);
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.terms.keys());
    for (const id of ids) await this.kill(id);
  }

  size(): number {
    return this.terms.size;
  }
}

function resolveShell(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort — let the OS error out if even /bin/sh is missing.
  return '/bin/sh';
}

function resolveCwd(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return homedir();
}
