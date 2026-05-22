import { TtyCodexRuntime } from '../runtime/tty-codex-runtime.js';

/** Sink used to forward runtime events as JSON-RPC notifications back to
 *  the host. Same shape as the structured service's emitEvent. */
type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

export interface TtyServiceOptions {
  runtime?: TtyCodexRuntime;
  emitEvent?: ProxyEventSink;
  /** Override the codex binary path. Same `--codex-bin` value the
   *  structured `CodexAppServerClient` uses; passed through to
   *  `TtyCodexRuntime` so structured and CLI modes always invoke the
   *  same binary. Ignored when `runtime` is also provided (caller is
   *  responsible for wiring it on the injected runtime). */
  codexBin?: string | null;
}

/**
 * Parameters for `tty.start`. Note the deliberate three-id discipline:
 *
 *   - `gianSessionId`  — host-side session id; the runtime's Map key,
 *                        and what host broadcasts on the WS as
 *                        `pty:output { session_id: ... }`.
 *   - `proxySessionId` — codex-proxy-side session id
 *                        (`SessionRecord.id`, e.g. `sess_xxx`). Used as
 *                        the notification routing key on the JSON-RPC
 *                        wire (`params.sessionId`). **Distinct from
 *                        `codexThreadId`** — codex-proxy mints
 *                        `sess_xxx` ids in its internal session table
 *                        and the thread UUID travels separately.
 *   - `codexThreadId`  — UUID passed positionally to `codex resume`.
 *                        Caller (host) is responsible for ensuring this
 *                        thread already exists on disk (via the existing
 *                        `thread/start` path); the runtime does no
 *                        minting.
 */
export interface TtyStartParams {
  gianSessionId: string;
  proxySessionId: string;
  codexThreadId: string;
  cwd: string;
  cols: number;
  rows: number;
  model?: string | null;
}

export interface TtyInputParams {
  gianSessionId: string;
  /** Base64-encoded raw bytes for live keystrokes. */
  data?: string;
  /** UTF-8 text wrapped in bracketed-paste + CR before being written
   *  to stdin. Mutually exclusive with `data`. Currently unused by the
   *  host (CLI-mode `message:send` is rejected — see spec §3.4) but
   *  kept on the wire so a future paste bridge has the hook ready. */
  text?: string;
}

export interface TtyResizeParams {
  gianSessionId: string;
  cols: number;
  rows: number;
}

export interface TtyKillParams {
  gianSessionId: string;
}

export interface TtyReplayParams {
  gianSessionId: string;
}

/**
 * Parallel service for the Codex TTY runtime. Lives next to
 * `CodexProxyService` and routes `tty.*` JSON-RPC methods to the
 * underlying PTY runtime.
 *
 * Kept deliberately separate from the structured service so the
 * existing codex app-server path stays untouched — runtime mode
 * switching is just a host-side decision about which method family to
 * call.
 *
 * Mirror of `packages/proxies/cc-proxy/src/core/tty-service.ts`. The
 * shape divergence is the dual-id payload: cc-proxy doesn't need to
 * split `sessionId` because cc-proxy is per-session (one process per
 * Gian session); codex-proxy is shared, so `proxySessionId` is the
 * notification routing key while `gianSessionId` is the broadcast key
 * host needs.
 */
export class TtyCodexService {
  private readonly runtime: TtyCodexRuntime;
  private emitEvent: ProxyEventSink;

  constructor(opts: TtyServiceOptions = {}) {
    this.runtime = opts.runtime
      ?? new TtyCodexRuntime(opts.codexBin ? { codexBin: opts.codexBin } : {});
    this.emitEvent = opts.emitEvent ?? (() => undefined);

    this.runtime.on('output', (gianSessionId, proxySessionId, chunk) => {
      this.emitEvent('tty.output', {
        sessionId: proxySessionId,
        gianSessionId,
        data: chunk.toString('base64'),
      });
    });
    this.runtime.on('exited', (gianSessionId, proxySessionId, code, signal) => {
      this.emitEvent('tty.exited', {
        sessionId: proxySessionId,
        gianSessionId,
        code,
        signal,
      });
    });
    this.runtime.on('debug', (message) => {
      this.emitEvent('debug', { message });
    });
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  async start(params: TtyStartParams): Promise<{ ok: true; replay: string[]; alive: boolean }> {
    requireString(params.gianSessionId, 'gianSessionId');
    requireString(params.proxySessionId, 'proxySessionId');
    requireString(params.codexThreadId, 'codexThreadId');
    requireString(params.cwd, 'cwd');
    if (!Number.isFinite(params.cols) || !Number.isFinite(params.rows)) {
      throw new Error('cols and rows are required');
    }
    await this.runtime.spawnSession({
      gianSessionId: params.gianSessionId,
      proxySessionId: params.proxySessionId,
      codexThreadId: params.codexThreadId,
      cwd: params.cwd,
      model: params.model ?? null,
      cols: Math.max(1, Math.floor(params.cols)),
      rows: Math.max(1, Math.floor(params.rows)),
    });
    return {
      ok: true,
      replay: this.runtime.snapshotBase64(params.gianSessionId),
      alive: this.runtime.isSessionAlive(params.gianSessionId),
    };
  }

  input(params: TtyInputParams): { ok: true } {
    requireString(params.gianSessionId, 'gianSessionId');
    if (typeof params.text === 'string') {
      this.runtime.pasteMessage(params.gianSessionId, params.text);
    } else if (typeof params.data === 'string') {
      this.runtime.writeBytes(params.gianSessionId, params.data);
    }
    return { ok: true };
  }

  resize(params: TtyResizeParams): { ok: true } {
    requireString(params.gianSessionId, 'gianSessionId');
    this.runtime.resize(params.gianSessionId, params.cols, params.rows);
    return { ok: true };
  }

  replay(params: TtyReplayParams): { chunks: string[]; alive: boolean } {
    requireString(params.gianSessionId, 'gianSessionId');
    return {
      chunks: this.runtime.snapshotBase64(params.gianSessionId),
      alive: this.runtime.isSessionAlive(params.gianSessionId),
    };
  }

  async kill(params: TtyKillParams): Promise<{ ok: true }> {
    requireString(params.gianSessionId, 'gianSessionId');
    await this.runtime.removeSession(params.gianSessionId);
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
