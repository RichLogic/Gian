import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type CloseSessionRequest,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

import { KimiTerminalService, type SessionDrainLease } from './terminal-service.js';

export type { SessionDrainLease };

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_MS = 3_000;

export type KimiAcpPermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export interface KimiAcpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface KimiAcpTransport {
  connection: ClientSideConnection;
  exit: Promise<KimiAcpExit>;
  stop(): Promise<void>;
}

export type KimiAcpTransportFactory = (client: Client) => Promise<KimiAcpTransport>;

export interface KimiAcpClientOptions {
  binaryPath: string;
  env?: NodeJS.ProcessEnv;
  permissionHandler?: KimiAcpPermissionHandler;
  startupTimeoutMs?: number;
  gracefulStopMs?: number;
  transportFactory?: KimiAcpTransportFactory;
  /** Test seam: deterministic process-group behavior for the terminal
   *  service (defaults to real POSIX process groups). */
  terminalProcessGroupAdapter?: ConstructorParameters<typeof KimiTerminalService>[0];
}

export interface KimiAcpRuntimeStoppedEvent extends KimiAcpExit {
  expected: boolean;
  /** Set when reaping the stopped generation's terminals failed; consumers
   *  must surface it instead of treating the runtime handover as clean. */
  terminalCleanupError?: string;
}

interface KimiAcpClientEvents {
  debug: [message: string];
  sessionUpdate: [notification: SessionNotification];
  runtimeStopped: [event: KimiAcpRuntimeStoppedEvent];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function validateAbsolutePath(value: string, field: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path.`);
  }
}

/** Attribution without leakage: ACP failures are logged with a fixed
 *  operation label and a sanitized message only — never params, prompt,
 *  command, cwd, env, attachment paths, or full request JSON. Node embeds the
 *  spawned binary path in ENOENT/EACCES messages, so spawn subjects are
 *  redacted as well. */
export function logAcpFailure(operation: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/spawn\s+\S+/g, 'spawn <redacted>')
    .trim()
    .slice(0, 200);
  const codePart = code === undefined ? '' : ` code=${String(code)}`;
  console.error(`[kimi-acp] ${operation} failed${codePart} (${name}): ${message}`);
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<KimiAcpExit> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exit: KimiAcpExit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once('error', (error) => {
      settle({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => {
      settle({ code, signal });
    });
  });
}

function processTransportFactory(
  options: Pick<KimiAcpClientOptions, 'binaryPath' | 'env' | 'gracefulStopMs'>,
  emitDebug: (message: string) => void,
): KimiAcpTransportFactory {
  return async (client) => {
    const child = spawn(options.binaryPath, ['acp'], {
      env: {
        ...process.env,
        ...options.env,
        KIMI_CODE_NO_AUTO_UPDATE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = processExit(child);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) emitDebug(message);
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => client, stream);

    return {
      connection,
      exit,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;

        child.stdin.end();
        if (await settlesWithin(exit, options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS)) {
          return;
        }

        child.kill('SIGTERM');
        if (await settlesWithin(exit, 2_000)) return;
        child.kill('SIGKILL');
        await exit;
      },
    };
  };
}

export class KimiAcpClient extends EventEmitter<KimiAcpClientEvents> {
  private readonly options: KimiAcpClientOptions;
  private readonly transportFactory: KimiAcpTransportFactory;
  private readonly callbacks: Client;
  private permissionHandler: KimiAcpPermissionHandler | null;
  private transport: KimiAcpTransport | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private startPromise: Promise<InitializeResponse> | null = null;
  private readonly expectedStops = new WeakSet<KimiAcpTransport>();
  private readonly transportGenerations = new WeakMap<KimiAcpTransport, number>();
  /** Reverse-RPC terminal executor owned exclusively by this client. */
  private readonly terminals: KimiTerminalService;
  /** Cleanup barrier of the retired generation: new runtimes may only start
   *  once it settles (and never at all after a failed cleanup). */
  private generationCleanup: Promise<void> | null = null;
  private generationCleanupFailed: Error | null = null;
  /** Notifications from an internal command such as `/status` are captured so
   *  they can update session metadata without leaking into the transcript. */
  private readonly capturedUpdates = new Map<string, SessionNotification[]>();

  constructor(options: KimiAcpClientOptions) {
    super();
    validateAbsolutePath(options.binaryPath, 'binaryPath');
    this.options = options;
    this.terminals = new KimiTerminalService(options.terminalProcessGroupAdapter ?? {});
    this.permissionHandler = options.permissionHandler ?? null;
    this.transportFactory = options.transportFactory
      ?? processTransportFactory(options, (message) => this.emit('debug', message));
    this.callbacks = {
      requestPermission: async (request) => {
        if (!this.permissionHandler) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return this.permissionHandler(request);
      },
      sessionUpdate: async (notification) => {
        const capture = this.capturedUpdates.get(notification.sessionId);
        if (capture) {
          capture.push(notification);
          return;
        }
        this.emit('sessionUpdate', notification);
      },
      createTerminal: async (params) => {
        try {
          return await this.terminals.create(params, { env: process.env });
        } catch (error) {
          logAcpFailure('terminal/create', error);
          throw error;
        }
      },
      terminalOutput: async (params) => {
        try {
          return this.terminals.output(params);
        } catch (error) {
          logAcpFailure('terminal/output', error);
          throw error;
        }
      },
      waitForTerminalExit: async (params) => {
        try {
          return await this.terminals.waitForExit(params);
        } catch (error) {
          logAcpFailure('terminal/wait_for_exit', error);
          throw error;
        }
      },
      killTerminal: async (params) => {
        try {
          return await this.terminals.kill(params);
        } catch (error) {
          logAcpFailure('terminal/kill', error);
          throw error;
        }
      },
      releaseTerminal: async (params) => {
        try {
          return await this.terminals.release(params);
        } catch (error) {
          logAcpFailure('terminal/release', error);
          throw error;
        }
      },
    };
  }

  get negotiated(): InitializeResponse | null {
    return this.initializeResponse;
  }

  get binaryPath(): string {
    return this.options.binaryPath;
  }

  get started(): boolean {
    return this.transport !== null && this.initializeResponse !== null;
  }

  setPermissionHandler(handler: KimiAcpPermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  async ensureStarted(): Promise<InitializeResponse> {
    if (this.generationCleanupFailed !== null) {
      // Fail closed: a retired generation whose terminal harvest failed must
      // never be papered over by silently starting a fresh runtime.
      throw new Error(
        `Previous Kimi runtime terminal cleanup failed: ${this.generationCleanupFailed.message}`,
      );
    }
    let waitedRetiredCleanup = false;
    if (this.generationCleanup) {
      // The barrier settled while this caller waited: a failed cleanup must
      // surface here (and stay sticky below) instead of starting a runtime
      // over unverified process groups.
      try {
        await this.generationCleanup;
      } catch (error) {
        this.generationCleanupFailed = error instanceof Error
          ? error
          : new Error(String(error));
        throw new Error(
          `Previous Kimi runtime terminal cleanup failed: ${this.generationCleanupFailed.message}`,
        );
      }
      waitedRetiredCleanup = true;
    }
    // Fast path only while no generation is retiring: after waiting on a
    // retired generation's cleanup the cached initialize response belongs to
    // a dead transport and must never be handed out.
    if (!waitedRetiredCleanup && this.initializeResponse) return this.initializeResponse;
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<InitializeResponse> {
    const transport = await this.transportFactory(this.callbacks);
    this.transport = transport;
    const generation = this.terminals.advanceGeneration();
    this.transportGenerations.set(transport, generation);

    void transport.exit.then(async (exit) => {
      const generation = this.transportGenerations.get(transport);
      // Fence synchronously (before any await): the dying generation refuses
      // new reverse creates from this moment, and any create already in its
      // spawn window is tracked as pending for the cleanup below.
      this.terminals.fenceRuntime();
      const isCurrent = this.transport === transport;
      // Cleanup barrier: concurrent ensureStarted()/resume calls await this
      // single-flight promise and may not start a new generation until the
      // old one's terminals are verified reaped (or permanently fail).
      const cleanup = (async () => {
        await this.terminals.drainRuntime(generation);
      })();
      this.generationCleanup = cleanup;
      let terminalCleanupError: string | undefined;
      try {
        await cleanup;
      } catch (error) {
        terminalCleanupError = error instanceof Error ? error.message : String(error);
        this.generationCleanupFailed = error instanceof Error ? error : new Error(terminalCleanupError);
        logAcpFailure('terminal/cleanup', error);
      }
      if (isCurrent) {
        this.transport = null;
        this.initializeResponse = null;
        this.startPromise = null;
      }
      // Reap every terminal of the stopped generation BEFORE the runtimeStopped
      // broadcast so downstream handlers never observe live command processes
      // belonging to a dead runtime. A failed harvest rides the event: the
      // failure state must stay visible, never silently swallowed.
      this.emit('runtimeStopped', {
        ...exit,
        expected: this.expectedStops.has(transport),
        ...(terminalCleanupError !== undefined ? { terminalCleanupError } : {}),
      } satisfies KimiAcpRuntimeStoppedEvent);
    });

    const initialize = transport.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: 'gian-kimi-proxy',
        version: '0.1.0',
      },
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: true,
      },
    });

    let response: InitializeResponse;
    try {
      response = await Promise.race([
        initialize,
        transport.exit.then((exit) => {
          if (exit.error) throw exit.error;
          throw new Error(
            `Kimi ACP stopped during initialize (code=${String(exit.code)}, signal=${String(exit.signal)}).`,
          );
        }),
        delay(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS).then(() => {
          throw new Error('Timed out waiting for Kimi ACP initialize.');
        }),
      ]);
    } catch (error) {
      if (this.transport === transport) {
        this.transport = null;
      }
      this.expectedStops.add(transport);
      await transport.stop();
      throw error;
    }

    if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
      if (this.transport === transport) {
        this.transport = null;
      }
      this.expectedStops.add(transport);
      await transport.stop();
      throw new Error(
        `Unsupported Kimi ACP protocol version ${String(response.protocolVersion)}.`,
      );
    }

    if (this.transport !== transport) {
      this.expectedStops.add(transport);
      await transport.stop();
      throw new Error('Kimi ACP startup was cancelled.');
    }

    this.initializeResponse = response;
    return response;
  }

  private async connection(): Promise<ClientSideConnection> {
    await this.ensureStarted();
    if (!this.transport) {
      throw new Error('Kimi ACP transport stopped during startup.');
    }
    return this.transport.connection;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    try {
      const response = await (await this.connection()).newSession(params);
      this.terminals.bindSession(response.sessionId, params.cwd);
      return response;
    } catch (error) {
      logAcpFailure('session/new', error);
      throw error;
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.loadSession !== true) {
      throw new Error('Kimi ACP does not advertise session/load.');
    }
    try {
      const response = await (await this.connection()).loadSession(params);
      this.terminals.bindSession(params.sessionId, params.cwd);
      return response;
    } catch (error) {
      logAcpFailure('session/load', error);
      throw error;
    }
  }

  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    try {
      const response = await (await this.connection()).unstable_forkSession(params);
      this.terminals.bindSession(response.sessionId, params.cwd);
      return response;
    } catch (error) {
      logAcpFailure('session/fork', error);
      throw error;
    }
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.resume == null) {
      throw new Error('Kimi ACP does not advertise session/resume.');
    }
    try {
      const response = await (await this.connection()).resumeSession(params);
      this.terminals.bindSession(params.sessionId, params.cwd);
      return response;
    } catch (error) {
      logAcpFailure('session/resume', error);
      throw error;
    }
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.list == null) {
      throw new Error('Kimi ACP does not advertise session/list.');
    }
    try {
      return await (await this.connection()).listSessions(params);
    } catch (error) {
      logAcpFailure('session/list', error);
      throw error;
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    try {
      return await (await this.connection()).prompt(params);
    } catch (error) {
      logAcpFailure('session/prompt', error);
      throw error;
    }
  }

  async promptCaptured(params: PromptRequest): Promise<{
    response: PromptResponse;
    updates: SessionNotification[];
  }> {
    if (this.capturedUpdates.has(params.sessionId)) {
      throw new Error(`A captured prompt is already running for ${params.sessionId}.`);
    }
    const updates: SessionNotification[] = [];
    this.capturedUpdates.set(params.sessionId, updates);
    try {
      const response = await this.prompt(params);
      return { response, updates };
    } finally {
      this.capturedUpdates.delete(params.sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await (await this.connection()).cancel({ sessionId });
    } catch (error) {
      logAcpFailure('session/cancel', error);
      throw error;
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    try {
      return await (await this.connection()).setSessionConfigOption(params);
    } catch (error) {
      logAcpFailure('session/set_config_option', error);
      throw error;
    }
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.close == null) {
      throw new Error('Kimi ACP does not advertise session/close.');
    }
    try {
      // Binding deletion is owned by the permanent session drain (the close
      // flow in KimiProxyService), never by this RPC wrapper.
      await (await this.connection()).closeSession(params);
    } catch (error) {
      logAcpFailure('session/close', error);
      throw error;
    }
  }

  /**
   * Synchronously raise the session terminal barrier and hand back the lease
   * that owns it. The barrier is effective before the first await of the
   * caller's flow (cancel/close windows included); `lease.drain()` harvests
   * existing records and waits for in-flight creates, and only a fully
   * successful drain may release. Cleanup failures keep the barrier.
   * `permanent` is for session close/detach: a successful release deletes
   * the binding so later creates fail closed forever.
   */
  beginSessionTerminalDrain(
    nativeSessionId: string,
    options: { permanent?: boolean } = {},
  ): SessionDrainLease {
    return this.terminals.beginSessionDrain(nativeSessionId, options);
  }

  /** Test accessor: creates past entry validation still settling. */
  pendingTerminalCreatesForTest(): number {
    return this.terminals.pendingCreateCount();
  }

  async stop(): Promise<void> {
    if (this.startPromise && !this.transport) {
      await this.startPromise.catch(() => undefined);
    }

    const transport = this.transport;
    this.transport = null;
    this.initializeResponse = null;
    this.startPromise = null;
    this.capturedUpdates.clear();
    // Synchronous generation fence: from this moment the current generation
    // refuses new reverse creates; its in-flight creates settle inside the
    // drain. Global terminal cleanup precedes the runtime stop: command
    // process groups are ours, not the ACP child's, and must never outlive
    // shutdown. Failures propagate so shutdown reports a failed state.
    this.terminals.fenceRuntime();
    await this.terminals.drainRuntime();
    if (transport) {
      this.expectedStops.add(transport);
      await transport.stop();
    }
  }
}
