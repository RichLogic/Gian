import { TtyClaudeRuntime } from '../runtime/tty-claude-runtime.js';
import type { PermissionMode } from './types.js';

/** Sink used to forward runtime events as JSON-RPC notifications back to
 *  the host. Same shape as the structured service's emitEvent. */
type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

export interface TtyServiceOptions {
  runtime?: TtyClaudeRuntime;
  emitEvent?: ProxyEventSink;
}

export interface TtyStartParams {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  isResume: boolean;
  cols: number;
  rows: number;
  model?: string | null;
  /** Claude CLI `--permission-mode` value. Passed through verbatim after
   *  validation; null/undefined keeps Claude's default. */
  permissionMode?: PermissionMode | null;
  /** Pre-rendered `settings.json` content the host wants this spawn to
   *  use (hooks block + allowedHttpHookUrls). The proxy writes it to a
   *  tmp file and passes `--settings <path>` to claude. */
  hookSettings?: Record<string, unknown> | null;
  /** Extra CLI args appended after the standard ones. Host owns this
   *  list; current use is `['--remote-control']`. */
  extraArgs?: string[];
}

export interface TtyInputParams {
  sessionId: string;
  /** Base64-encoded raw bytes for live keystrokes. */
  data?: string;
  /** UTF-8 text to wrap in a bracketed paste sequence and send as a
   *  full message. `data` and `text` are mutually exclusive — when both
   *  are present, `text` wins (paste-then-newline semantics). */
  text?: string;
}

export interface TtyResizeParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TtyKillParams {
  sessionId: string;
}

export interface TtyReplayParams {
  sessionId: string;
}

/**
 * Parallel service for the TTY runtime. Lives next to `CcProxyService`
 * and routes `tty.*` JSON-RPC methods to the underlying PTY runtime.
 *
 * Kept deliberately separate from the structured service so the existing
 * `claude -p` path stays untouched — runtime mode switching is just a
 * host-side decision about which method family to call.
 */
export class TtyClaudeService {
  private readonly runtime: TtyClaudeRuntime;
  private emitEvent: ProxyEventSink;

  constructor(opts: TtyServiceOptions = {}) {
    this.runtime = opts.runtime ?? new TtyClaudeRuntime();
    this.emitEvent = opts.emitEvent ?? (() => undefined);

    this.runtime.on('output', (sessionId, chunk) => {
      this.emitEvent('tty.output', {
        sessionId,
        data: chunk.toString('base64'),
      });
    });
    this.runtime.on('exited', (sessionId, code, signal) => {
      this.emitEvent('tty.exited', { sessionId, code, signal });
    });
    this.runtime.on('debug', (message) => {
      this.emitEvent('debug', { message });
    });
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  async start(params: TtyStartParams): Promise<{ ok: true; replay: string[]; alive: boolean }> {
    requireString(params.sessionId, 'sessionId');
    requireString(params.claudeSessionId, 'claudeSessionId');
    requireString(params.cwd, 'cwd');
    if (!Number.isFinite(params.cols) || !Number.isFinite(params.rows)) {
      throw new Error('cols and rows are required');
    }
    const extraArgs = Array.isArray(params.extraArgs)
      ? params.extraArgs.filter(a => typeof a === 'string')
      : null;
    const permissionMode = normalizePermissionMode(params.permissionMode);
    await this.runtime.spawnSession({
      sessionId: params.sessionId,
      claudeSessionId: params.claudeSessionId,
      cwd: params.cwd,
      model: params.model ?? null,
      isResume: !!params.isResume,
      cols: Math.max(1, Math.floor(params.cols)),
      rows: Math.max(1, Math.floor(params.rows)),
      hookSettings: params.hookSettings ?? null,
      ...(permissionMode ? { permissionMode } : {}),
      ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
    });
    return {
      ok: true,
      replay: this.runtime.snapshotBase64(params.sessionId),
      alive: this.runtime.isSessionAlive(params.sessionId),
    };
  }

  input(params: TtyInputParams): { ok: true } {
    requireString(params.sessionId, 'sessionId');
    if (typeof params.text === 'string') {
      this.runtime.pasteMessage(params.sessionId, params.text);
    } else if (typeof params.data === 'string') {
      this.runtime.writeBytes(params.sessionId, params.data);
    }
    return { ok: true };
  }

  resize(params: TtyResizeParams): { ok: true } {
    requireString(params.sessionId, 'sessionId');
    this.runtime.resize(params.sessionId, params.cols, params.rows);
    return { ok: true };
  }

  replay(params: TtyReplayParams): { chunks: string[]; alive: boolean } {
    requireString(params.sessionId, 'sessionId');
    return {
      chunks: this.runtime.snapshotBase64(params.sessionId),
      alive: this.runtime.isSessionAlive(params.sessionId),
    };
  }

  async kill(params: TtyKillParams): Promise<{ ok: true }> {
    requireString(params.sessionId, 'sessionId');
    await this.runtime.removeSession(params.sessionId);
    return { ok: true };
  }

  async close(): Promise<void> {
    await this.runtime.stop();
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (
    value === 'plan'
    || value === 'default'
    || value === 'auto'
    || value === 'bypassPermissions'
  ) {
    return value;
  }
  return null;
}
