import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
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

import {
  extensionSupportFromInitialize,
  type GrokExtMethod,
  type GrokExtensionSupport,
  NO_EXTENSION_SUPPORT,
} from './grok-extensions.js';

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_MS = 3_000;

export const GROK_DEFAULT_DENY_RULES = ['MCPTool(*)'] as const;

/** Legacy alias: spawn prefix with the default MCP isolation boundary. */
export const GROK_SPAWN_PREFIX = [
  '--deny',
  GROK_DEFAULT_DENY_RULES[0],
  '--disallowed-tools',
  'search_tool,use_tool',
] as const;

export class GrokExtMethodUnsupportedError extends Error {
  constructor(readonly method: string, reason: string) {
    super(reason);
    this.name = 'GrokExtMethodUnsupportedError';
  }
}

/** Wire shape of the native `x.ai/session/fork` extension request. */
export interface GrokNativeForkRequest {
  sourceSessionId: string;
  sourceCwd: string;
  newCwd: string;
  newSessionId?: string;
  newModelId?: string;
  /** 0-based inclusive user-prompt index the fork keeps. Omit to fork the head. */
  targetPromptIndex?: number;
}

export interface GrokNativeForkResponse {
  newSessionId: string;
  chatMessagesCopied?: number;
  updatesCopied?: number;
  planStateCopied?: boolean;
  newCwd?: string;
  parentSessionId?: string;
  newModelId?: string | null;
}

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

/** The Agent HOME this Proxy serves: the Host-provided constrained
 *  GIAN_AGENT_HOME wins; an inherited GROK_HOME is only a compatibility
 *  fallback for the pre-gate Host generation. */
export function agentHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GIAN_AGENT_HOME !== undefined && env.GIAN_AGENT_HOME !== '') return env.GIAN_AGENT_HOME;
  return env.GROK_HOME;
}

/** Provider-specific child env: translates the Host's constrained
 *  GIAN_AGENT_HOME into GROK_HOME so the CLI reads its state from the served
 *  Agent's HOME and never from a stale machine-wide value. */
export function grokChildHomeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const home = agentHome(env);
  return home !== undefined ? { GROK_HOME: home } : {};
}

export interface GrokAcpClientOptions {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionHandler?: GrokAcpPermissionHandler;
  startupTimeoutMs?: number;
  gracefulStopMs?: number;
  transportFactory?: GrokAcpTransportFactory;
  /** MCP permission deny rules for the spawn boundary; defaults to MCPTool(*). */
  spawnDenyRules?: readonly string[];
}

export interface GrokAcpRuntimeStoppedEvent extends GrokAcpExit {
  expected: boolean;
}

/** Reverse `x.ai/*` request routed to the Proxy (ask_user_question etc.). */
export type GrokExtMethodHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

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

export function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === -32601) return true;
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
  options: Pick<GrokAcpClientOptions, 'binaryPath' | 'cwd' | 'env' | 'gracefulStopMs' | 'spawnDenyRules'>,
  emitDebug: (message: string) => void,
): GrokAcpTransportFactory {
  return async (client) => {
    const args: string[] = [];
    for (const rule of options.spawnDenyRules ?? GROK_DEFAULT_DENY_RULES) {
      args.push('--deny', rule);
    }
    args.push('--disallowed-tools', 'search_tool,use_tool');
    const child = spawn(options.binaryPath, [
      ...args,
      'agent',
      '--no-leader',
      'stdio',
    ], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        // Home mapping lives in the owning Proxy (Host provides the
        // constrained universal GIAN_AGENT_HOME). The explicit translation
        // wins over any inherited GROK_HOME so a stale outer value can never
        // point the CLI at another Agent's state.
        ...grokChildHomeEnv(options.env ?? process.env),
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
  private extMethodHandler: GrokExtMethodHandler | null = null;
  private extSupport: GrokExtensionSupport = NO_EXTENSION_SUPPORT;
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
      extMethod: async (method: string, params: unknown) => {
        // Reverse requests from the agent must be answered honestly: the old
        // blanket `{}` return silently mis-answered structured questions.
        if (!this.extMethodHandler) {
          throw new Error(`Method not found: ${method}`);
        }
        const result = await this.extMethodHandler(method, params);
        return result as Record<string, unknown>;
      },
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

  /** Version-gated native x.ai/* extension method support for this runtime. */
  get extensions(): GrokExtensionSupport {
    return this.extSupport;
  }

  setPermissionHandler(handler: GrokAcpPermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  setExtMethodHandler(handler: GrokExtMethodHandler | null): void {
    this.extMethodHandler = handler;
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
    this.extSupport = extensionSupportFromInitialize(response);
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

  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return (await this.connection()).unstable_forkSession(params);
  }

  /** One live extension-request round trip with honest per-attach learning.
   *  Unknown methods are allowed a first real attempt: a -32601 "Method not
   *  found" refutes the method for the rest of this attach (later calls fail
   *  fast instead of repeating the live misreport), any other outcome
   *  confirms it. Refuted methods never touch the runtime again. */
  private async extRequest(method: GrokExtMethod, params: unknown): Promise<unknown> {
    if (!this.extSupport.mayAttempt(method)) {
      throw new GrokExtMethodUnsupportedError(method, this.extSupport.unsupportedReason(method));
    }
    try {
      const result = await (await this.ext()).sendRequest(method, params);
      this.extSupport.confirm(method);
      return result;
    } catch (error) {
      if (isMethodNotFound(error)) {
        this.extSupport.refute(method);
        throw new GrokExtMethodUnsupportedError(method, this.extSupport.unsupportedReason(method));
      }
      throw error;
    }
  }

  /** Native `x.ai/session/fork` — supports head forks and exact-turn forks
   *  via `targetPromptIndex` (0-based, inclusive). Does not start the forked
   *  session; attach it afterwards with `resumeSession`. */
  async nativeForkSession(params: GrokNativeForkRequest): Promise<GrokNativeForkResponse> {
    const response = (await this.extRequest('x.ai/session/fork', params)) as Record<string, unknown>;
    if (!response || typeof response !== 'object'
      || typeof (response as { newSessionId?: unknown }).newSessionId !== 'string'
      || !(response as { newSessionId: string }).newSessionId) {
      throw new Error('x.ai/session/fork did not return a newSessionId.');
    }
    return response as unknown as GrokNativeForkResponse;
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

  async renameSession(sessionId: string, title: string, cwd?: string): Promise<unknown> {
    // Method-not-found is refuted and surfaced honestly by extRequest instead
    // of being swallowed into a local fake success.
    return this.extRequest('x.ai/session/rename', {
      sessionId,
      title,
      ...(cwd ? { cwd } : {}),
    });
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<unknown> {
    return this.extRequest('x.ai/session/delete', {
      sessionId,
      ...(cwd ? { cwd } : {}),
    });
  }

  /** Mid-session MCP server swap; the agent admits and merges client servers. */
  async updateSessionMcpServers(sessionId: string, mcpServers: McpServer[]): Promise<unknown> {
    return this.extRequest('x.ai/session/update_mcp_servers', {
      sessionId,
      mcpServers,
    });
  }

  /** Read-only effective MCP server catalog (no server is contacted). */
  async mcpList(): Promise<unknown> {
    return this.extRequest('x.ai/mcp/list', {});
  }

  /** Read-only skill listing reloaded from disk (no hooks run, no MCP dialed). */
  async skillsList(cwd: string): Promise<unknown> {
    return this.extRequest('x.ai/skills/list', { cwd });
  }

  /** Read-only hook listing for an attached session. */
  async hooksList(sessionId: string): Promise<unknown> {
    return this.extRequest('x.ai/hooks/list', { sessionId });
  }

  async sessionUsage(sessionId: string): Promise<unknown> {
    return this.extRequest('x.ai/session/usage', { sessionId });
  }

  async interject(params: {
    sessionId: string;
    text: string;
    interjectionId: string;
  }): Promise<unknown> {
    return this.extRequest('x.ai/interject', params);
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
