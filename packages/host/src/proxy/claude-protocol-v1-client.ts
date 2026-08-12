import type {
  InitializeResult as LegacyInitializeResult,
  ProxyCapabilities,
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
}

export interface ClaudeProtocolV1ClientOptions {
  entry: string;
  pluginVersion: string;
  processScope: 'session';
  dataDir: string;
  hostVersion: string;
  hostSessionId: string;
  runtimeBin?: string;
  env?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
}

function modeFromTurn(params: StartTurnParams): string {
  switch (params.permissionMode) {
    case 'plan': return 'plan';
    case 'auto': return 'auto';
    case 'bypassPermissions': return 'full-access';
    default: return 'ask';
  }
}

function approvalPolicy(params: StartTurnParams): 'relay' | 'auto' | 'never' {
  if (params.permissionMode === 'bypassPermissions') return 'never';
  return params.permissionMode === 'auto' ? 'auto' : 'relay';
}

export class ClaudeProtocolV1Client implements ProxyClient {
  readonly executor = 'claude' as const;
  readonly protocolV1 = true as const;
  private readonly client: ProtocolV1Client;
  private readonly hostSessionId: string;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private initialized: Promise<InitializeResult> | null = null;
  private catalogResult: Promise<CatalogResult> | null = null;
  private attachedStreamId: string | null = null;
  private nativeSessionId: string | null = null;
  private cwd: string | null = null;
  private model: string | null = null;
  private activeTurnId: string | null = null;
  private createdAt = new Date().toISOString();
  private closed = false;
  private exitNotified = false;
  private exitCode: number | null | undefined;

  constructor(options: ClaudeProtocolV1ClientOptions) {
    this.hostSessionId = options.hostSessionId;
    this.client = new ProtocolV1Client({
      entry: options.entry,
      pluginId: 'claude',
      pluginVersion: options.pluginVersion,
      processScope: options.processScope,
      dataDir: options.dataDir,
      hostVersion: options.hostVersion,
      ...(options.runtimeBin ? { runtimeBin: options.runtimeBin } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    this.client.onNotification(notification => this.deliverNotification(notification));
    this.client.onExit(code => this.notifyExit(code));
  }

  isExited(): boolean { return this.client.isExited(); }

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

  async capabilities(): Promise<ProxyCapabilities> {
    const catalog = await this.catalog();
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
    };
  }

  async listSlashCommands(): Promise<SlashListResult> {
    if (!this.attachedStreamId) return { commands: [] };
    return this.client.request('slash.list', {
      sessionId: this.hostSessionId,
      streamId: this.attachedStreamId,
    }) as Promise<SlashListResult>;
  }

  async listNativeSessions(params?: { cwd?: string; cursor?: string }): Promise<unknown> {
    await this.initializeV1();
    const result = await this.client.request<{
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

  async createSession(params: CreateSessionParams) {
    await this.initializeV1();
    const result = await this.client.request<{
      session: {
        id: string;
        nativeSession?: { id: string };
        streamId: string;
        status: ProxySession['status'];
        model?: string | null;
        lastError?: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }>('session.create', {
      sessionId: this.hostSessionId,
      cwd: params.cwd,
      workspaceRoots: [params.cwd],
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.claudeSessionId
        ? {
            nativeSession: {
              id: params.claudeSessionId,
              mode: params.resumeMode ?? 'resume',
            },
          }
        : {}),
      config: {},
    });
    const nativeSessionId = result.session.nativeSession?.id;
    if (!nativeSessionId) {
      throw new Error('Claude gian.proxy/1 session.create omitted nativeSession.id.');
    }
    this.attachedStreamId = result.session.streamId;
    this.nativeSessionId = nativeSessionId;
    this.cwd = params.cwd;
    this.model = result.session.model ?? params.model ?? null;
    this.createdAt = result.session.createdAt;
    const replay = params.resumeMode === 'load' ? await this.loadReplay() : null;
    return {
      session: this.legacySession(result.session),
      nativeSessionId,
      replayUpdates: replay?.events ?? [],
      ...(replay ? { replayStreamId: replay.replayStreamId } : {}),
    };
  }

  async startTurn(params: StartTurnParams) {
    const streamId = this.requireStream();
    const turnId = params.turnId;
    if (!turnId) throw new Error('Claude gian.proxy/1 turn.start requires a Host turnId.');
    const cwd = this.cwd;
    if (!cwd) throw new Error('Claude gian.proxy/1 session has no cwd.');
    this.activeTurnId = turnId;
    try {
      await this.client.request('turn.start', {
        sessionId: this.hostSessionId,
        streamId,
        turnId,
        input: params.input,
        policy: {
          workspaceRoots: [cwd],
          approval: approvalPolicy(params),
          network: params.permissionMode === 'bypassPermissions' ? 'allow' : 'ask',
        },
        config: {
          ...(params.model !== undefined ? { model: params.model } : {}),
          mode: modeFromTurn(params),
          ...(params.thinking !== undefined ? { effort: params.thinking } : {}),
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
    const turnId = this.requireTurn();
    await this.client.request('turn.interrupt', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId,
    });
  }

  async respondApproval(params: RespondApprovalParams): Promise<void> {
    await this.client.request('approval.respond', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId: this.requireTurn(),
      approvalId: params.approvalId,
      optionId: params.nativeOptionId
        ?? (params.decision === 'decline' ? 'reject_once' : 'allow_once'),
      ...(params.answers ? { answers: params.answers } : {}),
    });
  }

  async closeSession(): Promise<void> {
    if (!this.attachedStreamId) return;
    await this.client.request('session.close', {
      sessionId: this.hostSessionId,
      streamId: this.attachedStreamId,
    });
    this.attachedStreamId = null;
    this.activeTurnId = null;
  }

  replaySession(): Promise<{ replayStreamId: string; events: ProxyNotification[] }> {
    return this.loadReplay();
  }

  async setName(name: string): Promise<void> {
    await this.client.request('session.rename', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      name,
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeSession();
    } finally {
      await this.client.shutdown();
    }
  }

  forceKill(): void { this.client.forceKill(); }
  processGroupId(): number { return this.client.processGroupId(); }
  observeProcessGroupAbsence(): void { this.client.observeProcessGroupAbsence(); }

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

  private initializeV1(): Promise<InitializeResult> {
    this.initialized ??= this.client.initialize();
    return this.initialized;
  }

  private async catalog(): Promise<CatalogResult> {
    await this.initializeV1();
    this.catalogResult ??= this.client.catalog() as Promise<CatalogResult>;
    return this.catalogResult;
  }

  private async loadReplay(): Promise<{ replayStreamId: string; events: ProxyNotification[] }> {
    const validator = new ReplayPageValidator(this.hostSessionId);
    const events: ProxyNotification[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page: {
        replayStreamId: string;
        events: ProxyNotification[];
        nextCursor: string | null;
      } = await this.client.request('session.replay', {
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
      if (cursors.has(page.nextCursor)) throw new Error('Claude replay cursor repeated.');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('Claude replay exceeded 100 pages.');
  }

  private deliverNotification(notification: ProxyNotification): void {
    if (
      (notification.method === 'turn.completed' || notification.method === 'turn.failed')
      && notification.params.turnId === this.activeTurnId
    ) {
      this.activeTurnId = null;
    } else if (notification.method === 'session.updated') {
      const native = notification.params.data.nativeSession;
      if (native) this.nativeSessionId = native.id;
    }
    const legacy = notification as unknown as LegacyProxyNotification;
    for (const handler of this.notificationHandlers) handler(legacy);
  }

  private notifyExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exitCode = code;
    for (const handler of this.exitHandlers) handler(code);
  }

  private requireStream(): string {
    if (!this.attachedStreamId) throw new Error('Claude gian.proxy/1 session is not attached.');
    return this.attachedStreamId;
  }

  private requireTurn(): string {
    if (!this.activeTurnId) throw new Error('Claude gian.proxy/1 session has no active turn.');
    return this.activeTurnId;
  }

  private legacySession(session: {
    id: string;
    status: ProxySession['status'];
    model?: string | null;
    lastError?: string | null;
    createdAt: string;
    updatedAt: string;
  }): ProxySession {
    return {
      id: session.id,
      cwd: this.cwd ?? '',
      model: session.model ?? this.model,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError ?? null,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
    };
  }

  private currentSession(status: ProxySession['status']): ProxySession {
    return {
      id: this.hostSessionId,
      cwd: this.cwd ?? '',
      model: this.model,
      status,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      lastError: null,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
    };
  }
}
