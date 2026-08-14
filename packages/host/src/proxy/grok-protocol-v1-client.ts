import type {
  ExecutorConfigState,
  InitializeResult as LegacyInitializeResult,
  GrokCapabilities,
  NativeConfigOption,
  NativeConfigValue,
  ProxyNotification as LegacyProxyNotification,
  ProxySession,
  SlashListResult,
} from '@gian/shared';
import {
  OPTIONAL_METHOD_CAPABILITIES,
  PROTOCOL_NAME,
  PROTOCOL_V1,
  ReplayPageValidator,
  type InitializeResult,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import { ProtocolV1Client } from './protocol-v1-client.js';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  RespondApprovalParams,
  StartTurnParams,
} from './types.js';

interface ProtocolConfigOption {
  id: string;
  displayName: string;
  description?: string;
  category?: string;
  type: 'select' | 'boolean' | 'number' | 'text';
  scope: 'session' | 'turn';
  currentValue: NativeConfigValue;
  choices?: Array<{
    value: NativeConfigValue;
    displayName: string;
    description?: string;
    group?: string;
  }>;
}

interface CatalogResult {
  models: Array<{
    id: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
    efforts: Array<{ id: string; displayName: string; isDefault: boolean }>;
  }>;
  modes: Array<{
    id: string;
    displayName: string;
    description: string;
    isDefault: boolean;
  }>;
  sessionOptions: ProtocolConfigOption[];
}

interface ProtocolSession {
  id: string;
  nativeSession?: { id: string };
  streamId: string;
  status: ProxySession['status'];
  model?: string | null;
  mode?: string | null;
  lastError?: string | null;
  configOptions?: ProtocolConfigOption[];
  createdAt: string;
  updatedAt: string;
}

interface ReplayPage {
  replayStreamId: string;
  events: ProxyNotification[];
  nextCursor: string | null;
}

export function normalizeProtocolConfigOptions(
  options: readonly ProtocolConfigOption[] | undefined,
): NativeConfigOption[] {
  return (options ?? []).map(option => ({
    id: option.id,
    name: option.displayName,
    ...(option.description !== undefined ? { description: option.description } : {}),
    ...(option.category !== undefined ? { category: option.category } : {}),
    type: option.type,
    currentValue: option.currentValue,
    scope: option.scope,
    ...(option.choices ? {
      choices: option.choices.map(choice => ({
        value: choice.value,
        label: choice.displayName,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
        ...(choice.group !== undefined ? { group: choice.group } : {}),
      })),
    } : {}),
  }));
}

function configState(options: readonly NativeConfigOption[]): ExecutorConfigState {
  return {
    schemaVersion: 1,
    values: Object.fromEntries(options.map(option => [option.id, option.currentValue])),
  };
}

export interface GrokProtocolV1HostOptions {
  entry: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  dataDir: string;
  hostVersion: string;
  runtimeBin: string;
  env?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
}

export class GrokProtocolV1Host {
  private readonly client: ProtocolV1Client;
  private readonly sessions = new Map<string, GrokProtocolV1SessionClient>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private initialized: Promise<InitializeResult> | null = null;
  private catalogResult: Promise<CatalogResult> | null = null;
  private exitNotified = false;
  private exitCode: number | null | undefined;

  constructor(options: GrokProtocolV1HostOptions) {
    this.client = new ProtocolV1Client({
      entry: options.entry,
      pluginId: 'grok',
      pluginVersion: options.pluginVersion,
      processScope: options.processScope,
      dataDir: options.dataDir,
      hostVersion: options.hostVersion,
      runtimeBin: options.runtimeBin,
      ...(options.env ? { env: options.env } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    this.client.onNotification(notification => this.deliverNotification(notification));
    this.client.onExit(code => this.notifyExit(code));
  }

  createSessionClient(hostSessionId: string): GrokProtocolV1SessionClient {
    const facade = new GrokProtocolV1SessionClient(this, hostSessionId);
    this.sessions.set(hostSessionId, facade);
    return facade;
  }

  async initialize(): Promise<LegacyInitializeResult> {
    const result = await this.initializeV1();
    return {
      mode: 'spawn',
      protocolVersion: `${result.protocol.name}/${result.protocol.version}`,
      methods: [
        'initialize',
        'catalog.list',
        'session.create',
        'session.get',
        'turn.start',
        'turn.interrupt',
        'session.close',
        'shutdown',
        ...Object.entries(OPTIONAL_METHOD_CAPABILITIES)
          .filter(([, capability]) => result.capabilities[capability] !== undefined)
          .map(([method]) => method),
      ],
    };
  }

  async capabilities(): Promise<GrokCapabilities> {
    const [initialized, catalog] = await Promise.all([this.initializeV1(), this.catalog()]);
    return {
      protocolVersion: `${PROTOCOL_NAME}/${PROTOCOL_V1}`,
      models: catalog.models.map(model => ({
        id: model.id,
        model: model.id,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        isDefault: model.isDefault,
        defaultThinking: model.efforts.find(effort => effort.isDefault)?.id ?? null,
        supportedThinking: model.efforts.map(effort => effort.id),
      })),
      modes: catalog.modes.map(mode => ({
        id: mode.id,
        label: mode.displayName,
        description: mode.description,
        isDefault: mode.isDefault,
      })),
      slashCommands: [],
      sessionCapabilities: {
        load: initialized.capabilities['session.replay'] !== undefined,
        list: initialized.capabilities['session.nativeList'] !== undefined,
        resume: true,
        close: true,
      },
    };
  }

  request<T>(method: Parameters<ProtocolV1Client['request']>[0], params: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }

  unregister(sessionId: string, facade: GrokProtocolV1SessionClient): void {
    if (this.sessions.get(sessionId) === facade) this.sessions.delete(sessionId);
  }

  hasSessions(): boolean {
    return [...this.sessions.values()].some(session => session.hasAttachedSession());
  }

  isExited(): boolean { return this.client.isExited(); }
  processGroupId(): number { return this.client.processGroupId(); }
  observeProcessGroupAbsence(): void { this.client.observeProcessGroupAbsence(); }
  shutdown(): Promise<void> { return this.client.shutdown(); }

  onHostExit(handler: (code: number | null) => void): () => void {
    if (this.exitNotified) {
      const code = this.exitCode ?? null;
      let active = true;
      queueMicrotask(() => { if (active) handler(code); });
      return () => { active = false; };
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private initializeV1(): Promise<InitializeResult> {
    this.initialized ??= this.client.initialize();
    return this.initialized;
  }

  private async catalog(): Promise<CatalogResult> {
    await this.initializeV1();
    this.catalogResult ??= this.client.catalog() as Promise<CatalogResult>;
    return this.catalogResult;
  }

  private deliverNotification(notification: ProxyNotification): void {
    if (!('sessionId' in notification.params)) return;
    this.sessions.get(notification.params.sessionId)?.deliverNotification(notification);
  }

  private notifyExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exitCode = code;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.notifyHostExit(code);
    for (const handler of this.exitHandlers) handler(code);
  }
}

export class GrokProtocolV1SessionClient implements ProxyClient {
  readonly executor = 'grok' as const;
  readonly protocolV1 = true as const;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private stream: string | null = null;
  private nativeSessionId: string | null = null;
  private cwd: string | null = null;
  private model: string | null = null;
  private mode: string | null = null;
  private options: NativeConfigOption[] = [];
  private activeTurnId: string | null = null;
  private closed = false;
  private exitNotified = false;
  private exitCode: number | null | undefined;

  constructor(
    private readonly host: GrokProtocolV1Host,
    private readonly hostSessionId: string,
  ) {}

  runtimeHost(): GrokProtocolV1Host { return this.host; }
  isExited(): boolean { return this.host.isExited(); }
  hasAttachedSession(): boolean { return this.stream !== null; }
  initialize(): Promise<LegacyInitializeResult> { return this.host.initialize(); }
  capabilities(): Promise<GrokCapabilities> { return this.host.capabilities(); }

  async listNativeSessions(params?: { cwd?: string; cursor?: string }): Promise<unknown> {
    const result = await this.host.request<{
      sessions: Array<{ id: string; displayName?: string; cwd?: string; updatedAt?: string }>;
      nextCursor: string | null;
    }>('session.native.list', {
      ...(params?.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params?.cursor !== undefined ? { cursor: params.cursor } : {}),
      limit: 100,
    });
    return {
      sessions: result.sessions.map(session => ({
        sessionId: session.id,
        ...(session.displayName !== undefined ? { title: session.displayName } : {}),
        ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
        ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
      })),
      nextCursor: result.nextCursor,
    };
  }

  async listSlashCommands(): Promise<SlashListResult> {
    if (!this.stream) return { commands: [] };
    return this.host.request('slash.list', {
      sessionId: this.hostSessionId,
      streamId: this.stream,
    });
  }

  async createSession(params: CreateSessionParams) {
    await this.initialize();
    const result = await this.host.request<{ session: ProtocolSession }>('session.create', {
      sessionId: this.hostSessionId,
      cwd: params.cwd,
      workspaceRoots: [params.cwd],
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.nativeSessionId ? {
        nativeSession: {
          id: params.nativeSessionId,
          ...(params.resumeMode ? { mode: params.resumeMode } : {}),
        },
      } : {}),
      config: {},
    });
    const nativeSessionId = result.session.nativeSession?.id;
    if (!nativeSessionId) {
      throw new Error('Grok gian.proxy/1 session.create omitted nativeSession.id.');
    }
    this.stream = result.session.streamId;
    this.nativeSessionId = nativeSessionId;
    this.cwd = params.cwd;
    this.model = result.session.model ?? params.model ?? null;
    this.mode = result.session.mode ?? null;
    this.options = normalizeProtocolConfigOptions(result.session.configOptions);
    const replay = params.resumeMode === 'load'
      ? await this.loadReplay()
      : null;
    return {
      session: this.legacySession(result.session),
      nativeSessionId,
      configOptions: this.options,
      replayUpdates: replay?.events ?? [],
      ...(replay ? { replayStreamId: replay.replayStreamId } : {}),
    };
  }

  async startTurn(params: StartTurnParams) {
    const turnId = params.turnId;
    if (!turnId) throw new Error('Grok gian.proxy/1 turn.start requires a Host turnId.');
    const cwd = this.cwd;
    if (!cwd) throw new Error('Grok gian.proxy/1 session has no cwd.');
    this.activeTurnId = turnId;
    try {
      await this.host.request('turn.start', {
        sessionId: this.hostSessionId,
        streamId: this.requireStream(),
        turnId,
        input: params.input,
        policy: {
          workspaceRoots: [cwd],
          approval: this.mode === 'always_approve' ? 'never' : this.mode === 'auto' ? 'auto' : 'relay',
          network: 'allow',
        },
        config: {
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.thinking !== undefined ? { effort: params.thinking } : {}),
          ...(this.mode !== null ? { mode: this.mode } : {}),
          native: {},
        },
      });
    } catch (error) {
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      throw error;
    }
    if (params.model !== undefined) this.model = params.model;
    return {
      session: this.currentSession(this.activeTurnId === turnId ? 'running' : 'idle'),
      turn: { id: turnId },
    };
  }

  async interruptTurn(): Promise<void> {
    await this.host.request('turn.interrupt', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId: this.requireTurn(),
    });
  }

  async respondApproval(params: RespondApprovalParams): Promise<void> {
    if (!params.nativeOptionId) {
      throw new Error('Grok gian.proxy/1 approvals require the exact Proxy option id.');
    }
    await this.host.request('approval.respond', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId: this.requireTurn(),
      approvalId: params.approvalId,
      optionId: params.nativeOptionId,
      ...(params.answers ? { answers: params.answers } : {}),
    });
  }

  async getNativeConfig() {
    const result = await this.host.request<{ session: ProtocolSession }>('session.get', {
      sessionId: this.hostSessionId,
    });
    this.options = normalizeProtocolConfigOptions(result.session.configOptions);
    return { state: configState(this.options), options: this.options };
  }

  async setNativeConfig(configId: string, value: NativeConfigValue) {
    const result = await this.host.request<{
      session: ProtocolSession;
      configOptions: ProtocolConfigOption[];
    }>('session.config.set', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      optionId: configId,
      value,
    });
    this.options = normalizeProtocolConfigOptions(result.configOptions);
    this.model = result.session.model ?? this.model;
    this.mode = result.session.mode ?? this.mode;
    return { state: configState(this.options), options: this.options };
  }

  async closeSession(): Promise<void> {
    if (!this.stream) return;
    const streamId = this.stream;
    await this.host.request('session.close', {
      sessionId: this.hostSessionId,
      streamId,
    });
    this.stream = null;
    this.activeTurnId = null;
  }

  replaySession(): Promise<{ replayStreamId: string; events: ProxyNotification[] }> {
    return this.loadReplay();
  }

  async setName(name: string): Promise<void> {
    await this.host.request('session.rename', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      name,
    });
  }

  async steerTurn(params: { sessionId: string; input: import('@gian/shared').InputItem[] }) {
    const turnId = this.requireTurn();
    await this.host.request('turn.steer', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId,
      input: params.input,
    });
    return { ok: true as const, turnId };
  }

  async deleteNativeSession(nativeSessionId: string): Promise<void> {
    await this.host.request('session.native.delete', { nativeSessionId });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeSession();
    } finally {
      this.host.unregister(this.hostSessionId, this);
      await this.host.shutdown();
    }
  }

  forceKill(): void {
    if (this.closed) return;
    this.closed = true;
    void this.closeSession().catch(() => undefined);
    this.host.unregister(this.hostSessionId, this);
    void this.host.shutdown();
  }

  onNotification(handler: NotificationHandler): () => void {
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

  deliverNotification(notification: ProxyNotification): void {
    if (
      (notification.method === 'turn.completed' || notification.method === 'turn.failed')
      && notification.params.turnId === this.activeTurnId
    ) {
      this.activeTurnId = null;
    } else if (notification.method === 'session.updated') {
      const data = notification.params.data;
      if (data.nativeSession) this.nativeSessionId = data.nativeSession.id;
      if (data.model !== undefined) this.model = data.model;
      if (data.mode !== undefined) this.mode = data.mode;
      if (data.configOptions) this.options = normalizeProtocolConfigOptions(data.configOptions);
    }
    const legacy = notification as unknown as LegacyProxyNotification;
    for (const handler of this.notificationHandlers) handler(legacy);
  }

  notifyHostExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exitCode = code;
    for (const handler of this.exitHandlers) handler(code);
  }

  private async loadReplay(): Promise<{ replayStreamId: string; events: ProxyNotification[] }> {
    const validator = new ReplayPageValidator(this.hostSessionId);
    const events: ProxyNotification[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page: ReplayPage = await this.host.request<ReplayPage>('session.replay', {
        sessionId: this.hostSessionId,
        streamId: this.requireStream(),
        cursor,
        limit: 500,
      });
      validator.acceptPage(page);
      events.push(...page.events);
      if (page.nextCursor === null) {
        return { replayStreamId: page.replayStreamId, events };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`Grok replay cursor ${page.nextCursor} was repeated.`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('Grok replay exceeded 100 pages.');
  }

  private requireStream(): string {
    if (!this.stream) throw new Error('Grok gian.proxy/1 session is not attached.');
    return this.stream;
  }

  private requireTurn(): string {
    if (!this.activeTurnId) throw new Error('Grok gian.proxy/1 session has no active turn.');
    return this.activeTurnId;
  }

  private legacySession(session: ProtocolSession): ProxySession {
    return {
      id: session.id,
      cwd: this.cwd ?? '',
      model: session.model ?? this.model,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError ?? null,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
      configOptions: this.options,
    };
  }

  private currentSession(status: ProxySession['status']): ProxySession {
    const now = new Date().toISOString();
    return {
      id: this.hostSessionId,
      cwd: this.cwd ?? '',
      model: this.model,
      status,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
      configOptions: this.options,
    };
  }
}
