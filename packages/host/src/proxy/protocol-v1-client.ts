import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  HostProtocolValidator,
  NdjsonLineDecoder,
  PROTOCOL_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  ProxyProtocolError,
  protocolErrorSchema,
  type InitializeResult,
  type ProxyMethod,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import {
  createProxyProcessShutdownState,
  shutdownProxyProcess,
} from './process-shutdown.js';
import { redactSensitiveText } from '../logging/redact.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface ProtocolV1ClientOptions {
  entry: string;
  pluginId: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  dataDir: string;
  hostVersion: string;
  runtimeBin?: string;
  nodeBin?: string;
  env?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
  shutdownProcess?: typeof shutdownProxyProcess;
}

/** Generic, vendor-neutral client for the gian.proxy/1 stdio contract. */
export class ProtocolV1Client {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly validator: HostProtocolValidator;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(value: ProxyNotification) => void>();
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

  constructor(private readonly options: ProtocolV1ClientOptions) {
    const log = options.log ?? (() => {});
    this.log = message => log(redactSensitiveText(message));
    this.shutdownProcess = options.shutdownProcess ?? shutdownProxyProcess;
    this.validator = new HostProtocolValidator({
      pluginId: options.pluginId,
      processScope: options.processScope,
    });
    this.child = spawn(options.nodeBin ?? process.execPath, [options.entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        ...options.env,
        GIAN_PLUGIN_ID: options.pluginId,
        GIAN_PLUGIN_DATA_DIR: options.dataDir,
        ...(options.runtimeBin ? { GIAN_RUNTIME_BIN: options.runtimeBin } : {}),
        GIAN_PROTOCOL_VERSIONS: SUPPORTED_PROTOCOL_VERSIONS.join(','),
      },
    });
    this.bindStdout();
    this.bindStderr();
    this.bindLifecycle();
  }

  isExited(): boolean {
    return this.exited;
  }

  initialize(): Promise<InitializeResult> {
    if (!this.initializePromise) {
      this.initializePromise = this.request<InitializeResult>('initialize', {
        protocol: {
          name: PROTOCOL_NAME,
          versions: [...SUPPORTED_PROTOCOL_VERSIONS],
        },
        host: { name: 'Gian', version: this.options.hostVersion },
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

  request<T>(method: ProxyMethod, params: unknown): Promise<T> {
    if (this.connectionError) return Promise.reject(this.connectionError);
    if (this.exited) return Promise.reject(new Error(`${this.options.pluginId} Proxy already exited.`));

    const id = this.nextId++;
    const payload = { id, method, params };
    try {
      this.validator.registerRequest(payload);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) this.failConnection(error);
      });
    });
  }

  onNotification(handler: (value: ProxyNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
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
        this.failProtocol(error instanceof ProxyProtocolError
          ? error
          : new ProxyProtocolError('PROTOCOL_VIOLATION', String(error), true));
      }
    });
  }

  private bindStderr(): void {
    const lines = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    lines.on('line', line => {
      if (line.trim()) this.log(`[${this.options.pluginId}-proxy:stderr] ${line}`);
    });
  }

  private bindLifecycle(): void {
    this.child.once('error', error => this.failConnection(error));
    this.child.stdin.on('error', error => this.failConnection(error));
    this.child.once('exit', code => {
      this.exited = true;
      this.exitCode = code;
      this.rejectPending(
        this.connectionError ?? new Error(`${this.options.pluginId} Proxy exited (code=${code ?? 'null'}).`),
      );
      void this.cleanupProcessGroup()
        .then(() => this.notifyExit(code))
        .catch(error => this.log(
          `[${this.options.pluginId}-proxy] process-group cleanup failed: ${String(error)}`,
        ));
    });
  }

  private dispatchLine(line: string): void {
    try {
      const accepted = this.validator.acceptLine(line);
      if (accepted === null) return;
      if (!('id' in accepted)) {
        for (const handler of this.notificationHandlers) {
          try { handler(accepted); } catch (error) {
            this.log(`[${this.options.pluginId}-proxy] notification handler threw: ${String(error)}`);
          }
        }
        return;
      }

      if (typeof accepted.id !== 'number') {
        throw new ProxyProtocolError(
          'PROTOCOL_VIOLATION',
          `Unexpected response id ${String(accepted.id)}.`,
          true,
        );
      }
      const pending = this.pending.get(accepted.id);
      if (!pending) {
        throw new ProxyProtocolError(
          'PROTOCOL_VIOLATION',
          `Response id ${accepted.id} has no client request.`,
          true,
        );
      }
      this.pending.delete(accepted.id);
      if (accepted.error !== undefined) {
        const error = protocolErrorSchema.parse(accepted.error);
        pending.reject(new ProxyProtocolError(
          error.code,
          `[${error.code}] ${error.message}`,
          false,
        ));
      } else {
        pending.resolve(accepted.result);
      }
    } catch (error) {
      this.failProtocol(error instanceof ProxyProtocolError
        ? error
        : new ProxyProtocolError('PROTOCOL_VIOLATION', String(error), true));
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
