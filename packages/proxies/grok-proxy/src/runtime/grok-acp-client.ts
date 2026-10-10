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

import { buildSpawnArgs } from '../core/mcp-isolation.js';
import { agentHome, grokChildHomeEnv } from '../core/home.js';
import type { GrokSandboxProfile } from '../core/sandbox.js';
import {
  fromWireExtensionMethod,
  GrokExtBusinessError,
  isInterjectSessionMissing,
  isWireMethodNotFound,
  toWireExtensionMethod,
  unwrapExtMethodResult,
} from './acp-wire.js';
import {
  extensionSupportFromInitialize,
  type GrokExtMethod,
  type GrokExtensionSupport,
  NO_EXTENSION_SUPPORT,
} from './grok-extensions.js';

export { GrokExtBusinessError, isWireMethodNotFound };

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_MS = 3_000;

export const GROK_DEFAULT_DENY_RULES = ['MCPTool(*)'] as const;

/** Spawn prefix with the default MCP isolation boundary (no Host MCP). */
export const GROK_SPAWN_PREFIX = buildSpawnArgs(GROK_DEFAULT_DENY_RULES);

/** Origin product written into initialize and session meta. The yolo
 *  notification does not send this: a sender id the runtime cannot match
 *  applies to nobody, and an omitted sender applies to every resident
 *  session in this process. */
export const GROK_ORIGIN_CLIENT_ID = 'gian-grok-proxy';

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

export interface GrokAcpStopOptions {
  force?: boolean;
}

export interface GrokAcpTransport {
  connection: ClientSideConnection;
  exit: Promise<GrokAcpExit>;
  stop(options?: GrokAcpStopOptions): Promise<void>;
}

export type GrokAcpTransportFactory = (client: Client) => Promise<GrokAcpTransport>;

/** The Agent HOME this Proxy serves: re-exported from core/home.js, which
 *  owns the single resolution rule shared with the MCP disk scan. */
export { agentHome, grokChildHomeEnv };

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
  /** Requested GROK_SANDBOX value. Defaults to workspace. This does not
   *  read or confirm an effective sandbox. */
  sandboxProfile?: GrokSandboxProfile;
  /** When false, search_tool and use_tool stay available so a later
   *  fail-closed catalog check can allow Host MCP. Defaults to disallowed. */
  disallowMetaTools?: boolean;
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
  return isWireMethodNotFound(error);
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

export function grokChildProcessEnv(
  env: NodeJS.ProcessEnv,
  sandboxProfile: GrokSandboxProfile,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...grokChildHomeEnv(env),
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_SANDBOX: sandboxProfile,
  };
}

function processTransportFactory(
  options: Pick<GrokAcpClientOptions, 'binaryPath' | 'cwd' | 'env' | 'gracefulStopMs' | 'spawnDenyRules' | 'sandboxProfile' | 'disallowMetaTools'>,
  emitDebug: (message: string) => void,
): GrokAcpTransportFactory {
  return async (client) => {
    const args = [
      ...buildSpawnArgs(options.spawnDenyRules ?? GROK_DEFAULT_DENY_RULES, {
        disallowMetaTools: options.disallowMetaTools !== false,
      }),
      'agent',
      '--no-leader',
      'stdio',
    ];
    const child = spawn(options.binaryPath, args, {
      cwd: options.cwd,
      env: grokChildProcessEnv(
        { ...process.env, ...options.env },
        options.sandboxProfile ?? 'workspace',
      ),
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
      async stop(stopOptions?: GrokAcpStopOptions) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (stopOptions?.force) {
          // Metadata-only inspections have no session state to flush.
          child.kill('SIGKILL');
          await exit;
          return;
        }
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
        this.emit('extensionNotification', fromWireExtensionMethod(method), params);
      },
      extMethod: async (method: string, params: unknown) => {
        const logical = fromWireExtensionMethod(method);
        // Reverse requests from the agent must be answered honestly: the old
        // blanket `{}` return silently mis-answered structured questions.
        if (!this.extMethodHandler) {
          throw new Error(`Method not found: ${logical}`);
        }
        const result = await this.extMethodHandler(logical, params);
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
      clientInfo: { name: GROK_ORIGIN_CLIENT_ID, version: '0.2.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      _meta: { clientIdentifier: GROK_ORIGIN_CLIENT_ID },
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

  /** One live extension-request round trip. A prefixed-wire -32601 refutes
   *  the method. A business error does not. Other failures leave it unknown. */
  private async extRequest(method: GrokExtMethod, params: unknown): Promise<unknown> {
    if (!this.extSupport.mayAttempt(method)) {
      throw new GrokExtMethodUnsupportedError(method, this.extSupport.unsupportedReason(method));
    }
    try {
      const raw = await (await this.ext()).sendRequest(toWireExtensionMethod(method), params);
      const result = unwrapExtMethodResult(method, raw);
      if (method === 'x.ai/interject') {
        const status = result && typeof result === 'object'
          ? (result as { status?: unknown }).status
          : undefined;
        if (status !== 'queued') {
          throw new GrokExtBusinessError(method, 'interject did not return status queued');
        }
      }
      this.extSupport.confirm(method);
      return result;
    } catch (error) {
      if (error instanceof GrokExtBusinessError) throw error;
      if (isWireMethodNotFound(error)) {
        this.extSupport.refute(method);
        throw new GrokExtMethodUnsupportedError(method, this.extSupport.unsupportedReason(method));
      }
      throw error;
    }
  }

  /**
   * Side-effect-free interject probe. Confirms only on -32602 "session not
   * found" for a session that does not exist. A queued result is not proof.
   * -32601 on the prefixed wire refutes. Anything else stays unknown.
   */
  async probeInterjectRegistered(): Promise<'confirmed' | 'refuted' | 'unknown'> {
    await this.ensureStarted();
    const method = 'x.ai/interject' as const;
    // A prefixed-wire -32601 is a confirmed negative. Later probes must keep
    // that answer; `mayAttempt` would otherwise hide it as `unknown`.
    if (this.extSupport.state(method) === 'refuted') return 'refuted';
    if (!this.extSupport.mayAttempt(method)) return 'unknown';
    try {
      await (await this.ext()).sendRequest(toWireExtensionMethod(method), {
        sessionId: 'gian-probe-missing-session',
        text: 'probe',
        interjectionId: 'gian-probe',
      });
      return 'unknown';
    } catch (error) {
      if (isWireMethodNotFound(error)) {
        this.extSupport.refute(method);
        return 'refuted';
      }
      if (isInterjectSessionMissing(error)) {
        this.extSupport.confirm(method);
        return 'confirmed';
      }
      return 'unknown';
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

  /**
   * Send `session/prompt` and resolve once the request has been registered
   * with the transport — the dispatch point after which the native session
   * owns the prompt. The prompt's own response settles separately, so the
   * caller can count a dispatched prompt without awaiting the whole turn.
   */
  async dispatchPrompt(params: PromptRequest): Promise<{ response: Promise<PromptResponse> }> {
    return { response: (await this.connection()).prompt(params) };
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
  async mcpList(sessionId?: string): Promise<unknown> {
    return this.extRequest('x.ai/mcp/list', {
      ...(sessionId ? { sessionId } : {}),
    });
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
    content?: ReadonlyArray<Record<string, unknown>>;
  }): Promise<unknown> {
    return this.extRequest('x.ai/interject', {
      sessionId: params.sessionId,
      text: params.text,
      interjectionId: params.interjectionId,
      ...(params.content ? { content: [...params.content] } : {}),
    });
  }

  /**
   * Asks the runtime to use this mode on the next prompt. A resolved send is
   * not proof the mode was applied.
   *
   * `x.ai/yolo_mode_changed` does not filter on `sessionId`. An omitted
   * `clientIdentifier` updates every resident session. A present one updates
   * only sessions whose `origin_client.product` equals it, and that product
   * is the session `_meta.clientIdentifier` (initialize is only the fallback).
   * The value here must be the identifier this session was created with.
   */
  async notifyPermissionMode(params: {
    sessionId: string;
    clientIdentifier: string;
    permission_mode: string;
    yolo_mode: boolean;
    auto_mode: boolean;
  }): Promise<void> {
    await (await this.ext()).sendNotification(toWireExtensionMethod('x.ai/yolo_mode_changed'), {
      sessionId: params.sessionId,
      clientIdentifier: params.clientIdentifier,
      permission_mode: params.permission_mode,
      yolo_mode: params.yolo_mode,
      auto_mode: params.auto_mode,
    });
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    if ((await this.ensureStarted()).agentCapabilities?.sessionCapabilities?.close == null) {
      throw new Error('Grok ACP does not advertise session/close.');
    }
    await (await this.connection()).closeSession(params);
  }

  async stop(options?: GrokAcpStopOptions): Promise<void> {
    if (this.startPromise && !this.transport) {
      await this.startPromise.catch(() => undefined);
    }
    const transport = this.transport;
    this.transport = null;
    this.initializeResponse = null;
    this.startPromise = null;
    if (transport) {
      this.expectedStops.add(transport);
      await transport.stop(options);
    }
  }
}
