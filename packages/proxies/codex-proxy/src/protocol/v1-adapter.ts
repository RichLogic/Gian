import { randomUUID } from 'node:crypto';
import {
  AttachmentTurnLedger,
  IncrementalReplayTracker,
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
import { AppError } from '../core/errors.js';
import { CodexProxyService } from '../core/service.js';
import {
  CodexNativeHistoryWatcher,
  listCodexNativeSessions,
  replayCodexNativeSession,
  type NativeReplay,
} from './native-history.js';

type V1EventSink = (notification: ProxyNotification) => void;

interface AttachedSession {
  id: string;
  serviceSessionId: string;
  nativeSessionId: string;
  streamId: string;
  cwd: string;
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

interface ApprovalRef extends HostTurnRef {
  serviceApprovalId: string;
}

const CAPABILITIES = {
  'input.localImage': 1,
  'input.skill': 1,
  'slash.list': 1,
  'session.nativeList': 1,
  'session.replay': 1,
  'session.rename': 1,
  'turn.steer': 1,
  'approval.relay': 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.command': 1,
  'event.diff': 1,
  'event.usage': 1,
  'event.agent': 1,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function standardError(error: unknown): ProxyProtocolError {
  if (error instanceof ProxyProtocolError) return error;
  if (error instanceof AppError) {
    const code = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_CLOSED': return 'SESSION_CLOSED';
        case 'SESSION_STALE': return 'SESSION_STALE';
        case 'SESSION_ERROR': return 'SESSION_ERROR';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'NO_ACTIVE_TURN': return 'TURN_NOT_FOUND';
        case 'APPROVAL_NOT_FOUND': return 'APPROVAL_NOT_FOUND';
        case 'THREAD_NOT_FOUND': return 'NATIVE_SESSION_NOT_FOUND';
        case 'NOT_SUPPORTED':
        case 'UNSUPPORTED': return 'CAPABILITY_NOT_SUPPORTED';
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

function modePolicy(mode: string | null | undefined) {
  switch (mode) {
    case 'plan':
      return { sandbox: 'read-only' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const, collaborationMode: 'plan' as const };
    case 'auto':
      return { sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const, collaborationMode: 'default' as const };
    case 'custom':
      return { useConfiguredPermissions: true as const, collaborationMode: 'default' as const };
    case 'full-access':
      return { sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, collaborationMode: 'default' as const };
    default:
      return { sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const, collaborationMode: 'default' as const };
  }
}

function codexInput(
  items: Extract<ProxyRequest, { method: 'turn.start' }>['params']['input'],
) {
  return items.map((item) => {
    switch (item.type) {
      case 'text': return { type: 'text' as const, text: item.text };
      case 'localImage': return { type: 'localImage' as const, path: item.path };
      case 'skill': return { type: 'skill' as const, name: item.name, path: item.path };
      case 'localFile':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'Codex Proxy does not advertise input.localFile.',
          false,
        );
    }
  });
}

function catalogMode(
  id: string,
  displayName: string,
  description: string,
  isDefault: boolean,
  approval: 'relay' | 'auto' | 'never',
  workspace: 'read-only' | 'workspace-write' | 'full-access',
  network: 'deny' | 'ask' | 'allow',
) {
  return { id, displayName, description, isDefault, approval, workspace, network };
}

function codexUsage(data: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(data, 'context')) {
    const context = data.context;
    if (context === null) {
      return {
        context: null,
        ...(data.reason === 'compact_started' ? { reason: 'compact_started' } : {}),
      };
    }
    const canonical = record(context);
    const used = nonNegativeInteger(canonical.used);
    const window = nonNegativeInteger(canonical.window);
    if (used !== undefined) {
      return { context: { used, ...(window && window > 0 ? { window } : {}) } };
    }
  }

  const tokenUsage = record(record(data.params).tokenUsage);
  const total = record(tokenUsage.total);
  const last = record(tokenUsage.last);
  const inputTokens = nonNegativeInteger(total.inputTokens);
  const outputTokens = nonNegativeInteger(total.outputTokens);
  const cachedInputTokens = nonNegativeInteger(total.cachedInputTokens);
  const totalTokens = nonNegativeInteger(total.totalTokens);
  const used = nonNegativeInteger(last.totalTokens);
  const window = nonNegativeInteger(tokenUsage.modelContextWindow);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cachedInputTokens === undefined
    || totalTokens === undefined
    || used === undefined
  ) return null;
  return {
    context: { used, ...(window && window > 0 ? { window } : {}) },
    conversation: {
      mode: 'absolute',
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
    },
  };
}

export class CodexProtocolV1Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private readonly approvals = new Map<string, ApprovalRef>();
  private readonly replayBySession = new Map<string, NativeReplay>();
  private readonly replayTrackers = new Map<string, IncrementalReplayTracker>();
  private readonly replayPager = new ReplaySnapshotPager<ProxyNotification>();
  private readonly historyWatchers = new Map<string, CodexNativeHistoryWatcher>();
  private readonly ledger = new AttachmentTurnLedger();
  private initialized = false;

  constructor(
    private readonly service: CodexProxyService,
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
      case 'catalog.list':
        return this.catalog();
      case 'session.create':
        return this.createSession(request.params);
      case 'session.get':
        return { session: this.serialize(this.requireSession(request.params.sessionId)) };
      case 'turn.start':
        return this.startTurn(request.params, request.id);
      case 'turn.interrupt':
        return this.interruptTurn(request.params);
      case 'session.close':
        return this.closeSession(request.params);
      case 'slash.list': {
        const session = this.requireAttached(request.params.sessionId, request.params.streamId);
        const result = await this.service.listSlashCommands(session.cwd);
        return {
          commands: result.commands.map(command => ({
            name: command.name,
            description: command.description,
            source: command.source,
            argHints: command.argHints ?? [],
          })),
        };
      }
      case 'session.rename': {
        const session = this.requireAttached(request.params.sessionId, request.params.streamId);
        await this.service.setName({ sessionId: session.serviceSessionId, name: request.params.name });
        return { ok: true };
      }
      case 'turn.steer': {
        const session = this.requireAttached(request.params.sessionId, request.params.streamId);
        this.requireActiveTurn(session.id, request.params.turnId);
        await this.service.steerTurn({
          sessionId: session.serviceSessionId,
          input: codexInput(request.params.input),
        });
        return { accepted: true, turnId: request.params.turnId };
      }
      case 'approval.respond':
        return this.respondApproval(request.params);
      case 'session.native.list': {
        let sessions;
        try {
          sessions = await this.service.listNativeThreads(request.params.cwd)
            ?? listCodexNativeSessions(request.params.cwd);
        } catch {
          // Old app-server builds do not expose thread/list. Keep rollout
          // discovery as the backwards-compatible source in that case.
          sessions = listCodexNativeSessions(request.params.cwd);
        }
        const offset = request.params.cursor === null || request.params.cursor === undefined
          ? 0
          : Number.parseInt(request.params.cursor, 10);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > sessions.length) {
          throw new ProxyProtocolError('INVALID_REQUEST', 'Invalid native session cursor.', false);
        }
        const limit = request.params.limit ?? 100;
        const end = Math.min(offset + limit, sessions.length);
        return {
          sessions: sessions.slice(offset, end),
          nextCursor: end < sessions.length ? String(end) : null,
        };
      }
      case 'session.replay':
        return this.replay(request.params);
      case 'session.config.set':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          `${request.method} is not advertised by Codex Proxy.`,
          false,
        );
      case 'shutdown':
        return { ok: true };
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
      plugin: { id: 'codex', name: 'Codex', version: this.pluginVersion },
      process: { scope: 'shared' },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    return {
      models: capabilities.models.map(model => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        isDefault: model.isDefault,
        efforts: model.supportedThinking.map(effort => ({
          id: effort,
          displayName: effort,
          isDefault: effort === model.defaultThinking,
        })),
        input: ['text', 'localImage', 'skill'] as const,
      })),
      modes: [
        catalogMode('plan', 'Plan', 'Explore and plan without making changes.', false, 'relay', 'read-only', 'ask'),
        catalogMode('ask', 'Ask', 'Ask before risky actions.', true, 'relay', 'workspace-write', 'ask'),
        catalogMode('auto', 'Auto', 'Let Codex review actions automatically.', false, 'auto', 'workspace-write', 'allow'),
        catalogMode('custom', 'Custom', 'Use permissions from config.toml.', false, 'relay', 'workspace-write', 'ask'),
        catalogMode('full-access', 'Full access', 'Run without sandbox or approval prompts.', false, 'never', 'full-access', 'allow'),
      ],
      sessionOptions: [],
    };
  }

  private async createSession(
    params: Extract<ProxyRequest, { method: 'session.create' }>['params'],
  ) {
    const existing = this.sessions.get(params.sessionId);
    if (existing) return { session: this.serialize(existing) };
    if (Object.keys(params.config).length > 0) {
      throw new ProxyProtocolError(
        'INVALID_REQUEST',
        'Codex Proxy does not advertise session config options.',
        false,
      );
    }
    const result = await this.service.createSession({
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.effort !== undefined ? { thinking: params.effort } : {}),
      ...(params.nativeSession ? { threadId: params.nativeSession.id } : {}),
    });
    const serviceSession = result.session as {
      id: string;
      threadId: string;
      status: AttachedSession['status'];
      model: string | null;
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    };
    const session: AttachedSession = {
      id: params.sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.threadId,
      streamId: randomUUID(),
      cwd: params.cwd,
      status: serviceSession.status,
      model: serviceSession.model,
      mode: params.mode ?? null,
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    const replayTracker = new IncrementalReplayTracker();
    replayTracker.attach(
      replayCodexNativeSession(session.id, session.nativeSessionId),
      params.nativeSession?.mode === 'load',
    );
    this.replayTrackers.set(session.id, replayTracker);
    this.replayBySession.set(session.id, replayTracker.replay());
    const historyWatcher = new CodexNativeHistoryWatcher(
      session.nativeSessionId,
      () => {
        if (!this.sessions.has(session.id)) return;
        const full = replayCodexNativeSession(session.id, session.nativeSessionId);
        if (!replayTracker.observe(full)) return;
        this.replayBySession.set(session.id, replayTracker.replay());
        this.emitSessionEvent('session.updated', session, undefined, {
          reason: 'native-history-changed',
          updatedAt: new Date().toISOString(),
        });
      },
    );
    historyWatcher.start();
    this.historyWatchers.set(session.id, historyWatcher);
    return { session: this.serialize(session) };
  }

  private replay(
    params: Extract<ProxyRequest, { method: 'session.replay' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    const state = this.replayBySession.get(session.id)
      ?? { streamId: `replay-empty-${session.id}`, events: [] };
    const result = this.replayPager.page(
      session.id,
      state,
      params.cursor,
      params.limit,
    );
    if (result.nextCursor === null) {
      this.replayTrackers.get(session.id)?.acknowledge();
      const replay = this.replayTrackers.get(session.id)?.replay();
      if (replay) this.replayBySession.set(session.id, replay);
    }
    return result;
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
    if (Object.keys(params.config.native).length > 0) {
      this.ledger.forget(params);
      throw new ProxyProtocolError(
        'INVALID_REQUEST',
        'Codex Proxy does not advertise native turn config options.',
        false,
      );
    }

    const requestKey = String(requestId);
    const turnKey = `${session.id}\u0000${params.turnId}`;
    this.turnsByRequest.set(requestKey, { sessionId: session.id, turnId: params.turnId });
    this.requestByTurn.set(turnKey, requestKey);
    this.activeTurnBySession.set(session.id, params.turnId);
    this.historyWatchers.get(session.id)?.pause();
    try {
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: codexInput(params.input),
        additionalWorkspaceRoots: params.policy.workspaceRoots,
        ...(params.config.model !== undefined ? { model: params.config.model } : {}),
        ...(params.config.effort !== undefined ? { thinking: params.config.effort } : {}),
        ...modePolicy(params.config.mode ?? session.mode),
      }, requestId);
      return { accepted: true, turnId: params.turnId };
    } catch (error) {
      this.ledger.forget(params);
      this.turnsByRequest.delete(requestKey);
      this.requestByTurn.delete(turnKey);
      this.activeTurnBySession.delete(session.id);
      this.historyWatchers.get(session.id)?.resume();
      this.rebaseHistory(session);
      throw error;
    }
  }

  private async interruptTurn(
    params: Extract<ProxyRequest, { method: 'turn.interrupt' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    this.requireActiveTurn(session.id, params.turnId);
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
    const option = (() => {
      switch (params.optionId) {
        case 'allow_once': return { decision: 'accept' as const, scope: 'once' as const };
        case 'allow_session': return { decision: 'accept' as const, scope: 'session' as const };
        case 'reject_once': return { decision: 'decline' as const, scope: 'once' as const };
        default: return null;
      }
    })();
    if (!option) {
      throw new ProxyProtocolError('APPROVAL_OPTION_NOT_FOUND', 'Approval option is not available.', false);
    }
    await this.service.respondApproval({
      sessionId: session.serviceSessionId,
      approvalId: approval.serviceApprovalId,
      ...option,
    });
    return { accepted: true, approvalId: params.approvalId };
  }

  private async closeSession(
    params: Extract<ProxyRequest, { method: 'session.close' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    const activeTurn = this.activeTurnBySession.get(session.id);
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    if (activeTurn) this.resolveApprovalsForTurn(session, activeTurn, 'session_closed');
    this.historyWatchers.get(session.id)?.stop();
    this.historyWatchers.delete(session.id);
    this.ledger.close(session.id, session.streamId);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    this.replayBySession.delete(session.id);
    this.replayTrackers.delete(session.id);
    this.replayPager.close(session.id);
    return { ok: true };
  }

  private translateEvent(method: string, params: Record<string, unknown>): void {
    try {
      const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
      if (!session) {
        if (method === 'runtime.error') {
          const data = record(params.data ?? params);
          this.emitEvent(proxyNotificationSchema.parse({
            method: 'runtime.error',
            params: {
              eventId: randomUUID(),
              emittedAt: new Date().toISOString(),
              data: {
                code: 'RUNTIME_ERROR',
                message: String(data.message ?? 'Codex runtime error.'),
                retryable: false,
                data: {},
              },
            },
          }));
        }
        return;
      }
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
          if (!turnId || this.startedTurns.has(`${session.id}\u0000${turnId}`)) return;
          this.startedTurns.add(`${session.id}\u0000${turnId}`);
          this.updateSession(session, { status: 'running', lastError: null });
          this.emitSessionEvent('turn.started', session, turnId, {});
          return;
        case 'output.text.delta':
          this.emitContent(session, turnId, data, 'text');
          return;
        case 'output.reasoning.delta':
          this.emitContent(session, turnId, data, 'reasoning');
          return;
        case 'output.plan.delta':
          this.emitContent(session, turnId, data, 'plan');
          return;
        case 'output.plan.final':
          if (!turnId) return;
          this.emitSessionEvent('content.completed', session, turnId, {
            contentId: nonEmptyString(data.itemId) ?? 'plan',
            kind: 'plan',
            content: String(data.text ?? ''),
          });
          return;
        case 'output.command.delta':
          this.emitContent(session, turnId, data, 'command');
          return;
        case 'diff.updated': {
          if (!turnId) return;
          const inner = record(data.params ?? data);
          const diff = String(inner.diff ?? inner.unified ?? '');
          if (!diff) return;
          this.emitSessionEvent('diff.updated', session, turnId, {
            diffId: nonEmptyString(data.itemId) ?? `diff:${turnId}`,
            diff,
          });
          return;
        }
        case 'token_usage.updated': {
          const usage = codexUsage(data);
          if (!usage) return;
          this.emitSessionEvent('usage.updated', session, turnId, usage);
          return;
        }
        case 'codex.agent':
          if (!turnId || !Array.isArray(data.updates)) return;
          for (const raw of data.updates) {
            const update = record(raw);
            const agentId = nonEmptyString(update.agentId);
            if (!agentId) continue;
            this.emitSessionEvent('agent.updated', session, turnId, {
              agentId,
              status: update.status === 'done'
                ? 'completed'
                : update.status === 'error' ? 'failed' : 'running',
              description: String(update.description ?? ''),
              ...(nonEmptyString(update.agentType) ? { agentType: update.agentType } : {}),
              ...(nonEmptyString(update.model) ? { model: update.model } : {}),
              ...(nonEmptyString(update.output) ? { output: update.output } : {}),
            });
          }
          return;
        case 'approval.requested': {
          if (!turnId) return;
          const approvalId = nonEmptyString(data.approvalId);
          if (!approvalId) return;
          this.approvals.set(approvalId, {
            sessionId: session.id,
            turnId,
            serviceApprovalId: approvalId,
          });
          this.updateSession(session, { status: 'needs-approval' });
          const nativeMethod = String(data.method ?? '');
          const category = nativeMethod.includes('commandExecution')
            ? 'command'
            : nativeMethod.includes('fileChange')
              ? 'file_write'
              : nativeMethod.includes('permissions') ? 'permission' : 'other';
          this.emitSessionEvent('approval.requested', session, turnId, {
            approvalId,
            category,
            title: String(data.title ?? 'Review request'),
            description: String(data.reason ?? data.risk ?? ''),
            options: [
              { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
              { id: 'allow_session', label: 'Allow for session', kind: 'allow_session' },
              { id: 'reject_once', label: 'Reject', kind: 'reject_once' },
            ],
            payload: jsonValue(data.payload),
          });
          return;
        }
        case 'approval.resolved': {
          const approvalId = nonEmptyString(data.approvalId);
          if (!approvalId || !approvalRef) return;
          this.approvals.delete(approvalId);
          this.updateSession(session, { status: 'running' });
          this.emitSessionEvent('approval.resolved', session, approvalRef.turnId, {
            approvalId,
            resolution: 'selected',
            resolvedBy: 'user',
            optionId: data.decision === 'decline'
              ? 'reject_once'
              : data.scope === 'session' ? 'allow_session' : 'allow_once',
          });
          return;
        }
        case 'session.rotated': {
          const nativeSessionId = nonEmptyString(data.newNativeSessionId);
          if (!nativeSessionId) return;
          this.updateSession(session, { nativeSessionId });
          this.historyWatchers.get(session.id)?.retarget(nativeSessionId);
          const tracker = this.replayTrackers.get(session.id);
          if (tracker) {
            tracker.attach(replayCodexNativeSession(session.id, nativeSessionId), false);
            this.replayBySession.set(session.id, tracker.replay());
          }
          this.emitSessionEvent('session.updated', session, undefined, {
            nativeSession: { id: nativeSessionId },
            reason: 'native-session-rotated',
            updatedAt: session.updatedAt,
          });
          this.emitSessionEvent('usage.updated', session, undefined, {
            context: null,
            conversation: { mode: 'reset' },
            reason: 'session_reset',
          });
          return;
        }
        case 'runtime.error':
          if (turnId) {
            this.completeTurn(session, turnId, true, String(data.message ?? 'Codex runtime error.'));
          } else {
            this.updateSession(session, {
              status: 'error',
              lastError: String(data.message ?? 'Codex runtime error.'),
            });
            this.emitSessionEvent('runtime.error', session, undefined, {
              code: 'RUNTIME_ERROR',
              message: session.lastError ?? 'Codex runtime error.',
              retryable: false,
              data: {},
            });
          }
          return;
        case 'turn.failed':
          if (turnId) this.completeTurn(session, turnId, true, String(data.message ?? 'Codex turn failed.'));
          return;
        case 'turn.completed':
          if (turnId) this.completeTurn(session, turnId, false, String(data.status ?? 'completed'));
          return;
      }
    } catch (error) {
      throw standardError(error);
    }
  }

  private emitContent(
    session: AttachedSession,
    turnId: string | undefined,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning' | 'plan' | 'command',
  ): void {
    if (!turnId) return;
    const delta = String(data.delta ?? data.text ?? '');
    if (!delta) return;
    this.emitSessionEvent('content.delta', session, turnId, {
      contentId: nonEmptyString(data.itemId) ?? `${kind}:${turnId}`,
      kind,
      delta,
    });
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    detail: string,
  ): void {
    this.resolveApprovalsForTurn(session, turnId, 'runtime_cancelled');
    if (failed) {
      this.updateSession(session, { status: 'error', lastError: detail });
      this.emitSessionEvent('turn.failed', session, turnId, {
        error: { code: 'RUNTIME_ERROR', message: detail, retryable: false, data: {} },
      });
    } else {
      this.updateSession(session, { status: 'idle', lastError: null });
      const stopReason = detail === 'interrupted'
        ? 'interrupted'
        : detail === 'cancelled' ? 'cancelled' : 'completed';
      this.emitSessionEvent('turn.completed', session, turnId, { stopReason });
    }
    this.activeTurnBySession.delete(session.id);
    this.startedTurns.delete(`${session.id}\u0000${turnId}`);
    const requestKey = this.requestByTurn.get(`${session.id}\u0000${turnId}`);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(`${session.id}\u0000${turnId}`);
    this.historyWatchers.get(session.id)?.resume();
    this.rebaseHistory(session);
  }

  private rebaseHistory(session: AttachedSession): void {
    const tracker = this.replayTrackers.get(session.id);
    if (!tracker) return;
    tracker.rebase(replayCodexNativeSession(session.id, session.nativeSessionId));
    this.replayBySession.set(session.id, tracker.replay());
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

  private emitSessionEvent(
    method: ProxyNotification['method'],
    session: AttachedSession,
    turnId: string | undefined,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    const envelope = {
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
    };
    this.emitEvent(proxyNotificationSchema.parse(envelope));
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

export function codexProtocolError(error: unknown) {
  const standard = standardError(error);
  return {
    code: standard.code === 'PROTOCOL_VIOLATION' ? 'INVALID_REQUEST' : standard.code,
    message: standard.message,
    retryable: false,
    data: {},
  };
}
