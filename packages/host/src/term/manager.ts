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
 * with base64-encoded payloads over the dedicated `term:*` protocol.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { IPty } from 'node-pty';
import type { TerminalOptions } from '@gian/shared';
import type { AgentProcessGroupReservation } from '../agents/update-lock.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

let nodePtyPromise: Promise<typeof import('node-pty')> | null = null;
async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) nodePtyPromise = import('node-pty');
  return nodePtyPromise;
}

/** Default ring-buffer cap per terminal (~1 MiB). */
export const DEFAULT_RING_BUFFER_BYTES = 1024 * 1024;
/** Bound each WS frame so one noisy PTY cannot create multi-megabyte messages. */
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 64 * 1024;

interface WorkbenchTerminalRec {
  termId: string;
  pty: IPty;
  cwd: string;
  shell: string;
  ring: RingBuffer;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  targetCleanup: (() => Promise<void>) | null;
  targetCleanupPromise: Promise<void> | null;
}

class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.subarray(chunk.length - this.cap)];
      this.size = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      const overflow = this.size - this.cap;
      const head = this.chunks[0];
      if (!head) break;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
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
  target?: { kind: 'agent_cli'; agentId: string };
}

export interface ResolvedTerminalTarget {
  executable: string;
  args: string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  reservation: AgentProcessGroupReservation;
  release: () => Promise<void>;
}

export type TerminalTargetResolver = (
  target: NonNullable<SpawnOptions['target']>,
) => Promise<ResolvedTerminalTarget>;

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
    private readonly targetResolver?: TerminalTargetResolver,
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

    if (opts.target && (opts.cwd !== undefined || opts.shell !== undefined)) {
      throw new Error('A terminal target cannot accept a client cwd or shell override.');
    }
    const target = opts.target
      ? await this.resolveTarget(opts.target)
      : null;
    const cwd = target?.cwd ?? resolveCwd(opts.cwd);
    const shell = target?.executable ?? resolveShell(opts.shell);
    const args = target?.args ?? [];

    const pty = await this.ptyFactory();
    let proc: IPty;
    try {
      proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: Math.max(1, Math.floor(opts.cols)),
      rows: Math.max(1, Math.floor(opts.rows)),
      cwd,
      // Pass through the user's env, but force TERM to xterm-256color so
      // colored output works no matter what TERM was set to in the parent.
        env: { ...process.env, ...target?.env, TERM: 'xterm-256color' },
      });
    } catch (error) {
      await target?.reservation.cancelBeforeSpawn();
      await target?.release();
      throw error;
    }

    if (target) {
      try {
        const registered = await target.reservation.register(proc.pid);
        if (registered === 'already-empty') {
          await target.reservation.releaseUnregistered(proc.pid);
          await target.release();
          throw new Error('Agent CLI terminal exited before its process identity was registered.');
        }
      } catch (error) {
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        throw error;
      }
    }

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
      exitCode: null,
      exitSignal: null,
      targetCleanup: target
        ? async () => {
          await target.reservation.release();
          await target.release();
        }
        : null,
      targetCleanupPromise: null,
    };
    this.terms.set(opts.termId, record);

    proc.onData((data: string) => {
      const buf = Buffer.from(data, 'utf8');
      for (let offset = 0; offset < buf.length; offset += MAX_TERMINAL_OUTPUT_CHUNK_BYTES) {
        const chunk = buf.subarray(offset, offset + MAX_TERMINAL_OUTPUT_CHUNK_BYTES);
        ring.push(chunk);
        this.emit('output', opts.termId, chunk);
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      record.exited = true;
      const signalName =
        typeof signal === 'number'
          ? (signal > 0 ? `SIG#${signal}` : null)
          : (signal ?? null);
      record.exitCode = exitCode ?? null;
      record.exitSignal = signalName;
      void this.cleanupTarget(record).catch(() => {
        // Fail closed: the claim file remains and startup recovery will not
        // discard it without process-group absence evidence.
      });
      this.emit('exited', opts.termId, record.exitCode, record.exitSignal);
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

  replay(termId: string): {
    chunks: string[];
    alive: boolean;
    code: number | null;
    signal: string | null;
  } {
    const rec = this.terms.get(termId);
    if (!rec) return { chunks: [], alive: false, code: null, signal: null };
    return {
      chunks: rec.ring.snapshotBase64(),
      alive: !rec.exited,
      code: rec.exitCode,
      signal: rec.exitSignal,
    };
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

  private async resolveTarget(target: NonNullable<SpawnOptions['target']>): Promise<ResolvedTerminalTarget> {
    if (!this.targetResolver) throw new Error('Terminal target resolver is unavailable.');
    const resolved = await this.targetResolver(target);
    if (!isAbsolute(resolved.executable) || !existsSync(resolved.cwd)) {
      await resolved.reservation.cancelBeforeSpawn();
      await resolved.release();
      throw new Error('Terminal target resolved an invalid executable or cwd.');
    }
    return resolved;
  }

  private cleanupTarget(record: WorkbenchTerminalRec): Promise<void> {
    if (!record.targetCleanup) return Promise.resolve();
    if (!record.targetCleanupPromise) {
      record.targetCleanupPromise = record.targetCleanup();
    }
    return record.targetCleanupPromise;
  }
}

export function terminalOptions(): TerminalOptions {
  const candidates = new Set<string>();
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) candidates.add(fromEnv);
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split(/\r?\n/)) {
      const shell = line.trim();
      if (shell && !shell.startsWith('#')) candidates.add(shell);
    }
  } catch {
    // Minimal containers may not have /etc/shells; known fallbacks follow.
  }
  for (const candidate of [
    '/bin/zsh', '/bin/bash', '/bin/sh',
    '/opt/homebrew/bin/fish', '/opt/homebrew/bin/nu',
    '/usr/local/bin/fish', '/usr/local/bin/nu',
  ]) {
    candidates.add(candidate);
  }

  const shells = [...candidates]
    .filter(isExecutableShell)
    .sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b))
    .map(path => ({ path, label: basename(path) }));
  return {
    system_shell: resolveSystemShell(),
    shells,
  };
}

export function isAvailableTerminalShell(candidate: string): boolean {
  const normalized = candidate.trim();
  return terminalOptions().shells.some(shell => shell.path === normalized);
}

function resolveShell(override?: string): string {
  if (override && override.trim().length > 0) {
    const normalized = override.trim();
    if (!isAvailableTerminalShell(normalized)) {
      throw new Error(`Terminal shell is not available: ${normalized}`);
    }
    return normalized;
  }
  return resolveSystemShell();
}

function resolveSystemShell(): string {
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv && isExecutableShell(fromEnv)) return fromEnv;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (isExecutableShell(candidate)) return candidate;
  }
  // Last resort — let the OS error out if even /bin/sh is missing.
  return '/bin/sh';
}

function isExecutableShell(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveCwd(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return homedir();
}
