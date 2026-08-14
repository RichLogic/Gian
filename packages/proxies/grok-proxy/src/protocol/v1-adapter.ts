import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AttachmentTurnLedger,
  PROTOCOL_NAME,
  PROTOCOL_V1,
  ProxyProtocolError,
  ReplaySnapshotPager,
  proxyNotificationSchema,
  type InitializeResult,
  type JsonValue,
  type ProxyNotification,
  type ProxyRequest,
} from '@gian/proxy-protocol';
import { GrokProxyError } from '../core/errors.js';
import { normalizeInputItems } from '../core/input.js';
import {
  extensionName,
  isExcludedExtension,
  translateExtension,
  translateSessionUpdate,
} from '../core/events.js';
import { grokPermissionSpec, parseGrokPermissionMode } from '../core/permissions.js';
import { filterAdvertisedCommands } from '../core/slash-policy.js';
import { GrokProxyService } from '../core/service.js';

type V1EventSink = (notification: ProxyNotification) => void;

interface AttachedSession {
  id: string;
  serviceSessionId: string;
  nativeSessionId: string;
  streamId: string;
  cwd: string;
  workspaceRoots: string[];
  status: 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
  model: string | null;
  mode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sequence: number;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'slash.list': 1,
  'session.rename': 1,
  'session.nativeList': 1,
  'session.nativeDelete': 1,
  'session.replay': 1,
  'session.config': 1,
  'turn.steer': 1,
  'approval.relay': 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.command': 1,
  'event.status': 1,
  'event.tool': 1,
  'event.diff': 1,
  'event.usage': 1,
  'event.agent': 1,
  'event.notice': 1,
  'extension.events': 1,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function standardError(error: unknown): ProxyProtocolError {
  if (error instanceof ProxyProtocolError) return error;
  if (error instanceof GrokProxyError) {
    const code = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'APPROVAL_NOT_FOUND': return 'APPROVAL_NOT_FOUND';
        case 'INVALID_APPROVAL_OPTION': return 'APPROVAL_OPTION_NOT_FOUND';
        case 'NATIVE_SESSION_ATTACHED': return 'CONFLICT';
        case 'AUTH_REQUIRED': return 'RUNTIME_AUTH_REQUIRED';
        case 'CAPABILITY_NOT_SUPPORTED': return 'CAPABILITY_NOT_SUPPORTED';
        case 'TURN_NOT_FOUND': return 'TURN_NOT_FOUND';
        case 'CONFLICT': return 'CONFLICT';
        case 'INVALID_REQUEST': return 'INVALID_REQUEST';
        default: return 'RUNTIME_ERROR';
      }
    })();
    return new ProxyProtocolError(code, error.message, false);
  }
  return new ProxyProtocolError(
    /auth|login/i.test(error instanceof Error ? error.message : String(error))
      ? 'RUNTIME_AUTH_REQUIRED'
      : 'INTERNAL',
    error instanceof Error ? error.message : String(error),
    false,
  );
}

export class GrokProtocolV1Adapter {
  private session: AttachedSession | null = null;
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly replayEvents: ProxyNotification[] = [];
  private readonly replayPager = new ReplaySnapshotPager<ProxyNotification>();
  private readonly ledger = new AttachmentTurnLedger();
  private initialized = false;
  private contentOpen = new Map<string, string>();

  constructor(
    private readonly service: GrokProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V1EventSink,
  ) {
    service.setEventSink((method, params) => this.translateServiceEvent(method, params));
  }

  async handle(request: ProxyRequest): Promise<unknown> {
    if (!this.initialized && request.method !== 'initialize') {
      throw new ProxyProtocolError('NOT_INITIALIZED', 'initialize must be the first request.', false);
    }
    if (request.method === 'initialize') return this.initialize(request.params);
    switch (request.method) {
      case 'catalog.list': return this.catalog();
      case 'session.create': return this.createSession(request.params);
      case 'session.get': return { session: this.serialize(this.requireSession(request.params.sessionId)) };
      case 'turn.start': return this.startTurn(request.params);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'turn.steer': return this.steer(request.params);
      case 'approval.respond': return this.respondApproval(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'slash.list': return this.listSlash(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.native.delete': return this.deleteNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'session.config.set': return this.setConfig(request.params);
      case 'session.rename': return this.rename(request.params);
      case 'shutdown': return { ok: true };
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  private initialize(params: Extract<ProxyRequest, { method: 'initialize' }>['params']): InitializeResult {
    if (this.initialized) {
      throw new ProxyProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.', false);
    }
    if (params.protocol.name !== PROTOCOL_NAME || !params.protocol.versions.includes(PROTOCOL_V1)) {
      throw new ProxyProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/1.0 is required.', false);
    }
    this.initialized = true;
    return {
      protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V1 },
      plugin: { id: 'grok', name: 'Grok Build', version: this.pluginVersion },
      process: { scope: 'session' },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    if (this.session) return this.service.currentCatalog();
    const capabilities = await this.service.listCapabilities();
    return {
      models: capabilities.models,
      modes: capabilities.modes,
      sessionOptions: capabilities.sessionOptions,
    };
  }

  private async createSession(
    params: Extract<ProxyRequest, { method: 'session.create' }>['params'],
  ) {
    if (this.session) {
      throw new ProxyProtocolError('CONFLICT', 'This Grok Proxy already has an attached session.', false);
    }
    const cwd = resolve(params.cwd);
    const workspaceRoots = [...new Set(params.workspaceRoots.map(root => resolve(root)))];
    if (workspaceRoots.length !== 1 || workspaceRoots[0] !== cwd) {
      throw new ProxyProtocolError(
        'POLICY_NOT_SUPPORTED',
        'Grok workspace sandbox supports exactly the session cwd as its writable root.',
        false,
      );
    }
    const permission = parseGrokPermissionMode(params.mode);
    if (permission) this.service.setPermissionMode(permission);
    const result = await this.service.createSession({
      cwd,
      ...(params.nativeSession ? { nativeSessionId: params.nativeSession.id } : {}),
      ...(params.nativeSession?.mode ? { resumeMode: params.nativeSession.mode } : {}),
      mcpServers: [],
    });
    if (params.model) {
      await this.service.setConfigOption({
        sessionId: result.session.id,
        configId: 'model',
        value: params.model,
      }).catch(() => undefined);
    }
    if (params.effort) {
      await this.service.setConfigOption({
        sessionId: result.session.id,
        configId: 'reasoning_effort',
        value: params.effort,
      }).catch(() => undefined);
    }
    this.session = {
      id: params.sessionId,
      serviceSessionId: result.session.id,
      nativeSessionId: result.session.nativeSessionId,
      streamId: randomUUID(),
      cwd,
      workspaceRoots,
      status: 'idle',
      model: result.session.model ?? params.model ?? null,
      mode: result.session.mode ?? params.mode ?? 'default',
      lastError: result.session.lastError,
      createdAt: result.session.createdAt,
      updatedAt: result.session.updatedAt,
      sequence: 0,
    };
    this.ledger.attach(this.session.id, this.session.streamId);
    return { session: this.serialize(this.session) };
  }

  private async startTurn(
    params: Extract<ProxyRequest, { method: 'turn.start' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    if (this.activeTurnBySession.has(session.id)) {
      throw new ProxyProtocolError('SESSION_BUSY', 'This session already has an active turn.', false);
    }
    this.assertTurnPolicy(session, params.policy, params.config.mode ?? session.mode);
    this.activeTurnBySession.set(session.id, params.turnId);
    this.turnsByRequest.set(params.turnId, { sessionId: session.id, turnId: params.turnId });
    try {
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: normalizeInputItems(params.input, session.cwd),
      });
    } catch (error) {
      this.activeTurnBySession.delete(session.id);
      throw standardError(error);
    }
    return { accepted: true, turnId: params.turnId };
  }

  private async steer(params: Extract<ProxyRequest, { method: 'turn.steer' }>['params']) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    if (this.activeTurnBySession.get(session.id) !== params.turnId) {
      throw new ProxyProtocolError('TURN_NOT_FOUND', 'No active Grok turn to steer.', false);
    }
    await this.service.steerTurn({
      sessionId: session.serviceSessionId,
      input: normalizeInputItems(params.input, session.cwd),
    });
    return { accepted: true, turnId: params.turnId };
  }

  private async interruptTurn(params: Extract<ProxyRequest, { method: 'turn.interrupt' }>['params']) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    return { accepted: true, turnId: params.turnId };
  }

  private async respondApproval(params: Extract<ProxyRequest, { method: 'approval.respond' }>['params']) {
    this.requireAttached(params.sessionId, params.streamId);
    await this.service.respondApproval({
      sessionId: this.session!.serviceSessionId,
      approvalId: params.approvalId,
      nativeOptionId: params.optionId,
    });
    return { accepted: true, approvalId: params.approvalId };
  }

  private async closeSession(params: Extract<ProxyRequest, { method: 'session.close' }>['params']) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    this.session = null;
    this.activeTurnBySession.clear();
    return { ok: true };
  }

  private async listSlash(params: Extract<ProxyRequest, { method: 'slash.list' }>['params']) {
    this.requireAttached(params.sessionId, params.streamId);
    const result = await this.service.listSlashCommands();
    return {
      commands: filterAdvertisedCommands(result.commands).map(command => ({
        name: command.name.startsWith('/') ? command.name : `/${command.name}`,
        description: command.description ?? '',
        source: 'builtin' as const,
        argHints: command.input && typeof command.input === 'object' && 'hint' in command.input && command.input.hint
          ? [{ kind: 'free' as const, placeholder: String(command.input.hint) }]
          : [],
      })),
    };
  }

  private async listNative(params: Extract<ProxyRequest, { method: 'session.native.list' }>['params']) {
    const result = await this.service.listNativeSessions({
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    }) as {
      sessions?: Array<{ sessionId?: string; title?: string; cwd?: string; updatedAt?: string }>;
      nextCursor?: string | null;
    };
    return {
      sessions: (result.sessions ?? []).flatMap(item => item.sessionId ? [{
        id: item.sessionId,
        ...(item.title !== undefined ? { displayName: item.title } : {}),
        ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
        ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
      }] : []),
      nextCursor: result.nextCursor ?? null,
    };
  }

  private async deleteNative(
    params: Extract<ProxyRequest, { method: 'session.native.delete' }>['params'],
  ) {
    await this.service.deleteNativeSession(params.nativeSessionId);
    return { ok: true };
  }

  private replay(params: Extract<ProxyRequest, { method: 'session.replay' }>['params']) {
    this.requireAttached(params.sessionId, params.streamId);
    return this.replayPager.page(
      params.sessionId,
      { streamId: stableId('replay', params.sessionId), events: this.replayEvents },
      params.cursor,
      params.limit,
    );
  }

  private async setConfig(params: Extract<ProxyRequest, { method: 'session.config.set' }>['params']) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    if (typeof params.value !== 'string' && typeof params.value !== 'boolean') {
      throw new ProxyProtocolError('INVALID_REQUEST', 'Grok config values must be string or boolean.', false);
    }
    const result = await this.service.setConfigOption({
      sessionId: session.serviceSessionId,
      configId: params.optionId,
      value: params.value,
    });
    session.model = result.session.model ?? session.model;
    session.mode = result.session.mode ?? session.mode;
    const catalog = this.service.currentCatalog();
    return {
      session: this.serialize(session),
      configOptions: catalog.sessionOptions,
    };
  }

  private async rename(params: Extract<ProxyRequest, { method: 'session.rename' }>['params']) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    await this.service.renameSession({ sessionId: session.serviceSessionId, name: params.name });
    return { ok: true };
  }

  private assertTurnPolicy(
    session: AttachedSession,
    policy: Extract<ProxyRequest, { method: 'turn.start' }>['params']['policy'],
    modeId: string | null,
  ) {
    const mode = parseGrokPermissionMode(modeId) ?? 'default';
    const spec = grokPermissionSpec(mode);
    const roots = policy.workspaceRoots.map(root => resolve(root));
    if (
      roots.length !== 1
      || roots[0] !== session.cwd
      || policy.network !== 'allow'
      || policy.approval !== spec.approval
    ) {
      throw new ProxyProtocolError(
        'POLICY_NOT_SUPPORTED',
        `Grok mode "${mode}" requires approval=${spec.approval} network=allow workspace=${session.cwd}.`,
        false,
      );
    }
  }

  private translateServiceEvent(method: string, params: Record<string, unknown>) {
    const session = this.session;
    if (!session) return;
    const turnId = typeof params.turnId === 'string' ? params.turnId : this.activeTurnBySession.get(session.id);
    const data = record(params.data);
    if (method === 'turn.started') {
      this.emit('turn.started', session, turnId, {});
      return;
    }
    if (method === 'turn.completed') {
      if (!this.activeTurnBySession.has(session.id)) return;
      this.activeTurnBySession.delete(session.id);
      this.flushOpenContent(session, turnId);
      this.emit('turn.completed', session, turnId, {
        stopReason: data.stopReason === 'cancelled' || data.stopReason === 'interrupted'
          ? data.stopReason
          : 'completed',
      });
      return;
    }
    if (method === 'turn.failed') {
      if (!this.activeTurnBySession.has(session.id)) return;
      this.activeTurnBySession.delete(session.id);
      this.emit('turn.failed', session, turnId, {
        error: {
          code: data.code ?? 'RUNTIME_ERROR',
          message: data.message ?? 'Grok turn failed.',
          retryable: false,
          data: {},
        },
      });
      return;
    }
    if (method === 'usage.updated') {
      this.emit('usage.updated', session, turnId, data);
      return;
    }
    if (method === 'approval.requested') {
      this.emit('approval.requested', session, turnId, {
        approvalId: data.approvalId,
        category: 'other',
        title: data.title ?? 'Permission',
        description: '',
        options: Array.isArray(data.options)
          ? data.options.map((option: { optionId?: string; name?: string; kind?: string }) => ({
            id: option.optionId ?? 'unknown',
            label: option.name ?? option.optionId ?? 'option',
            kind: option.kind ?? 'allow_once',
          }))
          : [],
        payload: jsonValue(data.payload),
      });
      return;
    }
    if (method === 'approval.resolved') {
      this.emit('approval.resolved', session, turnId, {
        approvalId: data.approvalId,
        resolution: data.optionId ? 'selected' : 'runtime_cancelled',
        resolvedBy: data.optionId ? 'user' : 'runtime',
        ...(data.optionId ? { optionId: data.optionId } : {}),
      });
      return;
    }
    if (method === 'session.updated') {
      if (typeof data.model === 'string') session.model = data.model;
      if (typeof data.mode === 'string') session.mode = data.mode;
      this.emit('session.updated', session, turnId, data);
      return;
    }
    if (method === 'extension.notification') {
      const name = extensionName(String(params.method ?? data.method ?? 'unknown'));
      if (isExcludedExtension(name)) return;
      for (const event of translateExtension(name, params.params ?? data.params ?? {})) {
        this.emitTranslated(session, turnId, event);
      }
      return;
    }
    if (method === 'session.update') {
      for (const event of translateSessionUpdate(data.update)) {
        this.emitTranslated(session, turnId, event);
      }
    }
  }

  private emitTranslated(
    session: AttachedSession,
    turnId: string | undefined,
    event: { method: string; data: Record<string, unknown>; terminal?: 'completed' | 'failed' },
  ) {
    if (event.terminal && !turnId) return;
    if (event.method === 'content.delta') {
      const kind = String(event.data.kind ?? 'text');
      const contentId = this.contentOpen.get(`${kind}:${turnId}`)
        ?? stableId(kind, [turnId, String(event.data.delta ?? '').slice(0, 24)]);
      this.contentOpen.set(`${kind}:${turnId}`, contentId);
      this.emit('content.delta', session, turnId, { ...event.data, contentId });
      return;
    }
    if (event.method === 'diff.updated') {
      this.emit('diff.updated', session, turnId, {
        ...event.data,
        diffId: stableId('diff', [turnId, event.data.path ?? event.data.diff]),
      });
      return;
    }
    if (event.method === 'session.updated') {
      if (typeof event.data.model === 'string') session.model = event.data.model;
      if (typeof event.data.mode === 'string') session.mode = event.data.mode;
    }
    if (event.terminal === 'completed') {
      if (!this.activeTurnBySession.has(session.id)) return;
      this.activeTurnBySession.delete(session.id);
      this.flushOpenContent(session, turnId);
    }
    if (event.terminal === 'failed') {
      if (!this.activeTurnBySession.has(session.id)) return;
      this.activeTurnBySession.delete(session.id);
    }
    this.emit(event.method as ProxyNotification['method'], session, turnId, event.data);
  }

  private flushOpenContent(session: AttachedSession, turnId: string | undefined) {
    for (const [key, contentId] of this.contentOpen) {
      if (turnId && !key.endsWith(`:${turnId}`)) continue;
      const kind = key.startsWith('reasoning') ? 'reasoning' : 'text';
      this.emit('content.completed', session, turnId, { contentId, kind });
      this.contentOpen.delete(key);
    }
  }

  private emit(
    method: ProxyNotification['method'],
    session: AttachedSession,
    turnId: string | undefined,
    data: Record<string, unknown>,
  ) {
    session.sequence += 1;
    const notification = proxyNotificationSchema.parse({
      method,
      params: {
        eventId: stableId('evt', [session.id, session.sequence, method, turnId, data]),
        streamId: session.streamId,
        sequence: session.sequence,
        sessionId: session.id,
        ...(turnId ? { turnId } : {}),
        emittedAt: new Date().toISOString(),
        data,
      },
    });
    this.replayEvents.push(notification);
    this.emitEvent(notification);
  }

  private serialize(session: AttachedSession) {
    return {
      id: session.id,
      nativeSession: { id: session.nativeSessionId },
      streamId: session.streamId,
      status: session.status,
      model: session.model,
      mode: session.mode,
      lastError: session.lastError,
      configOptions: this.service.currentCatalog().sessionOptions,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    if (!this.session || this.session.id !== sessionId) {
      throw new ProxyProtocolError('SESSION_NOT_FOUND', 'Session not found.', false);
    }
    return this.session;
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new ProxyProtocolError('SESSION_STALE', 'Session stream is stale.', false);
    }
    return session;
  }
}

export function grokProtocolError(error: unknown) {
  const standard = standardError(error);
  return {
    code: standard.code === 'PROTOCOL_VIOLATION' ? 'INVALID_REQUEST' : standard.code,
    message: standard.message,
    retryable: false,
    data: {},
  };
}
