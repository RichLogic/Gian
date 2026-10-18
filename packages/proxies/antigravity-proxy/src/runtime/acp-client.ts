import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';

import type {
  AuthenticateRequest,
  AuthenticateResponse,
  Client,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type {
  AntigravityRuntimeClient,
  PermissionHandler,
  RuntimeStopped,
} from '../contracts.js';
import {
  AntigravityCleanupError,
  AntigravityRuntimeError,
  AntigravityTimeoutError,
  asError,
} from './errors.js';
import {
  spawnAntigravityProcess,
  type AntigravityProcessExit,
  type AntigravityProcessTransport,
} from './process-transport.js';

export const ACP_PROTOCOL_VERSION = 1;
export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_GRACEFUL_STOP_MS = 3_000;

/** Design identity until package metadata is wired by the integration owner. */
export const ANTIGRAVITY_CLIENT_INFO = {
  name: 'gian-antigravity-proxy',
  title: 'Gian Antigravity Proxy',
  version: '0.0.1',
} as const;

export interface AntigravityAcpExit extends AntigravityProcessExit {}

/**
 * One owned ACP connection. `generation` is stamped by the client.
 * `stop` reaps that connection only.
 */
export interface AntigravityAcpTransport extends AntigravityProcessTransport {
  generation: number;
}

export type AntigravityTransportFactory = (client: Client) => Promise<AntigravityProcessTransport>;

export interface AntigravityAcpClientOptions {
  binaryPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  gracefulStopMs?: number;
  transportFactory?: AntigravityTransportFactory;
}

interface ActiveCall {
  generation: number;
  reject: (error: Error) => void;
}

interface OpenSlot {
  current: AntigravityAcpTransport | null;
}

const cancelledPermission = (): RequestPermissionResponse => ({
  outcome: { outcome: 'cancelled' },
});

/**
 * Shared ACP process for one Agent binding.
 *
 * `stop()` retires the current generation and reaps its process group. It is
 * not a final dispose: a later `ensureStarted()` launches a new process.
 * Notifications, permission answers, and RPC results are delivered only for
 * the generation that still owns them. A delayed permission answer is cancelled
 * when its generation is no longer current, including while cleanup is failing.
 *
 * `startupTimeoutMs` bounds spawn and initialize together. A transport that
 * arrives after that deadline is reaped and is not installed.
 * `requestTimeoutMs` bounds ordinary RPC round-trips. On timeout the generation
 * is retired, every pending call is rejected, and the process is cleaned up.
 * The timed-out RPC is not retried. The `session/prompt` result is not under
 * that deadline; it still ends when the generation is retired or the process exits.
 *
 * Inbound and outbound NDJSON records are capped at the shared 16 MiB line limit.
 * After stdin EOF, the same `gracefulStopMs` is used for SIGTERM, then SIGKILL.
 * The final wait for leader exit and group reap uses that same budget and
 * rejects when it expires. `stop()` rejects when that cleanup fails.
 * Windows cannot signal the group and is killed by the leader handle only.
 */
export class AntigravityAcpClient implements AntigravityRuntimeClient {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly envOverlay: NodeJS.ProcessEnv | undefined;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly gracefulStopMs: number;
  private readonly transportFactory: AntigravityTransportFactory | undefined;
  private readonly emitter = new EventEmitter<{
    sessionUpdate: [SessionNotification];
    runtimeStopped: [RuntimeStopped];
  }>();
  private permissionHandler: PermissionHandler | null = null;
  private transport: AntigravityAcpTransport | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private startPromise: Promise<InitializeResponse> | null = null;
  private generationSerial = 0;
  private activeGeneration = 0;
  private readonly activeCalls: ActiveCall[] = [];
  private readonly expectedStops = new WeakSet<AntigravityAcpTransport>();
  private readonly exitReported = new WeakSet<AntigravityAcpTransport>();
  private readonly retiredGenerations = new Set<number>();
  private readonly retirement = new Map<number, Promise<void>>();
  private readonly retirementCause = new WeakMap<AntigravityAcpTransport, Error>();
  private readonly reapJobs = new WeakMap<AntigravityAcpTransport, Promise<void>>();

  constructor(options: AntigravityAcpClientOptions) {
    if (!isAbsolute(options.binaryPath) || options.binaryPath.includes('\0')) {
      throw new AntigravityRuntimeError('binaryPath must be an absolute path.');
    }
    const cwd = options.cwd ?? process.cwd();
    if (!isAbsolute(cwd) || cwd.includes('\0')) {
      throw new AntigravityRuntimeError('cwd must be an absolute path.');
    }
    this.binaryPath = options.binaryPath;
    this.cwd = cwd;
    this.envOverlay = options.env;
    this.startupTimeoutMs = positiveMs(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs');
    this.requestTimeoutMs = positiveMs(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
    this.gracefulStopMs = positiveMs(options.gracefulStopMs, DEFAULT_GRACEFUL_STOP_MS, 'gracefulStopMs');
    this.transportFactory = options.transportFactory;
  }

  get negotiated(): InitializeResponse | null {
    if (!this.transport || !this.generationIsCurrent(this.transport.generation)) return null;
    return this.initializeResponse;
  }

  setPermissionHandler(handler: PermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  on(event: 'sessionUpdate', listener: (notification: SessionNotification) => void): this;
  on(event: 'runtimeStopped', listener: (event: RuntimeStopped) => void): this;
  on(
    event: 'sessionUpdate' | 'runtimeStopped',
    listener: ((notification: SessionNotification) => void) | ((event: RuntimeStopped) => void),
  ): this {
    if (event === 'sessionUpdate') {
      this.emitter.on(event, listener as (notification: SessionNotification) => void);
    } else {
      this.emitter.on(event, listener as (event: RuntimeStopped) => void);
    }
    return this;
  }

  async ensureStarted(): Promise<InitializeResponse> {
    if (this.transport && this.initializeResponse && this.generationIsCurrent(this.transport.generation)) {
      return this.initializeResponse;
    }
    if (!this.startPromise) {
      let promise!: Promise<InitializeResponse>;
      promise = this.start().finally(() => {
        if (this.startPromise === promise) this.startPromise = null;
      });
      this.startPromise = promise;
    }
    return this.startPromise;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const transport = await this.ready();
    return this.request(transport, 'session/new', transport.connection.newSession(params));
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const initialized = await this.ensureStarted();
    if (initialized.agentCapabilities?.loadSession !== true) {
      throw new AntigravityRuntimeError('Antigravity ACP does not advertise session/load.');
    }
    const transport = this.live();
    return this.request(transport, 'session/load', transport.connection.loadSession(params));
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const initialized = await this.ensureStarted();
    if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) {
      throw new AntigravityRuntimeError('Antigravity ACP does not advertise session/resume.');
    }
    const transport = this.live();
    return this.request(transport, 'session/resume', transport.connection.resumeSession(params));
  }

  async listSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse> {
    const initialized = await this.ensureStarted();
    if (initialized.agentCapabilities?.sessionCapabilities?.list == null) {
      throw new AntigravityRuntimeError('Antigravity ACP does not advertise session/list.');
    }
    const transport = this.live();
    return this.request(transport, 'session/list', transport.connection.listSessions(params ?? {}));
  }

  async dispatchPrompt(params: PromptRequest): Promise<{ response: Promise<PromptResponse> }> {
    const transport = await this.ready();
    const response = this.bindGeneration(transport, transport.connection.prompt(params));
    return { response };
  }

  async cancel(sessionId: string): Promise<void> {
    if (sessionId === '') throw new AntigravityRuntimeError('sessionId is required.');
    const transport = await this.ready();
    await this.request(transport, 'session/cancel', transport.connection.cancel({ sessionId }));
  }

  async setConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<unknown> {
    const transport = await this.ready();
    return this.request(
      transport,
      'session/set_config_option',
      transport.connection.setSessionConfigOption(params),
    );
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    const initialized = await this.ensureStarted();
    requireAdvertisedAuthMethod(initialized, params.methodId);
    const transport = this.live();
    return this.request(transport, 'authenticate', transport.connection.authenticate(params));
  }

  /**
   * Retire the current generation and reap its process group. A later
   * `ensureStarted()` opens the next generation. Cleanup failure rejects.
   */
  async stop(): Promise<void> {
    const generation = this.activeGeneration;
    this.retiredGenerations.add(generation);
    this.activeGeneration = 0;
    this.retireCalls(generation, generationEnded());
    const pendingStart = this.startPromise;
    const transport = this.transport;
    this.transport = null;
    this.initializeResponse = null;
    this.startPromise = null;
    const failures: Error[] = [];
    if (transport) {
      this.expectedStops.add(transport);
      try {
        await this.reapShared(transport, false);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    if (pendingStart) {
      try {
        await pendingStart;
      } catch (error) {
        if (error instanceof AntigravityCleanupError) failures.push(error);
      }
    }
    const late = this.transport as AntigravityAcpTransport | null;
    if (late && late.generation === generation) {
      this.transport = null;
      this.initializeResponse = null;
      this.expectedStops.add(late);
      try {
        await this.reapShared(late, true);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    if (failures.length === 1) {
      const failure = failures[0];
      if (failure) throw failure;
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Antigravity ACP process cleanup failed.');
    }
  }

  private async start(): Promise<InitializeResponse> {
    const generation = ++this.generationSerial;
    this.activeGeneration = generation;
    const slot: OpenSlot = { current: null };
    const opening = this.openAndInitialize(generation, slot);
    void opening.catch(() => undefined);
    try {
      return await withDeadline(opening, this.startupTimeoutMs, 'initialize');
    } catch (error) {
      const reported = asError(error);
      await this.abandonStart(generation, slot, reported, opening);
      throw reported;
    }
  }

  private async openAndInitialize(generation: number, slot: OpenSlot): Promise<InitializeResponse> {
    const callbacks = this.callbacksFor(generation);
    const opened = this.transportFactory
      ? await this.transportFactory(callbacks)
      : await spawnAntigravityProcess(callbacks, {
        binaryPath: this.binaryPath,
        cwd: this.cwd,
        env: this.envOverlay,
        gracefulStopMs: this.gracefulStopMs,
      });
    const transport: AntigravityAcpTransport = {
      generation,
      connection: opened.connection,
      exit: opened.exit,
      stop: (options) => opened.stop(options),
    };
    slot.current = transport;
    if (!this.generationIsCurrent(generation)) {
      throw new AntigravityRuntimeError('Antigravity ACP start was cancelled.');
    }
    this.transport = transport;
    void transport.exit.then(
      (exitEvent) => this.onExit(transport, exitEvent),
      (error: unknown) => this.onExit(transport, { code: null, signal: null, error: asError(error) }),
    );
    const response = await this.bindGeneration(transport, transport.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: ANTIGRAVITY_CLIENT_INFO.name,
        title: ANTIGRAVITY_CLIENT_INFO.title,
        version: ANTIGRAVITY_CLIENT_INFO.version,
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }));
    if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AntigravityRuntimeError(
        `Unsupported Antigravity ACP protocol version ${String(response.protocolVersion)}.`,
      );
    }
    if (!this.generationIsCurrent(generation)) {
      throw new AntigravityRuntimeError('Antigravity ACP start was cancelled.');
    }
    this.initializeResponse = response;
    return response;
  }

  private async abandonStart(
    generation: number,
    slot: OpenSlot,
    reported: Error,
    opening: Promise<InitializeResponse>,
  ): Promise<void> {
    this.retiredGenerations.add(generation);
    if (this.activeGeneration === generation) this.activeGeneration = 0;
    this.retireCalls(generation, reported);
    const known = slot.current;
    void opening.finally(() => {
      const late = slot.current;
      if (!late || late === known || !this.retiredGenerations.has(generation)) return;
      void this.forceReap(late, reported).catch((cleanupError: unknown) => {
        this.onExit(late, { code: null, signal: null, error: asError(cleanupError) });
      });
    }).catch(() => undefined);
    if (known) await this.forceReap(known, reported);
  }

  private callbacksFor(generation: number): Client {
    return {
      requestPermission: (request) => this.answerPermission(generation, request),
      sessionUpdate: (notification) => {
        if (!this.generationIsCurrent(generation)) return Promise.resolve();
        this.emitter.emit('sessionUpdate', notification);
        return Promise.resolve();
      },
    };
  }

  private async answerPermission(
    generation: number,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (!this.generationIsCurrent(generation)) return cancelledPermission();
    const handler = this.permissionHandler;
    if (!handler) return cancelledPermission();
    try {
      const answer = await handler(request);
      if (!this.generationIsCurrent(generation)) return cancelledPermission();
      return answer;
    } catch {
      return cancelledPermission();
    }
  }

  private generationIsCurrent(generation: number): boolean {
    return this.activeGeneration === generation && !this.retiredGenerations.has(generation);
  }

  private async ready(): Promise<AntigravityAcpTransport> {
    await this.ensureStarted();
    return this.live();
  }

  private live(): AntigravityAcpTransport {
    const transport = this.transport;
    if (!transport || !this.generationIsCurrent(transport.generation)) {
      throw new AntigravityRuntimeError('Antigravity ACP is not running.');
    }
    return transport;
  }

  private async request<T>(
    transport: AntigravityAcpTransport,
    label: string,
    operation: Promise<T>,
  ): Promise<T> {
    try {
      return await withDeadline(this.bindGeneration(transport, operation), this.requestTimeoutMs, label);
    } catch (error) {
      if (!(error instanceof AntigravityTimeoutError)) throw error;
      await this.failClosed(transport, error);
      throw error;
    }
  }

  /** Retire the generation that timed out. The RPC is not issued again. */
  private failClosed(transport: AntigravityAcpTransport, error: AntigravityTimeoutError): Promise<void> {
    const generation = transport.generation;
    const existing = this.retirement.get(generation);
    if (existing) return existing;
    this.retiredGenerations.add(generation);
    if (this.activeGeneration === generation) this.activeGeneration = 0;
    this.retireCalls(generation, error);
    const job = this.forceReap(transport, error);
    this.retirement.set(generation, job);
    return job;
  }

  private forceReap(transport: AntigravityAcpTransport, cause: Error): Promise<void> {
    this.retirementCause.set(transport, cause);
    this.expectedStops.add(transport);
    if (this.transport === transport) {
      this.transport = null;
      this.initializeResponse = null;
      if (this.activeGeneration === transport.generation) this.activeGeneration = 0;
    }
    return this.reapShared(transport, true);
  }

  private bindGeneration<T>(transport: AntigravityAcpTransport, operation: Promise<T>): Promise<T> {
    const generation = transport.generation;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        const index = this.activeCalls.indexOf(entry);
        if (index >= 0) this.activeCalls.splice(index, 1);
        settle();
      };
      const entry: ActiveCall = {
        generation,
        reject: (error) => finish(() => reject(error)),
      };
      this.activeCalls.push(entry);
      operation.then(
        (value) => finish(() => {
          if (!this.generationIsCurrent(generation)) {
            reject(generationEnded());
            return;
          }
          resolve(value);
        }),
        (error: unknown) => finish(() => {
          reject(asError(error));
        }),
      );
      transport.exit.then(
        (exitEvent) => entry.reject(exitFailure(exitEvent)),
        (error: unknown) => entry.reject(asError(error)),
      );
    });
  }

  private retireCalls(generation: number, error: Error): void {
    const doomed = this.activeCalls.filter((entry) => entry.generation === generation);
    for (const entry of doomed) entry.reject(error);
  }

  private onExit(transport: AntigravityAcpTransport, exitEvent: AntigravityAcpExit): void {
    if (this.exitReported.has(transport)) return;
    this.exitReported.add(transport);
    this.retiredGenerations.add(transport.generation);
    const wasCurrent = this.transport === transport;
    if (wasCurrent) {
      this.transport = null;
      this.initializeResponse = null;
      this.startPromise = null;
      this.activeGeneration = 0;
    }
    const failure = exitEvent.error ?? this.retirementCause.get(transport);
    this.retireCalls(transport.generation, failure ?? exitFailure(exitEvent));
    const successorRunning = this.activeGeneration !== 0 && this.activeGeneration !== transport.generation;
    if (successorRunning) return;
    const stopped: RuntimeStopped = {
      code: exitEvent.code,
      signal: exitEvent.signal,
      expected: this.expectedStops.has(transport),
    };
    if (failure) stopped.error = failure;
    this.emitter.emit('runtimeStopped', stopped);
  }

  private reapShared(transport: AntigravityAcpTransport, force: boolean): Promise<void> {
    const existing = this.reapJobs.get(transport);
    if (existing) {
      if (force) void transport.stop({ force: true }).catch(() => undefined);
      return existing;
    }
    const job = this.reap(transport, force);
    this.reapJobs.set(transport, job);
    return job;
  }

  private async reap(transport: AntigravityAcpTransport, force: boolean): Promise<void> {
    try {
      if (force) {
        await transport.stop({ force: true });
        return;
      }
      await transport.stop({});
    } catch (error) {
      if (!force) {
        try {
          await transport.stop({ force: true });
          return;
        } catch (forceError) {
          error = forceError;
        }
      }
      const cleanup = error instanceof AntigravityCleanupError
        ? error
        : new AntigravityCleanupError(asError(error));
      this.onExit(transport, { code: null, signal: null, error: cleanup });
      throw cleanup;
    }
  }
}

export function requireAdvertisedAuthMethod(initialized: InitializeResponse, methodId: string): void {
  const advertised = (initialized.authMethods ?? []).some((method) => method.id === methodId);
  if (!advertised) {
    throw new AntigravityRuntimeError(
      `Antigravity ACP did not advertise authentication method ${methodId}.`,
    );
  }
}

function generationEnded(): AntigravityRuntimeError {
  return new AntigravityRuntimeError('Antigravity ACP generation ended.');
}

function exitFailure(exitEvent: AntigravityAcpExit): Error {
  if (exitEvent.error) return exitEvent.error;
  return new AntigravityRuntimeError(
    `Antigravity ACP exited (code=${String(exitEvent.code)}, signal=${String(exitEvent.signal)}).`,
  );
}

function positiveMs(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new AntigravityRuntimeError(`${field} must be a positive number.`);
  }
  return resolved;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // The caller may already have settled on the deadline. A later retirement
  // still rejects `operation`; observe that rejection here.
  void operation.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AntigravityTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
