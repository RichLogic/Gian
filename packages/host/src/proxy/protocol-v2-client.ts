import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  HostProtocolValidator,
  NdjsonLineDecoder,
  PROTOCOL_NAME,
  RUNTIME_BOOTSTRAP_ENV,
  RUNTIME_BOOTSTRAP_VALUE,
  SUPPORTED_PROTOCOL_VERSIONS,
  ProxyProtocolError,
  signNativeSessionHostBinding,
  jsonRpcErrorObjectSchema,
  type DomainCode,
  type InitializeResult,
  type ProxyMethod,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import {
  createProxyProcessShutdownState,
  shutdownProxyProcess,
  waitForProcessGroupEmpty,
} from './process-shutdown.js';
import { redactSensitiveText } from '../logging/redact.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function proxyChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  override: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...inherited, ...override };
  for (const key of Object.keys(result)) {
    if (key.startsWith('GIAN_TOOL_')) delete result[key];
  }
  return result;
}

export interface ProtocolV2ClientOptions {
  entry: string;
  pluginId: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  dataDir: string;
  hostVersion: string;
  locale?: string;
  runtimeBin?: string;
  nodeBin?: string;
  env?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
  shutdownProcess?: typeof shutdownProxyProcess;
  /** Pinned launch offers only these versions. Omitted keeps the Host default. */
  protocolVersions?: readonly string[];
  /** Host-controlled no-Runtime bootstrap. Never set on a real Session. */
  runtimeBootstrap?: boolean;
}

function offeredProtocolVersions(options: ProtocolV2ClientOptions): string[] {
  return options.protocolVersions && options.protocolVersions.length > 0
    ? [...options.protocolVersions]
    : [...SUPPORTED_PROTOCOL_VERSIONS];
}

/** Generic, vendor-neutral client for the gian.proxy/2.x JSON-RPC stdio contract. */
export class ProtocolV2Client {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly validator: HostProtocolValidator;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<(value: ProxyNotification) => void>();
  private readonly sessionFaultHandlers = new Set<(error: ProxyProtocolError) => void>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private readonly log: (message: string) => void;
  private readonly shutdownProcess: typeof shutdownProxyProcess;
  private readonly shutdownState = createProxyProcessShutdownState();
  private readonly stdoutDecoder = new NdjsonLineDecoder();
  private nextId = 1;
  private exited = false;
  private exitNotified = false;
  private exitCode: number | null | undefined;
  private connectionError: Error | null = null;
  private initializePromise: Promise<InitializeResult> | null = null;
  private processGroupCleanup: Promise<void> | null = null;
  private readonly hostBindingKey = randomBytes(32).toString('base64url');

  constructor(private readonly options: ProtocolV2ClientOptions) {
    const log = options.log ?? (() => {});
    this.log = (message) => log(redactSensitiveText(message));
    this.shutdownProcess = options.shutdownProcess ?? shutdownProxyProcess;
    this.validator = new HostProtocolValidator({
      pluginId: options.pluginId,
      pluginVersion: options.pluginVersion,
      processScope: options.processScope,
    });
    const childEnv: NodeJS.ProcessEnv = {
      ...proxyChildEnvironment(process.env, options.env),
      GIAN_PLUGIN_ID: options.pluginId,
      GIAN_PLUGIN_DATA_DIR: options.dataDir,
      GIAN_HOST_BINDING_KEY: this.hostBindingKey,
      GIAN_PROTOCOL_VERSIONS: offeredProtocolVersions(options).join(','),
    };
    if (options.runtimeBootstrap) {
      childEnv[RUNTIME_BOOTSTRAP_ENV] = RUNTIME_BOOTSTRAP_VALUE;
      delete childEnv.GIAN_RUNTIME_BIN;
    } else {
      delete childEnv[RUNTIME_BOOTSTRAP_ENV];
      if (options.runtimeBin) childEnv.GIAN_RUNTIME_BIN = options.runtimeBin;
      else delete childEnv.GIAN_RUNTIME_BIN;
    }
    this.child = spawn(options.nodeBin ?? process.execPath, [options.entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: childEnv,
    });
    this.bindStdout();
    this.bindStderr();
    this.bindLifecycle();
  }

  nativeSessionHostBindingProof(params: {
    sessionId: string;
    nativeSessionId: string;
    cwd: string;
  }): string {
    return signNativeSessionHostBinding(this.hostBindingKey, {
      pluginId: this.options.pluginId,
      ...params,
    });
  }

  isExited(): boolean {
    return this.exited;
  }

  initialize(): Promise<InitializeResult> {
    if (this.connectionError) return Promise.reject(this.connectionError);
    if (this.exited) {
      return Promise.reject(new Error(`${this.options.pluginId} Proxy already exited.`));
    }
    if (!this.initializePromise) {
      this.initializePromise = this.request<InitializeResult>('initialize', {
        protocol: {
          name: PROTOCOL_NAME,
          versions: offeredProtocolVersions(this.options),
        },
        host: {
          name: 'Gian',
          version: this.options.hostVersion,
          ...(this.options.locale ? { locale: this.options.locale } : {}),
        },
      }).then((result) => {
        if (result.plugin.version !== this.options.pluginVersion) {
          throw new ProxyProtocolError(
            'PROTOCOL_VIOLATION',
            `Handshake plugin version ${result.plugin.version} does not match manifest ${this.options.pluginVersion}.`,
            true,
          );
        }
        return result;
      }).catch((error: unknown) => {
        if (error instanceof ProxyProtocolError && error.fatal) this.failProtocol(error);
        throw error;
      });
    }
    return this.initializePromise;
  }

  async catalog(): Promise<unknown> {
    await this.initialize();
    return this.request('catalog.list', {});
  }

  /**
   * A timed-out request settles its Promise and is REMOVED from the pending
   * map; its id stays recognizable through the issued-id watermark, so a
   * late Response — no matter how late, and no matter how many requests were
   * issued in between — is ignored as expected latency instead of failing
   * the whole Host (a late response must never kill a shared Proxy that is
   * serving live sessions), while a genuinely unknown id remains fatal.
   */
  request<T>(method: ProxyMethod, params: unknown, options?: { timeoutMs?: number }): Promise<T> {
    if (this.connectionError) return Promise.reject(this.connectionError);
    if (this.exited) return Promise.reject(new Error(`${this.options.pluginId} Proxy already exited.`));
    if (options?.timeoutMs !== undefined) {
      // A timeout must be a finite positive duration; anything else would
      // silently turn into an immediate or never-firing timer.
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        return Promise.reject(new Error('timeoutMs must be a finite positive number.'));
      }
    }

    const id = `req-${this.nextId++}`;
    const payload = { jsonrpc: '2.0' as const, id, method, params };
    try {
      this.validator.registerRequest(payload);
    } catch (error) {
      return Promise.reject(error);
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) this.failConnection(error);
      });
    });
    if (options?.timeoutMs === undefined) return promise;
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      // No pending entry may survive the timeout, client or validator side.
      // A late Response is expected latency forever after: the issued-id
      // watermark below stays able to recognize it without any tombstone
      // that could overflow or expire.
      this.validator.forgetRequest(id);
      pending.reject(new ProxyProtocolError(
        'RUNTIME_UNAVAILABLE',
        `${this.options.pluginId} Proxy did not answer ${method} within ${options.timeoutMs}ms.`,
        false,
      ));
    }, options.timeoutMs);
    timer.unref?.();
    return promise.finally(() => clearTimeout(timer));
  }

  /** Parse a client-issued request id. Ids are `req-<n>` with n strictly
   *  increasing, so anything else cannot be a response to this client. */
  private parseIssuedId(id: string): number | null {
    const match = /^req-(\d+)$/.exec(id);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  /** True when `id` was actually issued by this client. Because issued ids
   *  are monotonically increasing and never reused, the watermark alone
   *  distinguishes "this client sent it and it timed out" from "never sent"
   *  — with O(1) memory, no TTL, and no capacity-driven eviction that could
   *  turn a genuinely late Response into a fatal orphan on a shared Host.
   *  An id above the watermark (or unparseable) is by definition not a
   *  response to a request this client made and stays fatal. */
  private isKnownIssuedId(id: string): boolean {
    const n = this.parseIssuedId(id);
    return n !== null && n < this.nextId;
  }

  onNotification(handler: (value: ProxyNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onSessionFault(handler: (error: ProxyProtocolError) => void): () => void {
    this.sessionFaultHandlers.add(handler);
    return () => this.sessionFaultHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    if (this.exitNotified) {
      const code = this.exitCode ?? null;
      let active = true;
      queueMicrotask(() => { if (active) handler(code); });
      return () => { active = false; };
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async shutdown(): Promise<void> {
    await this.cleanupProcessGroup(() => this.request('shutdown', {}));
  }

  forceKill(): void {
    if (!this.shutdownState.beginEscalation()) return;
    const pid = this.child.pid;
    if (pid !== undefined && process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already absent */ }
    }
    try { this.child.kill('SIGKILL'); } catch { /* already exited */ }
  }

  async waitUntilProcessGroupEmpty(timeoutMs = 5_000): Promise<void> {
    if (this.shutdownState.absenceObserved) return;
    const pid = this.child.pid;
    if (pid === undefined || pid <= 0 || process.platform === 'win32') {
      const deadline = Date.now() + timeoutMs;
      while (!this.exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!this.exited) {
        throw new Error(`${this.options.pluginId} Proxy did not exit after ${timeoutMs}ms.`);
      }
      this.shutdownState.observeAbsence();
      return;
    }
    await waitForProcessGroupEmpty(pid, timeoutMs);
    this.shutdownState.observeAbsence();
  }

  processGroupId(): number {
    const pid = this.child.pid;
    if (pid === undefined || pid <= 0) {
      throw new Error(`${this.options.pluginId} Proxy process group is unavailable.`);
    }
    return pid;
  }

  observeProcessGroupAbsence(): void {
    this.shutdownState.observeAbsence();
  }

  private bindStdout(): void {
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.connectionError) return;
      try {
        for (const line of this.stdoutDecoder.push(chunk)) {
          this.dispatchLine(line);
          if (this.connectionError) return;
        }
      } catch (error) {
        this.handleAcceptError(error);
      }
    });
  }

  private bindStderr(): void {
    const lines = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim()) this.log(`[${this.options.pluginId}-proxy:stderr] ${line}`);
    });
  }

  private bindLifecycle(): void {
    this.child.once('error', (error) => this.failConnection(error));
    this.child.stdin.on('error', (error) => this.failConnection(error));
    this.child.once('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
      this.rejectPending(
        this.connectionError ?? new Error(`${this.options.pluginId} Proxy exited (code=${code ?? 'null'}).`),
      );
      void this.cleanupProcessGroup()
        .then(() => this.notifyExit(code))
        .catch((error) => this.log(
          `[${this.options.pluginId}-proxy] process-group cleanup failed: ${String(error)}`,
        ));
    });
  }

  private dispatchLine(line: string): void {
    let accepted: import('@gian/proxy-protocol').ProxyNotification
      | { id: string; result?: unknown; error?: unknown }
      | null = null;
    try {
      accepted = this.validator.acceptLine(line);
      if (accepted === null) return;
      if (!('id' in accepted)) {
        for (const handler of this.notificationHandlers) {
          try { handler(accepted); } catch (error) {
            this.log(`[${this.options.pluginId}-proxy] notification handler threw: ${String(error)}`);
          }
        }
        return;
      }

      if (typeof accepted.id !== 'string') {
        throw new ProxyProtocolError(
          'PROTOCOL_VIOLATION',
          `Unexpected response id ${String(accepted.id)}.`,
          true,
        );
      }
      const pending = this.pending.get(accepted.id);
      if (!pending) {
        if (this.isKnownIssuedId(accepted.id)) {
          // The request was settled (usually by its timeout) and this
          // Response arrived late; it is expected latency and must not kill
          // the (possibly shared) Proxy. The issued-id watermark keeps this
          // true no matter how late or how many other requests followed.
          this.log(
            `[${this.options.pluginId}-proxy] ignored late response ${accepted.id} after request timeout`,
          );
          return;
        }
        throw new ProxyProtocolError(
          'PROTOCOL_VIOLATION',
          `Response id ${accepted.id} has no client request.`,
          true,
        );
      }
      this.pending.delete(accepted.id);
      if (accepted.error !== undefined) {
        pending.reject(this.asRequestError(accepted.error));
      } else {
        pending.resolve(accepted.result);
      }
    } catch (error) {
      this.handleAcceptError(error, line);
    }
  }

  private asRequestError(value: unknown): ProxyProtocolError {
    const parsed = jsonRpcErrorObjectSchema.safeParse(value);
    if (!parsed.success) {
      return new ProxyProtocolError('PROTOCOL_VIOLATION', 'Invalid JSON-RPC error object.', false);
    }
    const data = parsed.data.data;
    const domainCode = data && typeof data === 'object' && !Array.isArray(data)
      && typeof (data as { domainCode?: unknown }).domainCode === 'string'
      ? (data as { domainCode: DomainCode }).domainCode
      : 'INTERNAL';
    return new ProxyProtocolError(domainCode, `[${domainCode}] ${parsed.data.message}`, false);
  }

  private handleAcceptError(error: unknown, line?: string): void {
    const protocolError = error instanceof ProxyProtocolError
      ? error
      : new ProxyProtocolError('PROTOCOL_VIOLATION', String(error), true);
    if (protocolError.faultClass === 'session') {
      this.notifySessionFault(protocolError);
      return;
    }
    if (protocolError.faultClass === 'request') {
      // A request-class failure (e.g. a malformed customization.list Result)
      // rejects exactly that pending request and keeps the Host process
      // alive — live sessions must never be taken down by a listing reply.
      if (line) {
        try {
          const id = (JSON.parse(line) as { id?: unknown }).id;
          if (typeof id === 'string') {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              pending.reject(protocolError);
            }
          }
        } catch {
          /* unparseable line: nothing to reject */
        }
      }
      this.log(`[${this.options.pluginId}-proxy] request failure: ${protocolError.message}`);
      return;
    }
    // A late Response for a timed-out request is expected latency. The
    // validator may report it as an orphan (its pending entry was removed on
    // timeout); the issued-id watermark turns that report into a log line
    // instead of killing a shared Proxy that is serving live sessions — and
    // stays correct for arbitrarily late responses (no TTL, no capacity
    // eviction), while a genuinely unknown id remains fatal.
    if (line && protocolError.message.includes('has no pending request')) {
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id === 'string' && this.isKnownIssuedId(id)) {
          this.log(`[${this.options.pluginId}-proxy] ignored late response ${id} after request timeout`);
          return;
        }
      } catch {
        /* unparseable line: nothing to match */
      }
    }
    this.failProtocol(protocolError);
  }

  private notifySessionFault(error: ProxyProtocolError): void {
    this.log(`[${this.options.pluginId}-proxy] session protocol fault: ${error.message}`);
    for (const handler of this.sessionFaultHandlers) {
      try { handler(error); } catch (handlerError) {
        this.log(`[${this.options.pluginId}-proxy] session-fault handler threw: ${String(handlerError)}`);
      }
    }
  }

  private failProtocol(error: ProxyProtocolError): void {
    if (this.connectionError) return;
    this.connectionError = error;
    this.log(`[${this.options.pluginId}-proxy] protocol failure: ${error.message}`);
    this.rejectPending(error);
    this.forceKill();
  }

  private failConnection(error: Error): void {
    if (this.connectionError) return;
    this.connectionError = error;
    this.rejectPending(error);
    this.forceKill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private cleanupProcessGroup(
    requestShutdown?: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.processGroupCleanup) {
      const cleanup = this.shutdownProcess({
        child: this.child,
        isExited: () => this.exited,
        ...(requestShutdown ? { requestShutdown } : {}),
        label: `${this.options.pluginId} Proxy`,
        state: this.shutdownState,
      });
      this.processGroupCleanup = cleanup;
      void cleanup.catch(() => {
        if (this.processGroupCleanup === cleanup) this.processGroupCleanup = null;
      });
    }
    return this.processGroupCleanup;
  }

  private notifyExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    for (const handler of this.exitHandlers) {
      try { handler(code); } catch (error) {
        this.log(`[${this.options.pluginId}-proxy] exit handler threw: ${String(error)}`);
      }
    }
  }
}
