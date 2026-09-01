/**
 * ZCode Protocol v1 inner transport (WP0-frozen facts, evidence/wp0).
 *
 * - NDJSON over stdio; envelopes are `{id, method, params}` — no `jsonrpc` key.
 * - Responses are `{id, result}` or `{id, error:{code, data?, message}}`.
 * - Notifications are `{method, params}`.
 * - The server sends REVERSE REQUESTS `{id:"server-N", method, params}`; the
 *   client must answer on the same id. Unknown reverse methods get an explicit
 *   method-not-supported error so the server never hangs on us.
 *
 * Hardening required by the Revision 2 contract §8.1: byte-oriented line
 * framing with a max line limit, UTF-8 validation, per-request timeouts,
 * late-response tombstones, redacted stderr, and process-exit fanout.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const MAX_INNER_LINE_BYTES = 16 * 1024 * 1024;

export interface InnerErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class InnerError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: InnerErrorShape) {
    super(typeof error.message === 'string' ? redactSecrets(error.message) as string : 'inner error');
    this.name = 'InnerError';
    this.code = error.code;
    this.data = error.data === undefined ? undefined : redactSecrets(error.data);
  }
}

export interface ReverseRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ReverseHandler = (
  params: Record<string, unknown>,
  /** Transport-level server request id; needed to answer later on defer. */
  transportId: string,
) => { result: unknown } | { error: InnerErrorShape } | { defer: true };

export interface InnerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface TransportOptions {
  /** Module path of the ZCode CLI entry (zcode.cjs or a fake test server). */
  runtimeBin: string;
  /** Working directory handed to `app-server --cwd`. */
  cwd: string;
  /** Node executable; defaults to the running interpreter. */
  nodeBin?: string;
  requestTimeoutMs?: number;
  /** Extra spawn args before `app-server` (test seams). */
  extraArgs?: string[];
  /** Production uses the same protocol surface as ZCode Desktop. */
  launchMode?: 'desktop-stdio' | 'legacy-cwd';
  /** Environment allowlist for the child (Revision 2 §4.3). */
  env?: {
    home: string;
    path: string;
    tmpdir: string;
    lang?: string;
    gian?: Readonly<Record<string, string>>;
  };
}

/** Deterministic redaction for anything that might reach logs or errors. */
const SECRET_KEY = /api[-_]?key|token|authorization|secret|cookie|password|credential/i;
/** Inline `key=value` / `key: value` secrets inside free text (stderr lines,
 *  error messages). */
const SECRET_PAIR = new RegExp(
  "([A-Za-z_-]*(?:api[-_]?key|token|authorization|secret|cookie|password|credential)[A-Za-z_-]*)([\\\"']?\\s*[=:]\\s*[\\\"']?)(\\S+)",
  'gi',
);
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth]';
  if (typeof value === 'string') {
    return value.replace(SECRET_PAIR, (_match: string, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1);
    }
    return out;
  }
  return value;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface InnerRuntimeFailure {
  kind: 'provider-business-error';
  providerCode: string;
  domainCode: 'RUNTIME_ERROR';
  message: string;
  retryable: boolean;
}

/** ZCode 0.16.5 reports asynchronous provider rejection only on stderr and
 * emits no terminal protocol event. Parse the bounded typed prefix without
 * retaining provider text, request ids, headers, or response bodies. */
export function parseInnerRuntimeFailure(line: string): InnerRuntimeFailure | null {
  const match = line.match(/ProviderBusinessError:\s*\[([0-9A-Za-z_-]{1,64})\]/);
  if (!match) return null;
  const providerCode = match[1]!;
  return {
    kind: 'provider-business-error',
    providerCode,
    domainCode: 'RUNTIME_ERROR',
    message: providerCode === '1113'
      ? 'ZCode provider rejected the turn because the account has no available resource package.'
      : `ZCode provider rejected the turn (code ${providerCode}).`,
    retryable: false,
  };
}

/**
 * One ZCode app-server child. Requests are serialized through a monotonically
 * increasing numeric id; every request must resolve exactly once.
 */
export class ZCodeTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lateResponses = new Set<string>();
  private nextId = 1;
  private readonly reverseHandlers = new Map<string, ReverseHandler>();
  private buffer = '';
  private stderrBuffer = '';
  private readonly seenRuntimeFailures = new Set<string>();
  private exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;

  constructor(private readonly options: TransportOptions) {
    super();
    this.setMaxListeners(0);
  }

  /** Register a reverse-request handler. MUST happen before spawn so the
   *  server never sees an unanswered request during startup (contract §15.1). */
  registerReverseHandler(method: string, handler: ReverseHandler): void {
    this.reverseHandlers.set(method, handler);
  }

  /** Spawn the app-server child. Handlers must already be registered. */
  start(): void {
    if (this.child) throw new Error('ZCode transport already started.');
    const env: NodeJS.ProcessEnv = {
      HOME: this.options.env?.home ?? process.env.HOME ?? '',
      PATH: this.options.env?.path ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: this.options.env?.tmpdir ?? '/tmp',
      ...(this.options.env?.lang ? { LANG: this.options.env.lang } : {}),
      ...(this.options.env?.gian ?? {}),
    };
    const launchArgs = this.options.launchMode === 'legacy-cwd'
      ? ['app-server', '--cwd', this.options.cwd]
      : ['app-server', '--stdio', '--surface', 'desktop'];
    this.child = spawn(
      this.options.nodeBin ?? process.execPath,
      [
        ...this.options.extraArgs ?? [],
        this.options.runtimeBin,
        ...launchArgs,
      ],
      { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));
    this.child.once('exit', (code, signal) => {
      this.flushStderr();
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      const error = new InnerError({
        code: -32603,
        message: `app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
      });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit('exit', code, signal);
    });
    this.child.stdin.on('error', (error) => this.emit('error', error));
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const index = this.stderrBuffer.indexOf('\n');
      if (index < 0) {
        if (this.stderrBuffer.length > 8_000) this.flushStderr();
        return;
      }
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      this.handleStderrLine(line);
    }
  }

  private flushStderr(): void {
    if (this.stderrBuffer.length === 0) return;
    const line = this.stderrBuffer;
    this.stderrBuffer = '';
    this.handleStderrLine(line);
  }

  private handleStderrLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    this.emit('stderr', redactSecrets(line.slice(0, 4_000)));
    const failure = parseInnerRuntimeFailure(line);
    if (failure === null) return;
    const fingerprint = `${failure.kind}:${failure.providerCode}`;
    if (this.seenRuntimeFailures.has(fingerprint)) return;
    this.seenRuntimeFailures.add(fingerprint);
    this.emit('runtime-failure', failure);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_INNER_LINE_BYTES) {
          this.fail(new InnerError({ code: -32600, message: 'Inner NDJSON line limit exceeded.' }));
        }
        return;
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // Malformed envelope inside the stream: bounded diagnostic, never fatal
      // unless it saturates the line limit (contract §8.1).
      this.emit('diagnostic', { kind: 'unparseable-line' });
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.emit('diagnostic', { kind: 'invalid-envelope' });
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.method === 'string' && typeof record.id === 'string') {
      this.handleReverseRequest({
        id: record.id,
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (typeof record.method === 'string' && record.id === undefined) {
      this.emit('notification', {
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      } satisfies InnerNotification);
      return;
    }
    if (typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (!pending) {
        // Late response after timeout: tombstone it (never resolve twice).
        this.lateResponses.add(record.id);
        if (this.lateResponses.size > 1_000) this.lateResponses.clear();
        this.emit('diagnostic', { kind: 'late-response', id: record.id });
        return;
      }
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.error !== undefined && record.error !== null) {
        const error = record.error as Record<string, unknown>;
        pending.reject(new InnerError({
          code: typeof error.code === 'number' ? error.code : -32603,
          message: typeof error.message === 'string' ? error.message : 'inner error',
          data: error.data,
        }));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    this.emit('diagnostic', { kind: 'unroutable-envelope' });
  }

  private handleReverseRequest(request: ReverseRequest): void {
    const handler = this.reverseHandlers.get(request.method);
    if (handler !== undefined) {
      const answer = handler(request.params, request.id);
      // Deferred answers (e.g. permission prompts) are sent later via
      // respondToServer once the Gian user has acted.
      if ('defer' in answer && answer.defer === true) return;
      if ('error' in answer && answer.error !== undefined) {
        this.write({ id: request.id, error: answer.error });
        return;
      }
      this.write({ id: request.id, result: (answer as { result: unknown }).result ?? {} });
      return;
    }
    this.write({
      id: request.id,
      error: { code: -32601, message: `Method not supported by client: ${request.method}` },
    });
  }

  private write(envelope: Record<string, unknown>): void {
    if (!this.child || this.exited) {
      throw new InnerError({ code: -32603, message: 'app-server stdin is closed.' });
    }
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  /** Answer a server reverse request by its id (interaction.respond path). */
  respondToServer(serverRequestId: string, answer: { result?: unknown; error?: Record<string, unknown> }): void {
    this.write({
      id: serverRequestId,
      ...(answer.error !== undefined ? { error: answer.error } : { result: answer.result ?? {} }),
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new InnerError({ code: -32603, message: 'app-server has exited.' }));
    }
    const id = `g${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Tombstone: the pending entry is dropped BEFORE the timeout fires any
        // late response, so a duplicate resolution is impossible.
        this.pending.delete(id);
        reject(new InnerError({
          code: -32603,
          message: `Inner request ${method} timed out after ${timeoutMs ?? this.options.requestTimeoutMs ?? 30_000}ms.`,
        }));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof InnerError ? error : new InnerError({ code: -32603, message: String(error) }));
      }
    });
  }

  private fail(error: InnerError): void {
    this.emit('error', error);
    this.child?.kill('SIGKILL');
  }

  isExited(): boolean {
    return this.exited;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** WP0-frozen Gian runtime preference profile (Revision 2 §4.4). */
export const GIAN_RUNTIME_PREFERENCES = {
  materialization: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
  },
  userExecution: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
    integratedTerminalShell: { mode: 'auto' },
  },
} as const;

/** Register the standard Gian reverse-request handlers on a transport. */
export function registerGianReverseHandlers(transport: ZCodeTransport): void {
  transport.registerReverseHandler('session/requestRuntimePreferences', (params) => ({
    result: params.scope === 'user-execution'
      ? GIAN_RUNTIME_PREFERENCES.userExecution
      : GIAN_RUNTIME_PREFERENCES.materialization,
  }));
  transport.registerReverseHandler('interaction/requestOfficialMcpAuthHeaders', () => ({
    error: {
      code: -32603,
      data: { reason: 'official_auth_unavailable' },
      message: 'Gian does not provide official MCP auth headers.',
    },
  }));
}
