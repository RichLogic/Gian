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
} from '@agentclientprotocol/sdk';

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_MS = 3_000;

export const GROK_SPAWN_PREFIX = [
  '--deny',
  'MCPTool(*)',
  '--disallowed-tools',
  'search_tool,use_tool',
] as const;

export type GrokAcpPermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export interface GrokAcpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface GrokAcpTransport {
  connection: ClientSideConnection;
  exit: Promise<GrokAcpExit>;
  stop(): Promise<void>;
}

export type GrokAcpTransportFactory = (client: Client) => Promise<GrokAcpTransport>;

export interface GrokAcpClientOptions {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionHandler?: GrokAcpPermissionHandler;
  startupTimeoutMs?: number;
  gracefulStopMs?: number;
  transportFactory?: GrokAcpTransportFactory;
}

export interface GrokAcpRuntimeStoppedEvent extends GrokAcpExit {
  expected: boolean;
}

interface GrokAcpClientEvents {
  debug: [message: string];
  sessionUpdate: [notification: SessionNotification];
  extensionNotification: [method: string, params: unknown];
  runtimeStopped: [event: GrokAcpRuntimeStoppedEvent];
}

interface ExtCapable {
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): Promise<void>;
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
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
}

function isMethodNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found/i.test(message);
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<GrokAcpExit> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exit: GrokAcpExit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once('error', (error) => settle({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => settle({ code, signal }));
  });
}

function innerConnection(connection: ClientSideConnection): ExtCapable {
  const candidate = connection as unknown as { connection?: ExtCapable };
  if (!candidate.connection?.sendRequest || !candidate.connection.sendNotification) {
    throw new Error('Grok ACP connection does not expose extension RPC.');
  }
  return candidate.connection;
}

function processTransportFactory(
  options: Pick<GrokAcpClientOptions, 'binaryPath' | 'cwd' | 'env' | 'gracefulStopMs'>,
  emitDebug: (message: string) => void,
): GrokAcpTransportFactory {
  return async (client) => {
    const child = spawn(options.binaryPath, [
      ...GROK_SPAWN_PREFIX,
      'agent',
      '--no-leader',
      'stdio',
    ], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        GROK_DISABLE_AUTOUPDATER: '1',
        GROK_SANDBOX: 'workspace',
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
        if (await settlesWithin(exit, options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS)) return;
        child.kill('SIGTERM');
        if (await settlesWithin(exit, 2_000)) return;
        child.kill('SIGKILL');
        await exit;
      },
    };
  };
}

export class GrokAcpClient extends EventEmitter<GrokAcpClientEvents> {
  private readonly options: GrokAcpClientOptions;
  private readonly transportFactory: GrokAcpTransportFactory;
  private readonly callbacks: Client & {
    extNotification?(method: string, params: unknown): Promise<void>;
    extMethod?(method: string, params: unknown): Promise<unknown>;
  };
  private permissionHandler: GrokAcpPermissionHandler | null;
  private transport: GrokAcpTransport | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private startPromise: Promise<InitializeResponse> | null = null;
  private readonly expectedStops = new WeakSet<GrokAcpTransport>();

  constructor(options: GrokAcpClientOptions) {
    super();
    validateAbsolutePath(options.binaryPath, 'binaryPath');
    validateAbsolutePath(options.cwd, 'cwd');
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
        this.emit('sessionUpdate', notification);
      },
      extNotification: async (method, params) => {
        this.emit('extensionNotification', method, params);
      },
      extMethod: async () => ({}),
    };
  }

  get binaryPath(): string {
    return this.options.binaryPath;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  get negotiated(): InitializeResponse | null {
    return this.initializeResponse;
  }

  setPermissionHandler(handler: GrokAcpPermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  async ensureStarted(): Promise<InitializeResponse> {
    if (this.initializeResponse) return this.initializeResponse;
    this.startPromise ??= this.start();
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
      });
    });

    const initialize = transport.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'gian-grok-proxy', version: '0.2.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
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
            `Grok ACP stopped during initialize (code=${String(exit.code)}, signal=${String(exit.signal)}).`,
          );
        }),
        delay(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS).then(() => {
          throw new Error('Timed out waiting for Grok ACP initialize.');
        }),
      ]);
    } catch (error) {
      if (this.transport === transport) this.transport = null;
      this.expectedStops.add(transport);
      await transport.stop();
      throw error;
    }

    if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
      if (this.transport === transport) this.transport = null;
      this.expectedStops.add(transport);
      await transport.stop();
      throw new Error(`Unsupported Grok ACP protocol version ${String(response.protocolVersion)}.`);
    }

    this.initializeResponse = response;
    return response;
  }

  private async connection(): Promise<ClientSideConnection> {
    await this.ensureStarted();
    if (!this.transport) throw new Error('Grok ACP transport stopped during startup.');
    return this.transport.connection;
  }

  private async ext(): Promise<ExtCapable> {
    return innerConnection(await this.connection());
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    return (await this.connection()).newSession(params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    if ((await this.ensureStarted()).agentCapabilities?.loadSession !== true) {
      throw new Error('Grok ACP does not advertise session/load.');
    }
    return (await this.connection()).loadSession(params);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    validateAbsolutePath(params.cwd, 'cwd');
    if ((await this.ensureStarted()).agentCapabilities?.sessionCapabilities?.resume == null) {
      throw new Error('Grok ACP does not advertise session/resume.');
    }
    return (await this.connection()).resumeSession(params);
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    if ((await this.ensureStarted()).agentCapabilities?.sessionCapabilities?.list == null) {
      throw new Error('Grok ACP does not advertise session/list.');
    }
    return (await this.connection()).listSessions(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return (await this.connection()).prompt(params);
  }

  async cancel(sessionId: string): Promise<void> {
    await innerConnection(await this.connection()).sendNotification('session/cancel', {
      sessionId,
      _meta: {
        rewindIfNoOutput: false,
        rewindIfPristine: false,
        cancelSubagents: true,
      },
    });
  }

  async setSessionModel(params: {
    sessionId: string;
    modelId: string;
    _meta?: Record<string, unknown>;
  }): Promise<unknown> {
    return (await this.connection()).unstable_setSessionModel(params);
  }

  async renameSession(sessionId: string, title: string): Promise<unknown> {
    const ext = await this.ext();
    const params = { sessionId, title };
    // Grok's TUI knows x.ai/session/rename; the stdio `grok agent` used by
    // Gian does not register that ext method. Try both wire names, then
    // succeed locally so Host bring-up does not fail a new conversation.
    for (const method of ['x.ai/session/rename', '_x.ai/session/rename'] as const) {
      try {
        return await ext.sendRequest(method, params);
      } catch (error) {
        if (!isMethodNotFound(error)) throw error;
      }
    }
    return { ok: true };
  }

  async deleteSession(sessionId: string): Promise<unknown> {
    return (await this.ext()).sendRequest('x.ai/session/delete', { sessionId });
  }

  async sessionUsage(sessionId: string): Promise<unknown> {
    return (await this.ext()).sendRequest('x.ai/session/usage', { sessionId });
  }

  async interject(params: {
    sessionId: string;
    text: string;
    interjectionId: string;
  }): Promise<unknown> {
    return (await this.ext()).sendRequest('x.ai/interject', params);
  }

  async notifyPermissionMode(params: {
    sessionId: string;
    clientIdentifier: string;
    permission_mode: string;
    yolo_mode: boolean;
    auto_mode: boolean;
  }): Promise<void> {
    await (await this.ext()).sendNotification('x.ai/yolo_mode_changed', params);
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    if ((await this.ensureStarted()).agentCapabilities?.sessionCapabilities?.close == null) {
      throw new Error('Grok ACP does not advertise session/close.');
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
    if (transport) {
      this.expectedStops.add(transport);
      await transport.stop();
    }
  }
}
