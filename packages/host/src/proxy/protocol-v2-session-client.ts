import {
  requestViolation,
  type ForkAnchor,
  type ForkOrigin,
  type InitializeResult,
  type ProxyNotification,
  type ReplayEvent,
  type SideChatSnapshot,
} from '@gian/proxy-protocol';
import { ProtocolV2Client, type ProtocolV2ClientOptions } from './protocol-v2-client.js';
import type {
  CreateSessionParams,
  NativeSessionListParams,
  ProxyClient,
  RespondInteractionParams,
  StartTurnParams,
  SteerTurnParams,
} from './types.js';
import { type Executor, type ProxyCatalog, type ProxySession } from '@gian/shared';

export function normalizeProtocolCatalog<T extends ProxyCatalog>(catalog: T): T {
  const slots = catalog.specialCatalogs;
  if (!slots) return catalog;
  const roleById = new Map<string, string>([
    ...(slots.model ? [[slots.model, 'model'] as const] : []),
    ...(slots.thinking ? [[slots.thinking, 'effort'] as const] : []),
    ...(slots.fast ? [[slots.fast, 'fast'] as const] : []),
    ...(slots.approvalMode ? [[slots.approvalMode, 'approval_mode'] as const] : []),
  ]);
  return {
    ...catalog,
    configOptions: catalog.configOptions.map((option) => {
      const role = roleById.get(option.id);
      return role && option.role === undefined ? { ...option, role } : option;
    }),
  };
}

export type NotificationHandler = (notification: ProxyNotification) => void;

/** Bound for session.create / turn.* / interaction.respond RPCs. These can
 *  wait on Provider runtime bootstrap inside the Proxy, so they get a
 *  generous bound; the Web operation layer already settles 'unknown' after
 *  10s and retries, so leaving them unbounded would pile work onto a wedged
 *  shared Proxy (kimi) with no way for the Host to surface the failure. */
export const PROXY_SESSION_RPC_TIMEOUT_MS = 30_000;

/** Bound for sidechat.* control RPCs. They are lightweight stream operations
 *  on an already-running parent session, so they fail fast; the Side Chat
 *  coordinator quarantines just the affected Side Chat on timeout. */
export const PROXY_SIDECHAT_RPC_TIMEOUT_MS = 15_000;

export interface ProtocolV2HostOptions extends ProtocolV2ClientOptions {
  /** Present for official product launches; omitted for open pluginIds. */
  executor?: Executor;
}

interface ReplayPage {
  replayStreamId: string;
  nextCursor: string | null;
  events: ReplayEvent[];
}

interface ProtocolSession {
  id: string;
  streamId: string;
  state: ProxySession['state'];
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
  nativeSession?: { id: string };
  turnConfigOptions?: import('@gian/shared').ConfigOption[];
  turnConfigRevision?: string;
  availableActions?: import('@gian/shared').SessionAvailableActions;
}

/**
 * Shared or session-scoped process owner. Codex/Kimi use one host for many
 * sessions; Claude/Grok use one host per session. The Host never branches on
 * executor for protocol methods.
 */
export class ProtocolV2Host {
  private readonly client: ProtocolV2Client;
  private readonly sessions = new Map<string, ProtocolV2SessionClient>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private initialized: Promise<InitializeResult> | null = null;
  private catalogResult: Promise<ProxyCatalog> | null = null;
  private exitNotified = false;
  private exitCode: number | null | undefined;

  constructor(private readonly options: ProtocolV2HostOptions) {
    this.client = new ProtocolV2Client(options);
    this.client.onNotification((notification) => this.deliverNotification(notification));
    this.client.onSessionFault((error) => this.deliverSessionFault(error));
    this.client.onExit((code) => this.notifyExit(code));
  }

  get pluginId(): string {
    return this.options.pluginId;
  }

  get executor(): Executor | undefined {
    return this.options.executor;
  }

  isExited(): boolean {
    return this.client.isExited();
  }

  nativeSessionHostBindingProof(params: {
    sessionId: string;
    nativeSessionId: string;
    cwd: string;
  }): string {
    return this.client.nativeSessionHostBindingProof(params);
  }

  initialize(): Promise<InitializeResult> {
    this.initialized ??= this.client.initialize();
    return this.initialized;
  }

  catalog(): Promise<ProxyCatalog> {
    this.catalogResult ??= this.client.catalog().then((value) => (
      normalizeProtocolCatalog(value as ProxyCatalog)
    ));
    return this.catalogResult;
  }

  async request<T>(
    method: Parameters<ProtocolV2Client['request']>[0],
    params: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (method !== 'initialize') await this.initialize();
    return this.client.request(method, params, options);
  }

  hasSessions(): boolean {
    return [...this.sessions.values()].some((session) => session.hasAttachedSession());
  }

  onHostExit(handler: (code: number | null) => void): () => void {
    return this.onExit(handler);
  }

  createSessionClient(sessionId: string): ProtocolV2SessionClient {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new ProtocolV2SessionClient(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  unregister(sessionId: string, session: ProtocolV2SessionClient): void {
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
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
    await this.client.shutdown();
  }

  forceKill(): void {
    this.client.forceKill();
  }

  processGroupId(): number {
    return this.client.processGroupId();
  }

  observeProcessGroupAbsence(): void {
    this.client.observeProcessGroupAbsence();
  }

  listNativeSessions(params?: NativeSessionListParams): Promise<unknown> {
    return this.request('session.native.list', params ?? {});
  }

  deleteNativeSession(nativeSessionId: string): Promise<void> {
    return this.request('session.native.delete', { nativeSessionId });
  }

  private deliverNotification(notification: ProxyNotification): void {
    if (!('sessionId' in notification.params)) {
      if (notification.method === 'catalog.changed') this.catalogResult = null;
      for (const session of this.sessions.values()) {
        session.deliverNotification(notification);
      }
      return;
    }
    this.sessions.get(notification.params.sessionId)?.deliverNotification(notification);
  }

  private deliverSessionFault(error: import('@gian/proxy-protocol').ProxyProtocolError): void {
    const sessionId = error.sessionId;
    if (sessionId) {
      this.sessions.get(sessionId)?.notifySessionFault(error);
      return;
    }
    for (const session of this.sessions.values()) session.notifySessionFault(error);
  }

  private notifyExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exitCode = code;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      try {
        session.notifyHostExit(code);
      } catch (error) {
        console.error(`[${this.pluginId}] session exit handler threw: ${String(error)}`);
      }
    }
    for (const handler of this.exitHandlers) {
      try {
        handler(code);
      } catch (error) {
        console.error(`[${this.pluginId}] host exit handler threw: ${String(error)}`);
      }
    }
  }
}

export class ProtocolV2SessionClient implements ProxyClient {
  readonly protocolV2 = true as const;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly sessionFaultHandlers = new Set<(error: Error) => void>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private stream: string | null = null;
  private nativeSessionId: string | null = null;
  private cwd: string | null = null;
  private catalogCache: ProxyCatalog | null = null;
  private catalogStale = false;
  private activeTurnId: string | null = null;
  private closed = false;
  private exitNotified = false;
  private exitCode: number | null | undefined;
  private lastError: string | null = null;
  private createdAt: string | null = null;
  private updatedAt: string | null = null;
  private state: ProxySession['state'] = 'idle';
  private turnConfigOptions: import('@gian/shared').ConfigOption[] | undefined;
  private turnConfigRevision: string | undefined;

  constructor(
    private readonly host: ProtocolV2Host,
    private readonly hostSessionId: string,
  ) {}

  get pluginId(): string {
    return this.host.pluginId;
  }

  get executor(): Executor | undefined {
    return this.host.executor;
  }

  runtimeHost(): ProtocolV2Host {
    return this.host;
  }

  isExited(): boolean {
    return this.host.isExited();
  }

  hasAttachedSession(): boolean {
    return this.stream !== null;
  }

  processGroupId(): number {
    return this.host.processGroupId();
  }

  observeProcessGroupAbsence(): void {
    this.host.observeProcessGroupAbsence();
  }

  initialize() {
    return this.host.initialize();
  }

  async catalog(): Promise<ProxyCatalog> {
    if (this.catalogCache === null || this.catalogStale) {
      this.catalogCache = await this.host.catalog();
      this.catalogStale = false;
      this.turnConfigOptions = this.normalizeTurnConfigOptions(this.turnConfigOptions);
    }
    return this.catalogCache;
  }

  private normalizeTurnConfigOptions(
    options: import('@gian/shared').ConfigOption[] | undefined,
  ): import('@gian/shared').ConfigOption[] | undefined {
    if (!options || !this.catalogCache) return options;
    const roleById = new Map(
      this.catalogCache.configOptions.flatMap((option) => (
        option.role ? [[option.id, option.role] as const] : []
      )),
    );
    return options.map((option) => {
      const role = roleById.get(option.id);
      return role && option.role === undefined ? { ...option, role } : option;
    });
  }

  async listSlashCommands(): Promise<{ commands: ProxyCatalog['slashCommands'] }> {
    const catalog = await this.catalog();
    return { commands: catalog.slashCommands };
  }

  async createSession(params: CreateSessionParams) {
    const initialized = await this.initialize();
    await this.catalog();
    const history = params.history
      ?? (params.resumeMode === 'load' ? 'replay' as const : undefined);
    const result = await this.host.request<{ session: ProtocolSession }>('session.create', {
      sessionId: this.hostSessionId,
      workspace: {
        cwd: params.cwd,
        roots: params.workspaceRoots ?? [params.cwd],
      },
      config: params.sessionConfig ?? {},
      ...(params.hostServices?.length ? { hostServices: params.hostServices } : {}),
      ...(initialized.capabilities['session.create.forkBoundaries'] !== undefined
        && params.forkBoundaries?.length
        ? { forkBoundaries: params.forkBoundaries }
        : {}),
      ...(params.nativeSessionId ? {
        nativeSession: {
          id: params.nativeSessionId,
          ...(history ? { history } : {}),
          ...(history === 'none'
            && initialized.capabilities['session.create.hostBindingProof'] !== undefined
            ? {
              hostBindingProof: this.host.nativeSessionHostBindingProof({
                sessionId: this.hostSessionId,
                nativeSessionId: params.nativeSessionId,
                cwd: params.cwd,
              }),
            }
            : {}),
        },
      } : {}),
    }, { timeoutMs: PROXY_SESSION_RPC_TIMEOUT_MS });
    this.stream = result.session.streamId;
    this.nativeSessionId = result.session.nativeSession?.id ?? params.nativeSessionId ?? null;
    this.cwd = params.cwd;
    this.state = result.session.state;
    this.createdAt = result.session.createdAt;
    this.updatedAt = result.session.updatedAt;
    this.lastError = result.session.lastError ?? null;
    this.turnConfigOptions = this.normalizeTurnConfigOptions(result.session.turnConfigOptions);
    this.turnConfigRevision = result.session.turnConfigRevision;
    const replay = history === 'replay'
      ? await this.loadReplay()
      : null;
    return {
      session: this.currentSession(),
      nativeSessionId: this.nativeSessionId,
      replayEvents: replay?.events ?? [],
      ...(replay ? { replayStreamId: replay.replayStreamId } : {}),
      ...(this.turnConfigOptions !== undefined
        ? { turnConfigOptions: this.turnConfigOptions, turnConfigRevision: this.turnConfigRevision }
        : {}),
      ...(result.session.availableActions
        ? { availableActions: result.session.availableActions }
        : {}),
    };
  }

  streamId(): string | null {
    return this.stream;
  }

  async resolveCatalog(params: {
    catalogRevision: string;
    sessionConfig: Record<string, string | boolean | number | null>;
    turnConfig: Record<string, string | boolean | number | null>;
  }): Promise<import('@gian/shared').ResolvedProxyCatalog> {
    return normalizeProtocolCatalog(await this.host.request<import('@gian/shared').ResolvedProxyCatalog>('catalog.resolve', {
      catalogRevision: params.catalogRevision,
      sessionConfig: params.sessionConfig,
      turnConfig: params.turnConfig,
      ...(this.stream ? { sessionId: this.hostSessionId, streamId: this.stream } : {}),
    }));
  }

  async startTurn(params: StartTurnParams) {
    const turnId = params.turnId;
    if (!turnId) throw new Error('gian.proxy/2 turn.start requires a Host turnId.');
    this.activeTurnId = turnId;
    this.state = 'running';
    const accepted = this.currentSession();
    try {
      await this.host.request('turn.start', {
        sessionId: this.hostSessionId,
        streamId: this.requireStream(),
        turnId,
        input: params.input,
        config: params.config,
      }, { timeoutMs: PROXY_SESSION_RPC_TIMEOUT_MS });
    } catch (error) {
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      throw error;
    }
    return {
      session: accepted,
      turn: { id: turnId },
    };
  }

  async interruptTurn(): Promise<void> {
    await this.host.request('turn.interrupt', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId: this.requireTurn(),
    }, { timeoutMs: PROXY_SESSION_RPC_TIMEOUT_MS });
  }

  async steerTurn(params: SteerTurnParams): Promise<{ ok: true; turnId: string }> {
    const turnId = params.turnId ?? this.requireTurn();
    return this.host.request('turn.steer', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId,
      input: params.input,
    }, { timeoutMs: PROXY_SESSION_RPC_TIMEOUT_MS });
  }

  async respondInteraction(params: RespondInteractionParams): Promise<void> {
    await this.host.request('interaction.respond', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      turnId: params.turnId ?? this.requireTurn(),
      interactionId: params.interactionId,
      responseId: params.responseId,
      actionId: params.actionId,
      values: params.values,
    }, { timeoutMs: PROXY_SESSION_RPC_TIMEOUT_MS });
  }

  async setName(name: string): Promise<void> {
    await this.host.request('session.rename', {
      sessionId: this.hostSessionId,
      streamId: this.requireStream(),
      name,
    });
  }

  listNativeSessions(params?: NativeSessionListParams): Promise<unknown> {
    return this.host.listNativeSessions(params);
  }

  deleteNativeSession(id: string): Promise<void> {
    return this.host.deleteNativeSession(id);
  }

  async closeSession(): Promise<void> {
    if (!this.stream) return;
    const streamId = this.stream;
    try {
      await this.host.request('session.close', {
        sessionId: this.hostSessionId,
        streamId,
      });
    } catch (error) {
      if (!this.host.isExited()) throw error;
    }
    this.stream = null;
    this.activeTurnId = null;
    this.state = 'closed';
  }

  replaySession() {
    return this.loadReplay();
  }

  attachFromSnapshot(streamId: string, cwd?: string, nativeSessionId?: string | null): void {
    this.stream = streamId;
    this.cwd = cwd ?? this.cwd;
    this.state = 'idle';
    if (nativeSessionId) this.nativeSessionId = nativeSessionId;
    const now = new Date().toISOString();
    this.createdAt ??= now;
    this.updatedAt = now;
  }

  async createSidechat(params: { sidechatId: string }): Promise<SideChatSnapshot> {
    const result = await this.host.request<{ sidechat: SideChatSnapshot }>('sidechat.create', {
      parentSessionId: this.hostSessionId,
      parentStreamId: this.requireStream(),
      sidechatId: params.sidechatId,
    }, { timeoutMs: PROXY_SIDECHAT_RPC_TIMEOUT_MS });
    const child = this.host.createSessionClient(params.sidechatId);
    child.attachFromSnapshot(result.sidechat.streamId, this.cwd ?? undefined);
    return result.sidechat;
  }

  async resumeSidechat(params: {
    sidechatId: string;
    resumeRef: { id: string };
  }): Promise<SideChatSnapshot> {
    const result = await this.host.request<{ sidechat: SideChatSnapshot }>('sidechat.resume', {
      sidechatId: params.sidechatId,
      parentSessionId: this.hostSessionId,
      resumeRef: params.resumeRef,
    }, { timeoutMs: PROXY_SIDECHAT_RPC_TIMEOUT_MS });
    const child = this.host.createSessionClient(params.sidechatId);
    child.attachFromSnapshot(result.sidechat.streamId, this.cwd ?? undefined);
    return result.sidechat;
  }

  closeSidechat(params: {
    sidechatId: string;
    streamId?: string;
    resumeRef: { id: string };
  }): Promise<{ ok: true; sidechatId: string; providerDataDeleted: boolean }> {
    return this.host.request('sidechat.close', params, { timeoutMs: PROXY_SIDECHAT_RPC_TIMEOUT_MS });
  }

  async forkSession(params: {
    sessionId: string;
    anchor: ForkAnchor;
    hostServices?: import('@gian/proxy-protocol').HostServiceDescriptor[];
  }): Promise<{
    session: ProtocolSession;
    origin: ForkOrigin;
    replayEvents: ReplayEvent[];
    replayStreamId?: string;
  }> {
    const result = await this.host.request<{ session: ProtocolSession; origin: ForkOrigin }>('session.fork', {
      sourceSessionId: this.hostSessionId,
      sourceStreamId: this.requireStream(),
      sessionId: params.sessionId,
      anchor: params.anchor,
      ...(params.hostServices?.length ? { hostServices: params.hostServices } : {}),
    });
    const child = this.host.createSessionClient(params.sessionId);
    const nativeSessionId = result.session.nativeSession?.id ?? null;
    try {
      child.attachFromSnapshot(result.session.streamId, this.cwd ?? undefined, nativeSessionId);
      if (!nativeSessionId) {
        throw requestViolation('INTERNAL', 'session.fork Result omitted durable nativeSession');
      }
      const replay = await child.loadReplay();
      return {
        session: result.session,
        origin: result.origin,
        replayEvents: replay.events,
        replayStreamId: replay.replayStreamId,
      };
    } catch (error) {
      const leftovers = await this.cleanupUnpublishedChild(child, nativeSessionId);
      this.host.unregister(params.sessionId, child);
      if (leftovers.length > 0) {
        const original = error instanceof Error ? error.message : String(error);
        throw requestViolation(
          'RUNTIME_ERROR',
          `session.fork left Provider resources: ${leftovers.join('; ')}. ${original}`,
        );
      }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeSession();
    } finally {
      this.host.unregister(this.hostSessionId, this);
    }
  }

  forceKill(): void {
    if (this.closed) return;
    this.closed = true;
    void this.closeSession().catch(() => undefined);
    this.host.unregister(this.hostSessionId, this);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onSessionFault(handler: (error: Error) => void): () => void {
    this.sessionFaultHandlers.add(handler);
    return () => this.sessionFaultHandlers.delete(handler);
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
      && 'turnId' in notification.params
      && notification.params.turnId === this.activeTurnId
    ) {
      this.activeTurnId = null;
      this.state = notification.method === 'turn.failed' ? 'error' : 'idle';
    } else if (notification.method === 'session.updated' && 'data' in notification.params) {
      const data = notification.params.data as {
        nativeSession?: { id: string };
        state?: ProxySession['state'];
        lastError?: string | null;
        turnConfigOptions?: import('@gian/shared').ConfigOption[];
        turnConfigRevision?: string;
      };
      if (data.nativeSession) this.nativeSessionId = data.nativeSession.id;
      if (data.state) this.state = data.state;
      if (data.lastError !== undefined) this.lastError = data.lastError;
      if (data.turnConfigOptions !== undefined) {
        this.turnConfigOptions = this.normalizeTurnConfigOptions(data.turnConfigOptions);
        this.turnConfigRevision = data.turnConfigRevision;
      }
      this.updatedAt = new Date().toISOString();
    } else if (notification.method === 'interaction.requested') {
      this.state = 'waiting_interaction';
    } else if (notification.method === 'interaction.resolved') {
      if (this.state === 'waiting_interaction') this.state = this.activeTurnId ? 'running' : 'idle';
    } else if (notification.method === 'catalog.changed') {
      // Keep the last normalized catalog available while the Host refetches.
      // A Provider may immediately follow catalog.changed with a role-free
      // 2.1 session.updated snapshot; dropping the old catalog here loses the
      // Special Catalog projection and hides the Composer controls.
      this.catalogStale = true;
    }
    for (const handler of this.notificationHandlers) handler(notification);
  }

  notifySessionFault(error: Error): void {
    this.lastError = error.message;
    this.state = 'error';
    for (const handler of this.sessionFaultHandlers) handler(error);
  }

  notifyHostExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exitCode = code;
    for (const handler of this.exitHandlers) {
      try {
        handler(code);
      } catch (error) {
        console.error(`[${this.pluginId}] exit handler threw: ${String(error)}`);
      }
    }
  }

  async loadReplay(): Promise<{ replayStreamId: string; events: ReplayEvent[] }> {
    const events: ReplayEvent[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page: ReplayPage = await this.host.request('session.replay', {
        sessionId: this.hostSessionId,
        streamId: this.requireStream(),
        cursor,
        limit: 500,
      });
      events.push(...page.events);
      if (page.nextCursor === null) {
        return { replayStreamId: page.replayStreamId, events };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`Replay cursor ${page.nextCursor} was repeated.`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('Replay exceeded 100 pages.');
  }

  private requireStream(): string {
    if (!this.stream) throw new Error('gian.proxy/2 session is not attached.');
    return this.stream;
  }

  private requireTurn(): string {
    if (!this.activeTurnId) throw new Error('gian.proxy/2 session has no active turn.');
    return this.activeTurnId;
  }

  private async cleanupUnpublishedChild(
    child: ProtocolV2SessionClient,
    nativeSessionId: string | null,
  ): Promise<string[]> {
    const leftovers: string[] = [];
    try {
      await child.closeSession();
    } catch (error) {
      leftovers.push(`session.close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (nativeSessionId) {
      try {
        await this.host.deleteNativeSession(nativeSessionId);
      } catch (error) {
        leftovers.push(`session.native.delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return leftovers;
  }

  private currentSession(): ProxySession {
    const now = new Date().toISOString();
    return {
      id: this.hostSessionId,
      cwd: this.cwd ?? '',
      state: this.state,
      createdAt: this.createdAt ?? now,
      updatedAt: this.updatedAt ?? now,
      lastError: this.lastError,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
    };
  }
}
