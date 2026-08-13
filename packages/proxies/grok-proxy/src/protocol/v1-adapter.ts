import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
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
  configOptions: SessionConfigOption[];
  sequence: number;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

interface ApprovalRef extends HostTurnRef {
  serviceApprovalId: string;
  selectedOptionId?: string;
}

interface ReplayState {
  streamId: string;
  events: ProxyNotification[];
}

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'slash.list': 1,
  'session.config': 1,
  'approval.relay': 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.tool': 1,
  'event.usage': 1,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
        case 'SESSION_CLOSED': return 'SESSION_CLOSED';
        case 'SESSION_STALE': return 'SESSION_STALE';
        case 'SESSION_ERROR': return 'SESSION_ERROR';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'APPROVAL_NOT_FOUND': return 'APPROVAL_NOT_FOUND';
        case 'INVALID_APPROVAL_OPTION': return 'APPROVAL_OPTION_NOT_FOUND';
        case 'NATIVE_SESSION_ATTACHED': return 'CONFLICT';
        case 'AUTH_REQUIRED': return 'RUNTIME_AUTH_REQUIRED';
        case 'INVALID_REQUEST': return 'INVALID_REQUEST';
        default: return 'RUNTIME_ERROR';
      }
    })();
    return new ProxyProtocolError(code, error.message, false);
  }
  return new ProxyProtocolError(
    'INTERNAL',
    error instanceof Error ? error.message : String(error),
    false,
  );
}

function configRole(option: SessionConfigOption): 'model' | 'effort' | 'mode' | null {
  const raw = option as SessionConfigOption & { category?: string };
  const category = raw.category?.toLowerCase() ?? '';
  const id = option.id.toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    ['thought_level', 'thought', 'thinking', 'effort'].includes(category)
    || ['thought_level', 'thought', 'thinking', 'effort', 'reasoning_effort'].includes(id)
  ) return 'effort';
  if (category === 'mode' || id === 'mode') return 'mode';
  return null;
}

function flatChoices(option: SessionConfigOption) {
  if (option.type !== 'select') return [];
  return option.options.flatMap(entry => (
    'options' in entry
      ? entry.options.map(choice => ({ ...choice, group: entry.name }))
      : [entry]
  ));
}

function standardConfigOption(option: SessionConfigOption) {
  const choices = flatChoices(option).map(choice => ({
    value: typeof choice.value === 'string' || typeof choice.value === 'boolean'
      ? choice.value
      : String(choice.value),
    displayName: choice.name || String(choice.value),
    ...(typeof choice.description === 'string' ? { description: choice.description } : {}),
    ...('group' in choice && typeof choice.group === 'string' ? { group: choice.group } : {}),
  }));
  return {
    id: option.id,
    displayName: option.name,
    ...(typeof option.description === 'string' ? { description: option.description } : {}),
    type: option.type === 'boolean' ? 'boolean' as const : 'select' as const,
    scope: 'session' as const,
    currentValue: option.type === 'boolean'
      ? option.currentValue === true
      : typeof option.currentValue === 'string' ? option.currentValue : null,
    ...(option.type === 'select' ? { choices } : {}),
  };
}

function modePolicy(id: string) {
  const normalized = id.toLowerCase();
  if (normalized.includes('plan')) {
    return { approval: 'relay' as const, workspace: 'read-only' as const, network: 'ask' as const };
  }
  if (normalized.includes('yolo') || normalized.includes('bypass')) {
    return { approval: 'never' as const, workspace: 'full-access' as const, network: 'allow' as const };
  }
  if (normalized.includes('auto')) {
    return { approval: 'auto' as const, workspace: 'workspace-write' as const, network: 'allow' as const };
  }
  return { approval: 'relay' as const, workspace: 'workspace-write' as const, network: 'ask' as const };
}

const APPROVAL_RANK = { relay: 2, auto: 1, never: 0 } as const;
const NETWORK_RANK = { deny: 2, ask: 1, allow: 0 } as const;
const WORKSPACE_RANK = { 'read-only': 2, 'workspace-write': 1, 'full-access': 0 } as const;

function nativeModeValue(native: Record<string, unknown>): string | null {
  const value = native.mode;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function assertHostPolicyHonored(
  policy: Extract<ProxyRequest, { method: 'turn.start' }>['params']['policy'],
  modeId: string | null,
  session: Pick<AttachedSession, 'cwd' | 'workspaceRoots'>,
): void {
  const mode = modePolicy(modeId ?? 'default');
  const requestedRoots = policy.workspaceRoots.map(root => resolve(root));
  const attachedRoots = session.workspaceRoots.map(root => resolve(root));
  if (
    APPROVAL_RANK[mode.approval] < APPROVAL_RANK[policy.approval]
    || NETWORK_RANK[mode.network] < NETWORK_RANK[policy.network]
    || WORKSPACE_RANK[mode.workspace] < WORKSPACE_RANK['workspace-write']
    || requestedRoots.length !== attachedRoots.length
    || requestedRoots.some((root, index) => root !== attachedRoots[index])
  ) {
    throw new ProxyProtocolError(
      'POLICY_NOT_SUPPORTED',
      `Grok mode "${modeId ?? 'default'}" cannot honor Host policy approval=${policy.approval} network=${policy.network} workspaceRoots=${JSON.stringify(policy.workspaceRoots)}.`,
      false,
    );
  }
}

function normalizeWorkspaceRoots(cwd: string, workspaceRoots: string[]): string[] {
  const normalizedCwd = resolve(cwd);
  const normalizedRoots = [...new Set(workspaceRoots.map(root => resolve(root)))];
  if (normalizedRoots.length !== 1 || normalizedRoots[0] !== normalizedCwd) {
    throw new ProxyProtocolError(
      'POLICY_NOT_SUPPORTED',
      'Grok workspace sandbox supports exactly the session cwd as its writable root.',
      false,
    );
  }
  return normalizedRoots;
}

function turnFailureCode(data: Record<string, unknown>): 'RUNTIME_AUTH_REQUIRED' | 'RUNTIME_ERROR' {
  const code = data.code;
  if (
    code === 'AUTH_REQUIRED'
    || code === 'RUNTIME_AUTH_REQUIRED'
    || code === -32000
    || code === '-32000'
  ) {
    return 'RUNTIME_AUTH_REQUIRED';
  }
  return 'RUNTIME_ERROR';
}

function grokInput(
  items: Extract<ProxyRequest, { method: 'turn.start' }>['params']['input'],
) {
  return items.map((item) => {
    switch (item.type) {
      case 'text': return { type: 'text' as const, text: item.text };
      case 'localImage': return {
        type: 'localImage' as const,
        path: item.path,
        ...(item.mime !== undefined ? { mimeType: item.mime } : {}),
      };
      case 'localFile': return {
        type: 'localFile' as const,
        path: item.path,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.mime !== undefined ? { mimeType: item.mime } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
      };
      case 'skill':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'Grok Proxy does not advertise input.skill.',
          false,
        );
    }
  });
}

function contentText(update: Record<string, unknown>): string {
  const content = record(update.content);
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function toolStatus(value: unknown): 'running' | 'succeeded' | 'failed' {
  if (value === 'failed') return 'failed';
  if (value === 'completed') return 'succeeded';
  return 'running';
}

function approvalKind(value: unknown) {
  switch (value) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always': return value;
    default: return null;
  }
}

export class GrokProtocolV1Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private readonly interruptedTurns = new Set<string>();
  private readonly approvals = new Map<string, ApprovalRef>();
  private readonly openToolsByTurn = new Map<string, Set<string>>();
  private readonly replayBySession = new Map<string, ReplayState>();
  private readonly replayPager = new ReplaySnapshotPager<ProxyNotification>();
  private readonly ledger = new AttachmentTurnLedger();
  private initialized = false;

  constructor(
    private readonly service: GrokProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V1EventSink,
  ) {
    service.setEventSink((method, params) => this.translateEvent(method, params));
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
      case 'turn.start': return this.startTurn(request.params, request.id);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'approval.respond': return this.respondApproval(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'slash.list': return this.listSlash(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'session.config.set': return this.setConfig(request.params);
      case 'session.rename':
      case 'turn.steer':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          `${request.method} is not advertised by Grok Proxy.`,
          false,
        );
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
      process: { scope: 'shared' },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    const sessionOptions = capabilities.sessionOptions as SessionConfigOption[];
    return {
      models: capabilities.models.map(model => ({
        id: model.model,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        isDefault: model.isDefault,
        efforts: model.supportedThinking.map(effort => ({
          id: effort,
          displayName: effort,
          isDefault: effort === model.defaultThinking,
        })),
        input: ['text', 'localFile', 'localImage'] as const,
      })),
      modes: capabilities.modes.map(mode => ({
        id: mode.id,
        displayName: mode.label,
        description: mode.description,
        isDefault: mode.isDefault,
        ...modePolicy(mode.id),
      })),
      sessionOptions: sessionOptions.map(standardConfigOption),
    };
  }

  private async createSession(
    params: Extract<ProxyRequest, { method: 'session.create' }>['params'],
  ) {
    const existing = this.sessions.get(params.sessionId);
    if (existing) return { session: this.serialize(existing) };
    const workspaceRoots = normalizeWorkspaceRoots(params.cwd, params.workspaceRoots);
    const requestedConfig = new Map<string, string | boolean>();
    for (const [id, value] of Object.entries(params.config)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new ProxyProtocolError(
          'INVALID_REQUEST',
          `Grok config ${id} must be string or boolean.`,
          false,
        );
      }
      requestedConfig.set(id, value);
    }
    const result = await this.service.createSession({
      cwd: params.cwd,
      ...(params.nativeSession ? { nativeSessionId: params.nativeSession.id } : {}),
      ...(params.nativeSession?.mode ? { resumeMode: params.nativeSession.mode } : {}),
      mcpServers: [],
    });
    let serviceSession = result.session;
    try {
      const requested = new Map(requestedConfig);
      for (const option of serviceSession.configOptions) {
        const role = configRole(option);
        const value = role === 'model'
          ? params.model
          : role === 'mode' ? params.mode : role === 'effort' ? params.effort : undefined;
        if (typeof value === 'string') requested.set(option.id, value);
      }
      for (const [configId, value] of requested) {
        const updated = await this.service.setConfigOption({
          sessionId: serviceSession.id,
          configId,
          value,
        });
        serviceSession = updated.session;
      }
    } catch (error) {
      try {
        await this.service.closeSession({ sessionId: serviceSession.id });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Grok session configuration failed and cleanup did not complete.',
        );
      }
      throw error;
    }
    const session: AttachedSession = {
      id: params.sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.nativeSessionId,
      streamId: randomUUID(),
      cwd: params.cwd,
      workspaceRoots,
      status: serviceSession.status,
      model: this.optionValue(serviceSession.configOptions, 'model'),
      mode: this.optionValue(serviceSession.configOptions, 'mode'),
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      configOptions: [...serviceSession.configOptions],
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    this.replayBySession.set(
      session.id,
      this.buildReplay(session, result.replayUpdates as SessionNotification[]),
    );
    return { session: this.serialize(session) };
  }

  private async startTurn(
    params: Extract<ProxyRequest, { method: 'turn.start' }>['params'],
    requestId: string | number,
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    const accepted = this.ledger.accept(params);
    if (accepted === 'duplicate') return { accepted: true, turnId: params.turnId };
    if (this.activeTurnBySession.has(session.id)) {
      this.ledger.forget(params);
      throw new ProxyProtocolError('SESSION_BUSY', 'Session already has an active turn.', false);
    }
    const requestKey = String(requestId);
    const turnKey = this.turnKey(session.id, params.turnId);
    this.turnsByRequest.set(requestKey, { sessionId: session.id, turnId: params.turnId });
    this.requestByTurn.set(turnKey, requestKey);
    this.activeTurnBySession.set(session.id, params.turnId);
    this.openToolsByTurn.set(turnKey, new Set());
    try {
      assertHostPolicyHonored(
        params.policy,
        nativeModeValue(params.config.native) ?? params.config.mode ?? session.mode,
        session,
      );
      for (const [configId, value] of Object.entries(params.config.native)) {
        if (typeof value !== 'string' && typeof value !== 'boolean') {
          throw new ProxyProtocolError(
            'INVALID_REQUEST',
            `Grok config ${configId} must be string or boolean.`,
            false,
          );
        }
        await this.service.setConfigOption({
          sessionId: session.serviceSessionId,
          configId,
          value,
        });
      }
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: grokInput(params.input),
      }, requestId);
      return { accepted: true, turnId: params.turnId };
    } catch (error) {
      this.ledger.forget(params);
      this.clearTurn(session.id, params.turnId);
      throw standardError(error);
    }
  }

  private async interruptTurn(
    params: Extract<ProxyRequest, { method: 'turn.interrupt' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    this.requireActiveTurn(session.id, params.turnId);
    this.interruptedTurns.add(this.turnKey(session.id, params.turnId));
    this.resolveApprovalsForTurn(session, params.turnId, 'turn_interrupted');
    await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    return { accepted: true, turnId: params.turnId };
  }

  private async respondApproval(
    params: Extract<ProxyRequest, { method: 'approval.respond' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    this.requireActiveTurn(session.id, params.turnId);
    const approval = this.approvals.get(params.approvalId);
    if (!approval || approval.sessionId !== session.id || approval.turnId !== params.turnId) {
      throw new ProxyProtocolError('APPROVAL_NOT_FOUND', 'Approval not found.', false);
    }
    approval.selectedOptionId = params.optionId;
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: approval.serviceApprovalId,
        nativeOptionId: params.optionId,
      });
    } catch (error) {
      delete approval.selectedOptionId;
      throw standardError(error);
    }
    return { accepted: true, approvalId: params.approvalId };
  }

  private async closeSession(
    params: Extract<ProxyRequest, { method: 'session.close' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    const activeTurn = this.activeTurnBySession.get(session.id);
    if (activeTurn) {
      this.resolveApprovalsForTurn(session, activeTurn, 'session_closed');
      this.closeOpenTools(session, activeTurn, 'interrupted');
      this.emitSessionEvent('turn.completed', session, activeTurn, { stopReason: 'cancelled' });
      this.clearTurn(session.id, activeTurn);
    }
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    this.ledger.close(session.id, session.streamId);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    this.replayBySession.delete(session.id);
    this.replayPager.close(session.id);
    return { ok: true };
  }

  private async listSlash(
    params: Extract<ProxyRequest, { method: 'slash.list' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    const result = await this.service.listSlashCommands({ sessionId: session.serviceSessionId });
    return {
      commands: result.commands.map(command => ({
        name: command.name.startsWith('/') ? command.name : `/${command.name}`,
        description: command.description ?? '',
        source: 'builtin' as const,
        argHints: command.input?.hint
          ? [{ kind: 'free' as const, placeholder: command.input.hint }]
          : [],
      })),
    };
  }

  private async listNative(
    params: Extract<ProxyRequest, { method: 'session.native.list' }>['params'],
  ) {
    const result = await this.service.listNativeSessions({
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    }) as {
      sessions?: Array<{
        sessionId?: string;
        title?: string;
        cwd?: string;
        updatedAt?: string;
      }>;
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

  private replay(
    params: Extract<ProxyRequest, { method: 'session.replay' }>['params'],
  ) {
    this.requireAttached(params.sessionId, params.streamId);
    const replay = this.replayBySession.get(params.sessionId)
      ?? { streamId: stableId('replay', params.sessionId), events: [] };
    return this.replayPager.page(
      params.sessionId,
      replay,
      params.cursor,
      params.limit,
    );
  }

  private async setConfig(
    params: Extract<ProxyRequest, { method: 'session.config.set' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    if (typeof params.value !== 'string' && typeof params.value !== 'boolean') {
      throw new ProxyProtocolError('INVALID_REQUEST', 'Grok config values must be string or boolean.', false);
    }
    const result = await this.service.setConfigOption({
      sessionId: session.serviceSessionId,
      configId: params.optionId,
      value: params.value,
    });
    session.configOptions = [...result.configOptions];
    session.model = this.optionValue(session.configOptions, 'model');
    session.mode = this.optionValue(session.configOptions, 'mode');
    session.updatedAt = result.session.updatedAt;
    return {
      session: this.serialize(session),
      configOptions: session.configOptions.map(standardConfigOption),
    };
  }

  private translateEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'runtime.stopped') {
      const data = record(params.data);
      if (data.expected === true) return;
      this.emitEvent(proxyNotificationSchema.parse({
        method: 'runtime.error',
        params: {
          eventId: randomUUID(),
          emittedAt: new Date().toISOString(),
          data: {
            code: 'RUNTIME_ERROR',
            message: String(data.error ?? 'Grok ACP process stopped unexpectedly.'),
            retryable: true,
            data: jsonValue(data),
          },
        },
      }));
      return;
    }
    const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
    if (!session) return;
    const data = record(params.data);
    const requestRef = this.turnsByRequest.get(String(params.requestId ?? ''));
    const approvalRef = method === 'approval.resolved'
      ? this.approvals.get(String(data.approvalId ?? ''))
      : undefined;
    const turnId = requestRef?.turnId
      ?? approvalRef?.turnId
      ?? this.activeTurnBySession.get(session.id);

    switch (method) {
      case 'turn.started':
        if (!turnId || this.startedTurns.has(this.turnKey(session.id, turnId))) return;
        this.startedTurns.add(this.turnKey(session.id, turnId));
        this.updateSession(session, { status: 'running', lastError: null });
        this.emitSessionEvent('turn.started', session, turnId, {});
        return;
      case 'acp.sessionUpdate':
        this.translateAcpUpdate(session, turnId, record(data.update));
        return;
      case 'token_usage.updated':
        this.emitSessionEvent('usage.updated', session, turnId, data);
        return;
      case 'approval.requested': {
        if (!turnId) return;
        const approvalId = nonEmptyString(data.approvalId);
        if (!approvalId) return;
        const payload = record(data.payload);
        const toolCall = record(payload.toolCall);
        const nativeOptions = Array.isArray(data.nativeOptions) ? data.nativeOptions : [];
        this.approvals.set(approvalId, {
          sessionId: session.id,
          turnId,
          serviceApprovalId: approvalId,
        });
        this.updateSession(session, { status: 'needs-approval' });
        this.emitSessionEvent('approval.requested', session, turnId, {
          approvalId,
          category: toolCall.title === 'AskUserQuestion'
            ? 'question'
            : toolCall.title === 'ExitPlanMode' ? 'exit_plan_mode' : 'other',
          title: String(data.title ?? 'Grok permission'),
          description: String(data.reason ?? data.title ?? ''),
          options: nativeOptions.flatMap(raw => {
            const option = record(raw);
            const id = nonEmptyString(option.optionId);
            const label = nonEmptyString(option.name);
            const kind = approvalKind(option.kind);
            return id && label && kind ? [{ id, label, kind }] : [];
          }),
          payload: jsonValue(payload),
        });
        return;
      }
      case 'approval.resolved': {
        const approvalId = nonEmptyString(data.approvalId);
        if (!approvalId || !approvalRef) return;
        this.approvals.delete(approvalId);
        this.updateSession(session, { status: 'running' });
        const interrupted = this.interruptedTurns.has(this.turnKey(session.id, approvalRef.turnId));
        this.emitSessionEvent('approval.resolved', session, approvalRef.turnId, data.cancelled === true
          ? {
              approvalId,
              resolution: interrupted ? 'turn_interrupted' : 'runtime_cancelled',
              resolvedBy: 'runtime',
            }
          : {
              approvalId,
              resolution: 'selected',
              resolvedBy: 'user',
              optionId: approvalRef.selectedOptionId ?? String(data.nativeOptionId),
            });
        return;
      }
      case 'turn.completed':
        if (turnId) this.completeTurn(session, turnId, false, data);
        return;
      case 'turn.failed':
        if (turnId) this.completeTurn(session, turnId, true, data);
        return;
    }
  }

  private translateAcpUpdate(
    session: AttachedSession,
    turnId: string | undefined,
    update: Record<string, unknown>,
  ): void {
    const kind = update.sessionUpdate;
    if (kind === 'config_option_update') {
      const options = Array.isArray(update.configOptions)
        ? update.configOptions as SessionConfigOption[]
        : [];
      session.configOptions = [...options];
      session.model = this.optionValue(options, 'model');
      session.mode = this.optionValue(options, 'mode');
      this.emitSessionEvent('session.updated', session, undefined, {
        model: session.model,
        mode: session.mode,
        configOptions: options.map(standardConfigOption),
        reason: 'configuration-changed',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (!turnId) return;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = contentText(update);
      if (!text) return;
      const contentKind = kind === 'agent_thought_chunk' ? 'reasoning' : 'text';
      this.emitSessionEvent('content.delta', session, turnId, {
        contentId: nonEmptyString(record(update._meta).itemId) ?? `${contentKind}:${turnId}`,
        kind: contentKind,
        delta: text,
      });
      return;
    }
    if (kind === 'usage_update') {
      const used = typeof update.used === 'number' ? update.used : null;
      const window = typeof update.size === 'number' ? update.size : null;
      if (used !== null && window !== null && used >= 0 && window > 0) {
        this.emitSessionEvent('usage.updated', session, turnId, {
          context: { used, window },
        });
      }
      return;
    }
    if (kind === 'plan' || kind === 'plan_update') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      this.emitSessionEvent('plan.updated', session, turnId, {
        planId: 'grok-plan',
        title: typeof update.text === 'string' ? update.text : '',
        steps: entries.map((raw, index) => {
          const entry = record(raw);
          const status = String(entry.status ?? 'pending');
          return {
            id: nonEmptyString(entry.id) ?? `step-${index + 1}`,
            text: String(entry.content ?? entry.title ?? ''),
            status: status === 'completed'
              ? 'completed'
              : status === 'in_progress' ? 'in_progress'
                : status === 'failed' ? 'failed' : 'pending',
          };
        }).filter(step => step.text.length > 0),
      });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.translateTool(session, turnId, update, kind === 'tool_call');
    }
  }

  private translateTool(
    session: AttachedSession,
    turnId: string,
    update: Record<string, unknown>,
    initial: boolean,
  ): void {
    const toolCallId = nonEmptyString(update.toolCallId);
    if (!toolCallId) return;
    const open = this.openToolsByTurn.get(this.turnKey(session.id, turnId));
    if (!open) return;
    if (initial || !open.has(toolCallId)) {
      open.add(toolCallId);
      this.emitSessionEvent('tool.started', session, turnId, {
        toolCallId,
        name: nonEmptyString(update.kind) ?? 'tool',
        title: String(update.title ?? 'Tool'),
        input: jsonValue(update.rawInput),
      });
    }
    const status = toolStatus(update.status);
    if (status === 'running') {
      if (!initial) {
        this.emitSessionEvent('tool.updated', session, turnId, {
          toolCallId,
          ...(update.rawOutput !== undefined ? { data: jsonValue(update.rawOutput) } : {}),
          ...(typeof update.title === 'string' ? { statusText: update.title } : {}),
        });
      }
      return;
    }
    if (!open.delete(toolCallId)) return;
    this.emitSessionEvent('tool.completed', session, turnId, {
      toolCallId,
      status,
      ...(update.rawOutput !== undefined ? { output: jsonValue(update.rawOutput) } : {}),
      ...(status === 'failed' ? {
        error: {
          code: 'RUNTIME_ERROR',
          message: String(update.title ?? 'Grok tool failed.'),
          retryable: false,
          data: {},
        },
      } : {}),
    });
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    data: Record<string, unknown>,
  ): void {
    this.resolveApprovalsForTurn(session, turnId, 'runtime_cancelled');
    this.closeOpenTools(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      const message = String(data.message ?? 'Grok turn failed.');
      const code = turnFailureCode(data);
      this.updateSession(session, { status: 'error', lastError: message });
      this.emitSessionEvent('turn.failed', session, turnId, {
        error: {
          code,
          message,
          retryable: false,
          data: {},
        },
      });
    } else {
      const interrupted = this.interruptedTurns.has(this.turnKey(session.id, turnId));
      const nativeReason = String(data.stopReason ?? data.status ?? '');
      const stopReason = interrupted
        ? 'interrupted'
        : nativeReason === 'cancelled' ? 'cancelled'
          : nativeReason === 'end_turn' || nativeReason === 'completed' ? 'completed' : 'other';
      this.updateSession(session, { status: 'idle', lastError: null });
      this.emitSessionEvent('turn.completed', session, turnId, { stopReason });
    }
    this.clearTurn(session.id, turnId);
  }

  private closeOpenTools(
    session: AttachedSession,
    turnId: string,
    status: 'succeeded' | 'failed' | 'interrupted',
  ): void {
    const tools = this.openToolsByTurn.get(this.turnKey(session.id, turnId));
    if (!tools) return;
    for (const toolCallId of tools) {
      this.emitSessionEvent('tool.completed', session, turnId, { toolCallId, status });
    }
    tools.clear();
  }

  private resolveApprovalsForTurn(
    session: AttachedSession,
    turnId: string,
    resolution: 'turn_interrupted' | 'session_closed' | 'runtime_cancelled',
  ): void {
    for (const [approvalId, approval] of this.approvals) {
      if (approval.sessionId !== session.id || approval.turnId !== turnId) continue;
      this.approvals.delete(approvalId);
      this.emitSessionEvent('approval.resolved', session, turnId, {
        approvalId,
        resolution,
        resolvedBy: 'runtime',
      });
    }
  }

  private buildReplay(
    session: AttachedSession,
    updates: SessionNotification[],
  ): ReplayState {
    const meaningful = updates.filter(notification => {
      const kind = notification.update.sessionUpdate;
      return kind === 'user_message_chunk'
        || kind === 'agent_message_chunk'
        || kind === 'agent_thought_chunk'
        || kind === 'plan'
        || kind === 'plan_update'
        || kind === 'tool_call'
        || kind === 'tool_call_update';
    });
    const streamId = stableId('replay', {
      nativeSessionId: session.nativeSessionId,
      updates: meaningful,
    });
    if (meaningful.length === 0) return { streamId, events: [] };
    const turns: Array<{ userText: string; updates: SessionNotification[] }> = [];
    let current: { userText: string; updates: SessionNotification[] } | null = null;
    let lastWasUser = false;
    for (const notification of meaningful) {
      const kind = notification.update.sessionUpdate;
      if (kind === 'user_message_chunk') {
        if (!current || !lastWasUser) {
          current = { userText: '', updates: [] };
          turns.push(current);
        }
        current.userText += contentText(record(notification.update));
        lastWasUser = true;
        continue;
      }
      if (!current) {
        current = { userText: '', updates: [] };
        turns.push(current);
      }
      current.updates.push(notification);
      lastWasUser = false;
    }

    let sequence = 0;
    const events: ProxyNotification[] = [];
    const append = (
      turnId: string,
      method: ProxyNotification['method'],
      data: Record<string, unknown>,
    ) => {
      sequence += 1;
      events.push(proxyNotificationSchema.parse({
        method,
        params: {
          eventId: stableId('replay-event', { sequence, method, data }),
          streamId,
          sequence,
          sessionId: session.id,
          turnId,
          emittedAt: session.updatedAt,
          data,
        },
      }));
    };
    for (const [turnIndex, turn] of turns.entries()) {
      const turnId = stableId('replay-turn', {
        nativeSessionId: session.nativeSessionId,
        turnIndex,
        userText: turn.userText,
      });
      append(turnId, 'turn.started', {});
      if (turn.userText) {
        append(turnId, 'input.recorded', {
          inputId: stableId('replay-input', { turnId, text: turn.userText }),
          input: [{ type: 'text', text: turn.userText }],
        });
      }
      const openTools = new Set<string>();
      for (const [index, notification] of turn.updates.entries()) {
        const update = record(notification.update);
        const kind = update.sessionUpdate;
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
          const text = contentText(update);
          if (text) append(turnId, 'content.delta', {
            contentId: nonEmptyString(record(update._meta).itemId)
              ?? `${kind}:${turnIndex}:${index}`,
            kind: kind === 'agent_thought_chunk' ? 'reasoning' : 'text',
            delta: text,
          });
        } else if (kind === 'plan' || kind === 'plan_update') {
          const text = typeof update.text === 'string' ? update.text : '';
          if (text) append(turnId, 'content.completed', {
            contentId: `plan:${turnIndex}:${index}`,
            kind: 'plan',
            content: text,
          });
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const toolCallId = nonEmptyString(update.toolCallId);
          if (!toolCallId) continue;
          if (!openTools.has(toolCallId)) {
            openTools.add(toolCallId);
            append(turnId, 'tool.started', {
              toolCallId,
              name: nonEmptyString(update.kind) ?? 'tool',
              title: String(update.title ?? 'Tool'),
              input: jsonValue(update.rawInput),
            });
          }
          const status = toolStatus(update.status);
          if (status !== 'running' && openTools.delete(toolCallId)) {
            append(turnId, 'tool.completed', {
              toolCallId,
              status,
              ...(update.rawOutput !== undefined ? { output: jsonValue(update.rawOutput) } : {}),
            });
          }
        }
      }
      for (const toolCallId of openTools) {
        append(turnId, 'tool.completed', { toolCallId, status: 'succeeded' });
      }
      append(turnId, 'turn.completed', { stopReason: 'completed' });
    }
    return { streamId, events };
  }

  private emitSessionEvent(
    method: ProxyNotification['method'],
    session: AttachedSession,
    turnId: string | undefined,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    this.emitEvent(proxyNotificationSchema.parse({
      method,
      params: {
        eventId: randomUUID(),
        streamId: session.streamId,
        sequence: session.sequence,
        sessionId: session.id,
        ...(turnId ? { turnId } : {}),
        emittedAt: new Date().toISOString(),
        data,
      },
    }));
  }

  private optionValue(
    options: SessionConfigOption[],
    role: 'model' | 'mode',
  ): string | null {
    const option = options.find(item => configRole(item) === role);
    return option && typeof option.currentValue === 'string' ? option.currentValue : null;
  }

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.interruptedTurns.delete(key);
    this.openToolsByTurn.delete(key);
    const requestKey = this.requestByTurn.get(key);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(key);
  }

  private turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
  }

  private updateSession(session: AttachedSession, patch: Partial<AttachedSession>): void {
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
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
      configOptions: session.configOptions.map(standardConfigOption),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProxyProtocolError('SESSION_NOT_FOUND', 'Session not found.', false);
    return session;
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new ProxyProtocolError('SESSION_STALE', 'Session stream is stale.', false);
    }
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): void {
    if (this.activeTurnBySession.get(sessionId) !== turnId) {
      throw new ProxyProtocolError('TURN_NOT_FOUND', 'Turn is not active.', false);
    }
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
