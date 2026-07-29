import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type CloseSessionRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';

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
}

export interface KimiAcpRuntimeStoppedEvent extends KimiAcpExit {
  expected: boolean;
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
  /** Notifications from an internal command such as `/status` are captured so
   *  they can update session metadata without leaking into the transcript. */
  private readonly capturedUpdates = new Map<string, SessionNotification[]>();

  constructor(options: KimiAcpClientOptions) {
    super();
    validateAbsolutePath(options.binaryPath, 'binaryPath');
    this.options = options;
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
    if (this.initializeResponse) return this.initializeResponse;
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

    void transport.exit.then((exit) => {
      const isCurrent = this.transport === transport;
      if (isCurrent) {
        this.transport = null;
        this.initializeResponse = null;
        this.startPromise = null;
      }
      this.emit('runtimeStopped', {
        ...exit,
        expected: this.expectedStops.has(transport),
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
        terminal: false,
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
    return (await this.connection()).newSession(params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.loadSession !== true) {
      throw new Error('Kimi ACP does not advertise session/load.');
    }
    return (await this.connection()).loadSession(params);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.resume == null) {
      throw new Error('Kimi ACP does not advertise session/resume.');
    }
    return (await this.connection()).resumeSession(params);
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.list == null) {
      throw new Error('Kimi ACP does not advertise session/list.');
    }
    return (await this.connection()).listSessions(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return (await this.connection()).prompt(params);
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
    await (await this.connection()).cancel({ sessionId });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return (await this.connection()).setSessionConfigOption(params);
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    const capabilities = (await this.ensureStarted()).agentCapabilities;
    if (capabilities?.sessionCapabilities?.close == null) {
      throw new Error('Kimi ACP does not advertise session/close.');
    }
    await (await this.connection()).closeSession(params);
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
    if (transport) {
      this.expectedStops.add(transport);
      await transport.stop();
    }
  }
}
