import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  ExecutorConfigState,
  InitializeResult,
  JsonRpcResponse,
  KimiCapabilities,
  NativeConfigChoice,
  NativeConfigOption,
  NativeConfigValue,
  ProxyNotification,
  ProxySession,
  SlashCommand,
  SlashListResult,
} from '@gian/shared';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  RespondApprovalParams,
  StartTurnParams,
} from './types.js';

export interface KimiProxyHostOptions {
  entry: string;
  kimiBin: string;
  nodeBin?: string;
  env?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface RawConfigOption {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

interface RawProxySession extends Omit<ProxySession, 'configOptions' | 'slashCommands'> {
  nativeSessionId?: string;
  configOptions?: RawConfigOption[];
  slashCommands?: unknown[];
}

function configChoices(raw: unknown): NativeConfigChoice[] {
  if (!Array.isArray(raw)) return [];
  const choices: NativeConfigChoice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.options)) {
      const group = typeof record.name === 'string' ? record.name : undefined;
      for (const nested of configChoices(record.options)) {
        choices.push(group ? { ...nested, group } : nested);
      }
      continue;
    }
    if (typeof record.value !== 'string' || typeof record.name !== 'string') continue;
    choices.push({
      value: record.value,
      label: record.name,
      ...(typeof record.description === 'string'
        ? { description: record.description }
        : {}),
    });
  }
  return choices;
}

export function normalizeKimiConfigOptions(raw: unknown): NativeConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const result: NativeConfigOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const option = item as RawConfigOption;
    if (typeof option.id !== 'string' || typeof option.name !== 'string') continue;
    const type = option.type === 'boolean' ? 'boolean' : 'select';
    result.push({
      id: option.id,
      name: option.name,
      type,
      currentValue: type === 'boolean'
        ? option.currentValue === true
        : (typeof option.currentValue === 'string' ? option.currentValue : null),
      scope: 'session',
      ...(typeof option.category === 'string' ? { category: option.category } : {}),
      ...(typeof option.description === 'string'
        ? { description: option.description }
        : {}),
      ...(type === 'select' ? { choices: configChoices(option.options) } : {}),
    });
  }
  return result;
}

function configState(options: NativeConfigOption[]): ExecutorConfigState {
  return {
    schemaVersion: 1,
    values: Object.fromEntries(options.map(option => [option.id, option.currentValue])),
  };
}

export function normalizeKimiSlashCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: SlashCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const command = item as Record<string, unknown>;
    if (typeof command.name !== 'string') continue;
    const name = command.name.startsWith('/') ? command.name : `/${command.name}`;
    commands.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      source: 'builtin',
      ...(
        command.input
        && typeof command.input === 'object'
        && typeof (command.input as { hint?: unknown }).hint === 'string'
          ? {
              argHints: [{
                kind: 'free' as const,
                placeholder: (command.input as { hint: string }).hint,
              }],
            }
          : {}
      ),
    });
  }
  return commands;
}

function normalizeCapabilities(raw: unknown): KimiCapabilities {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const agentCapabilities = record.agentCapabilities
    && typeof record.agentCapabilities === 'object'
    ? record.agentCapabilities as Record<string, unknown>
    : {};
  const sessionCapabilities = agentCapabilities.sessionCapabilities
    && typeof agentCapabilities.sessionCapabilities === 'object'
    ? agentCapabilities.sessionCapabilities as Record<string, unknown>
    : {};
  const agentInfo = record.agentInfo && typeof record.agentInfo === 'object'
    ? record.agentInfo as Record<string, unknown>
    : null;
  const authMethods = Array.isArray(record.authMethods)
    ? record.authMethods.flatMap(method => {
        if (!method || typeof method !== 'object') return [];
        const value = method as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.name !== 'string') return [];
        return [{
          id: value.id,
          name: value.name,
          ...(typeof value.description === 'string'
            ? { description: value.description }
            : {}),
        }];
      })
    : undefined;
  const modes = Array.isArray(record.modes)
    ? record.modes.flatMap(mode => {
        if (!mode || typeof mode !== 'object') return [];
        const value = mode as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.label !== 'string') return [];
        return [{
          id: value.id,
          label: value.label,
          description: typeof value.description === 'string' ? value.description : '',
          isDefault: value.isDefault === true,
        }];
      })
    : [];
  return {
    protocolVersion: String(record.protocolVersion ?? '1'),
    models: [],
    modes,
    slashCommands: [],
    ...(agentInfo
      ? {
          agentInfo: {
            ...(typeof agentInfo.name === 'string' ? { name: agentInfo.name } : {}),
            ...(typeof agentInfo.title === 'string' ? { title: agentInfo.title } : {}),
            ...(typeof agentInfo.version === 'string' ? { version: agentInfo.version } : {}),
          },
        }
      : {}),
    ...(authMethods ? { authMethods } : {}),
    sessionCapabilities: {
      load: agentCapabilities.loadSession === true,
      list: sessionCapabilities.list != null,
      resume: sessionCapabilities.resume != null,
      close: sessionCapabilities.close != null,
    },
  };
}

class ProxyRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProxyRequestError';
  }
}

export class KimiProxyHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, KimiProxySessionClient>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private readonly log: (message: string) => void;
  private nextId = 1;
  private exited = false;
  private initialized: Promise<InitializeResult> | null = null;
  private capabilities_: Promise<KimiCapabilities> | null = null;

  constructor(options: KimiProxyHostOptions) {
    this.log = options.log ?? (() => {});
    this.child = spawn(
      options.nodeBin ?? process.execPath,
      [options.entry, '--kimi-bin', options.kimiBin],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
      },
    );
    this.bindStdout();
    this.bindStderr();
    this.bindExit();
  }

  initialize(): Promise<InitializeResult> {
    if (!this.initialized) this.initialized = this.request<InitializeResult>('initialize');
    return this.initialized;
  }

  capabilities(): Promise<KimiCapabilities> {
    if (!this.capabilities_) {
      this.capabilities_ = this.request<unknown>('capabilities.list')
        .then(normalizeCapabilities);
    }
    return this.capabilities_;
  }

  async createSession(
    params: CreateSessionParams,
    facade: KimiProxySessionClient,
  ): Promise<{
    session: ProxySession;
    nativeSessionId: string;
    configOptions: NativeConfigOption[];
    replayUpdates: unknown[];
  }> {
    const result = await this.request<{
      session: RawProxySession;
      replayUpdates?: unknown[];
    }>('session.create', {
      cwd: params.cwd,
      ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
      ...(params.resumeMode ? { resumeMode: params.resumeMode } : {}),
      mcpServers: params.mcpServers ?? [],
    });
    const nativeSessionId = result.session.nativeSessionId;
    if (typeof nativeSessionId !== 'string' || !nativeSessionId) {
      throw new Error('kimi-proxy createSession returned without nativeSessionId');
    }
    const options = normalizeKimiConfigOptions(result.session.configOptions);
    const session: ProxySession = {
      ...result.session,
      nativeSessionId,
      configOptions: options,
      slashCommands: normalizeKimiSlashCommands(result.session.slashCommands),
    };
    this.sessions.set(session.id, facade);
    return {
      session,
      nativeSessionId,
      configOptions: options,
      replayUpdates: result.replayUpdates ?? [],
    };
  }

  startTurn(params: StartTurnParams) {
    return this.request<{ session: ProxySession; turn: { id: string } }>('turn.start', params);
  }

  interruptTurn(sessionId: string): Promise<void> {
    return this.request<void>('turn.interrupt', { sessionId });
  }

  respondApproval(params: RespondApprovalParams): Promise<void> {
    return this.request<void>('approval.respond', params);
  }

  async snapshot(sessionId: string): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
    commands: SlashCommand[];
  }> {
    const result = await this.request<{
      configOptions?: unknown;
      slashCommands?: unknown;
    }>('session.snapshot', { sessionId });
    const options = normalizeKimiConfigOptions(result.configOptions);
    return {
      state: configState(options),
      options,
      commands: normalizeKimiSlashCommands(result.slashCommands),
    };
  }

  async setConfig(
    sessionId: string,
    configId: string,
    value: NativeConfigValue,
  ): Promise<{ state: ExecutorConfigState; options: NativeConfigOption[] }> {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error('Kimi ACP currently accepts string or boolean config values.');
    }
    const result = await this.request<{ configOptions?: unknown }>(
      'session.config.set',
      { sessionId, configId, value },
    );
    const options = normalizeKimiConfigOptions(result.configOptions);
    return { state: configState(options), options };
  }

  async listSlashCommands(sessionId: string): Promise<SlashListResult> {
    const result = await this.request<{ commands?: unknown }>('slash.list', { sessionId });
    return { commands: normalizeKimiSlashCommands(result.commands) };
  }

  listNativeSessions(params?: { cwd?: string; cursor?: string }): Promise<unknown> {
    return this.request('session.listNative', params ?? {});
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.request('session.close', { sessionId }).catch(error => {
      this.log(`[kimi-proxy] session.close failed: ${String(error)}`);
    });
  }

  onHostExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    await this.request('shutdown').catch(() => undefined);
    if (!this.exited) this.child.kill('SIGTERM');
  }

  private bindStdout(): void {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.dispatch(JSON.parse(trimmed) as unknown);
      } catch {
        this.log(`[kimi-proxy] non-JSON line: ${trimmed}`);
      }
    });
  }

  private bindStderr(): void {
    const lines = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    lines.on('line', line => {
      if (line.trim()) this.log(`[kimi-proxy:stderr] ${line}`);
    });
  }

  private bindExit(): void {
    this.child.on('exit', code => {
      this.exited = true;
      const error = new Error(`kimi-proxy exited (code=${code ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const session of this.sessions.values()) session.notifyHostExit(code);
      this.sessions.clear();
      for (const handler of this.exitHandlers) handler(code);
    });
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if ('id' in record && (typeof record.id === 'number' || typeof record.id === 'string')) {
      const id = typeof record.id === 'number' ? record.id : Number(record.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const response = record as unknown as JsonRpcResponse;
      if ('error' in response) {
        pending.reject(new ProxyRequestError(response.error.code, response.error.message));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof record.method !== 'string') return;
    const notification = record as unknown as ProxyNotification;
    const proxySessionId = notification.params?.sessionId;
    if (proxySessionId) {
      const session = this.sessions.get(proxySessionId);
      if (session) session.deliverNotification(notification);
      else this.log(`[kimi-proxy] notification for unknown sessionId=${proxySessionId}`);
      return;
    }
    for (const session of this.sessions.values()) session.deliverNotification(notification);
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('kimi-proxy already exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.child.stdin.write(`${JSON.stringify(
        params === undefined ? { id, method } : { id, method, params },
      )}\n`);
    });
  }
}

export class KimiProxySessionClient implements ProxyClient {
  readonly executor = 'kimi' as const;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private proxySessionId: string | null = null;
  private closed = false;

  constructor(private readonly host: KimiProxyHost) {}

  hasAttachedSession(): boolean {
    return this.proxySessionId !== null;
  }

  initialize() {
    return this.host.initialize();
  }

  capabilities() {
    return this.host.capabilities();
  }

  listSlashCommands(): Promise<SlashListResult> {
    return this.proxySessionId
      ? this.host.listSlashCommands(this.proxySessionId)
      : Promise.resolve({ commands: [] });
  }

  async createSession(params: CreateSessionParams) {
    const result = await this.host.createSession(params, this);
    this.proxySessionId = result.session.id;
    return result;
  }

  startTurn(params: StartTurnParams) {
    return this.host.startTurn(params);
  }

  interruptTurn(sessionId: string) {
    return this.host.interruptTurn(sessionId);
  }

  respondApproval(params: RespondApprovalParams) {
    return this.host.respondApproval(params);
  }

  async getNativeConfig() {
    if (!this.proxySessionId) throw new Error('Kimi session is not attached.');
    const snapshot = await this.host.snapshot(this.proxySessionId);
    return { state: snapshot.state, options: snapshot.options };
  }

  async setNativeConfig(configId: string, value: NativeConfigValue) {
    if (!this.proxySessionId) throw new Error('Kimi session is not attached.');
    return this.host.setConfig(this.proxySessionId, configId, value);
  }

  listNativeSessions(params?: { cwd?: string; cursor?: string }) {
    return this.host.listNativeSessions(params);
  }

  async closeSession(sessionId: string) {
    await this.host.closeSession(sessionId);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.proxySessionId) await this.host.closeSession(this.proxySessionId);
  }

  forceKill(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proxySessionId) void this.host.closeSession(this.proxySessionId);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  deliverNotification(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }

  notifyHostExit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}
