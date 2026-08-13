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
import { CcProxyService } from '../core/service.js';
import {
  ClaudeNativeHistoryWatcher,
  listClaudeNativeSessions,
  renameClaudeNativeSession,
  replayClaudeNativeSession,
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
  displayName: string | null;
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
  selectedOptionId?: string;
}

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'slash.list': 1,
  'session.nativeList': 1,
  'session.rename': 1,
  'session.replay': 1,
  'approval.relay': 1,
  'event.tool': 1,
  'event.usage': 1,
  'event.agent': 1,
  'event.notice': 1,
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
        case 'APPROVAL_NOT_FOUND': return 'APPROVAL_NOT_FOUND';
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

function claudeInput(
  items: Extract<ProxyRequest, { method: 'turn.start' }>['params']['input'],
) {
  return items.map((item) => {
    switch (item.type) {
      case 'text': return { type: 'text' as const, text: item.text };
      case 'localImage': return { type: 'localImage' as const, path: item.path };
      case 'localFile': return {
        type: 'localFile' as const,
        path: item.path,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.mime !== undefined ? { mime: item.mime } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
      };
      case 'skill':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'Claude Proxy does not advertise input.skill.',
          false,
        );
    }
  });
}

function permissionMode(
  mode: string | null | undefined,
  policy: Extract<ProxyRequest, { method: 'turn.start' }>['params']['policy'],
) {
  if (policy.approval === 'never') return 'bypassPermissions' as const;
  if (mode === 'plan') return 'plan' as const;
  if (mode === 'auto' || policy.approval === 'auto') return 'auto' as const;
  return 'default' as const;
}

export class ClaudeProtocolV1Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  /** gian.proxy/1 exposes one opaque catalog id, while the legacy Claude
   *  service keeps a separate provider-facing model value. Remember the
   *  relationship so a catalog selection round-trips back to the exact value
   *  Claude CLI expects (for example claude-alias-opus -> opus). */
  private readonly runtimeModelByCatalogId = new Map<string, string>();
  private catalogModelsLoaded = false;
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private readonly approvals = new Map<string, ApprovalRef>();
  private readonly openToolsByTurn = new Map<string, Set<string>>();
  private readonly replayBySession = new Map<string, NativeReplay>();
  private readonly replayTrackers = new Map<string, IncrementalReplayTracker>();
  private readonly replayPager = new ReplaySnapshotPager<ProxyNotification>();
  private readonly historyWatchers = new Map<string, ClaudeNativeHistoryWatcher>();
  private readonly ledger = new AttachmentTurnLedger();
  private initialized = false;

  constructor(
    private readonly service: CcProxyService,
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
      case 'session.native.list': {
        const sessions = listClaudeNativeSessions(request.params.cwd);
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
      case 'session.rename': {
        const session = this.requireAttached(request.params.sessionId, request.params.streamId);
        session.displayName = request.params.name;
        renameClaudeNativeSession(
          session.nativeSessionId,
          session.cwd,
          request.params.name,
        );
        return { ok: true };
      }
      case 'session.config.set':
      case 'turn.steer':
        throw new ProxyProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          `${request.method} is not advertised by Claude Proxy.`,
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
      plugin: { id: 'claude', name: 'Claude Code', version: this.pluginVersion },
      process: { scope: 'session' },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    this.rememberCatalogModels(capabilities.models);
    return {
      models: capabilities.models.map(model => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        isDefault: model.isDefault,
        efforts: model.supportedEfforts.map(effort => ({
          id: effort,
          displayName: effort,
          isDefault: effort === model.defaultEffort,
        })),
        input: ['text', 'localFile', 'localImage'] as const,
      })),
      modes: [
        catalogMode('plan', 'Plan', 'Explore and plan without making changes.', false, 'relay', 'read-only', 'ask'),
        catalogMode('ask', 'Ask', 'Ask before risky actions.', true, 'relay', 'workspace-write', 'ask'),
        catalogMode('auto', 'Auto', 'Let Claude review actions automatically.', false, 'auto', 'workspace-write', 'allow'),
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
        'Claude Proxy does not advertise session config options.',
        false,
      );
    }
    const runtimeModel = await this.resolveRuntimeModel(params.model);
    const result = await this.service.createSession({
      cwd: params.cwd,
      ...(runtimeModel !== undefined ? { model: runtimeModel } : {}),
      ...(params.nativeSession ? { claudeSessionId: params.nativeSession.id } : {}),
    });
    const serviceSession = result.session;
    const session: AttachedSession = {
      id: params.sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.claudeSessionId,
      streamId: randomUUID(),
      cwd: params.cwd,
      status: serviceSession.status,
      // Keep the protocol-facing catalog id on the attached session. The
      // service session intentionally stores the resolved provider value.
      model: params.model === undefined ? serviceSession.model : params.model,
      mode: params.mode ?? null,
      displayName: null,
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
      replayClaudeNativeSession(session.id, session.nativeSessionId, session.cwd),
      params.nativeSession?.mode === 'load',
    );
    this.replayTrackers.set(session.id, replayTracker);
    this.replayBySession.set(session.id, replayTracker.replay());
    const historyWatcher = new ClaudeNativeHistoryWatcher(
      session.nativeSessionId,
      session.cwd,
      () => {
        if (!this.sessions.has(session.id)) return;
        const full = replayClaudeNativeSession(
          session.id,
          session.nativeSessionId,
          session.cwd,
        );
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
        'Claude Proxy does not advertise native turn config options.',
        false,
      );
    }
    const requestKey = String(requestId);
    const turnKey = this.turnKey(session.id, params.turnId);
    this.turnsByRequest.set(requestKey, { sessionId: session.id, turnId: params.turnId });
    this.requestByTurn.set(turnKey, requestKey);
    this.activeTurnBySession.set(session.id, params.turnId);
    this.openToolsByTurn.set(turnKey, new Set());
    this.historyWatchers.get(session.id)?.pause();
    try {
      const runtimeModel = await this.resolveRuntimeModel(params.config.model);
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: claudeInput(params.input),
        permissionMode: permissionMode(params.config.mode ?? session.mode, params.policy),
        ...(session.displayName ? { displayName: session.displayName } : {}),
        ...(runtimeModel !== undefined ? { model: runtimeModel } : {}),
        ...(params.config.effort !== undefined ? { thinking: params.config.effort } : {}),
      }, requestId);
      if (params.config.model !== undefined) session.model = params.config.model;
      return { accepted: true, turnId: params.turnId };
    } catch (error) {
      this.ledger.forget(params);
      this.clearTurn(session.id, params.turnId);
      this.historyWatchers.get(session.id)?.resume();
      this.rebaseHistory(session);
      throw standardError(error);
    }
  }

  private async interruptTurn(
    params: Extract<ProxyRequest, { method: 'turn.interrupt' }>['params'],
  ) {
    const session = this.requireAttached(params.sessionId, params.streamId);
    this.requireActiveTurn(session.id, params.turnId);
    this.resolveApprovalsForTurn(session, params.turnId, 'turn_interrupted');
    await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    this.closeOpenTools(session, params.turnId, 'interrupted');
    this.updateSession(session, { status: 'idle', lastError: null });
    this.emitSessionEvent('turn.completed', session, params.turnId, { stopReason: 'interrupted' });
    this.clearTurn(session.id, params.turnId);
    this.historyWatchers.get(session.id)?.resume();
    this.rebaseHistory(session);
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
    if (params.optionId !== 'allow_once' && params.optionId !== 'reject_once') {
      throw new ProxyProtocolError(
        'APPROVAL_OPTION_NOT_FOUND',
        'Approval option is not available.',
        false,
      );
    }
    approval.selectedOptionId = params.optionId;
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: approval.serviceApprovalId,
        behavior: params.optionId === 'allow_once' ? 'allow' : 'deny',
        ...(params.answers ? { answers: params.answers } : {}),
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
      case 'output.text':
        if (!turnId) return;
        this.emitSessionEvent('content.completed', session, turnId, {
          contentId: nonEmptyString(data.itemId) ?? `text:${randomUUID()}`,
          kind: 'text',
          content: String(data.text ?? ''),
        });
        return;
      case 'tool.use': {
        if (!turnId) return;
        const toolCallId = nonEmptyString(data.callId);
        if (!toolCallId) return;
        this.openToolsByTurn.get(this.turnKey(session.id, turnId))?.add(toolCallId);
        this.emitSessionEvent('tool.started', session, turnId, {
          toolCallId,
          name: nonEmptyString(data.toolName) ?? 'unknown',
          input: jsonValue(data.input),
        });
        return;
      }
      case 'tool.result': {
        if (!turnId) return;
        const toolCallId = nonEmptyString(data.callId);
        const open = this.openToolsByTurn.get(this.turnKey(session.id, turnId));
        if (!toolCallId || !open?.delete(toolCallId)) return;
        const isError = data.isError === true;
        this.emitSessionEvent('tool.completed', session, turnId, {
          toolCallId,
          status: isError ? 'failed' : 'succeeded',
          output: jsonValue(data.output),
          ...(isError ? {
            error: {
              code: 'RUNTIME_ERROR',
              message: 'Claude tool execution failed.',
              retryable: false,
              data: {},
            },
          } : {}),
        });
        return;
      }
      case 'claude.task': {
        if (!turnId) return;
        const agentId = nonEmptyString(data.taskId);
        if (!agentId) return;
        this.emitSessionEvent('agent.updated', session, turnId, {
          agentId,
          status: data.status === 'done'
            ? 'completed'
            : data.status === 'error' ? 'failed' : 'running',
          description: String(data.description ?? ''),
          ...(nonEmptyString(data.agentType) ? { agentType: data.agentType } : {}),
          ...(nonEmptyString(data.summary) ? { output: data.summary } : {}),
        });
        return;
      }
      case 'auto.classifier_denied':
        if (!turnId) return;
        this.emitSessionEvent('notice.created', session, turnId, {
          noticeId: randomUUID(),
          severity: 'warning',
          code: 'CLAUDE_AUTO_CLASSIFIER_DENIED',
          title: 'Action blocked',
          message: String(data.reason ?? data.action ?? ''),
        });
        return;
      case 'auto.circuit_breaker':
        if (!turnId) return;
        this.emitSessionEvent('notice.created', session, turnId, {
          noticeId: randomUUID(),
          severity: 'error',
          code: 'CLAUDE_AUTO_CIRCUIT_BREAKER',
          title: 'Automatic execution stopped',
          message: `Claude stopped after repeated blocked actions (${String(data.trigger ?? 'limit')}).`,
        });
        return;
      case 'token_usage.updated':
        this.emitSessionEvent('usage.updated', session, turnId, data);
        return;
      case 'approval.requested': {
        if (!turnId) return;
        const approvalId = nonEmptyString(data.approvalId);
        if (!approvalId) return;
        const toolName = String(data.toolName ?? '');
        const category = data.category === 'exit_plan_mode'
          ? 'exit_plan_mode'
          : toolName === 'AskUserQuestion'
            ? 'question'
            : toolName === 'Bash' ? 'command'
              : toolName === 'Write' || toolName === 'Edit' ? 'file_write' : 'other';
        this.approvals.set(approvalId, {
          sessionId: session.id,
          turnId,
          serviceApprovalId: approvalId,
        });
        this.updateSession(session, { status: 'needs-approval' });
        this.emitSessionEvent('approval.requested', session, turnId, {
          approvalId,
          category,
          title: toolName ? `${toolName} requires approval` : 'Review request',
          description: String(data.description ?? ''),
          options: [
            { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
            { id: 'reject_once', label: 'Reject', kind: 'reject_once' },
          ],
          payload: jsonValue({
            toolName,
            inputPreview: data.inputPreview ?? '',
          }),
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
          optionId: approvalRef.selectedOptionId
            ?? (data.behavior === 'deny' ? 'reject_once' : 'allow_once'),
        });
        return;
      }
      case 'session.rotated': {
        const nativeSessionId = nonEmptyString(data.newNativeSessionId);
        if (!nativeSessionId) return;
        this.updateSession(session, { nativeSessionId });
        this.historyWatchers.get(session.id)?.retarget(nativeSessionId, session.cwd);
        const tracker = this.replayTrackers.get(session.id);
        if (tracker) {
          tracker.attach(
            replayClaudeNativeSession(session.id, nativeSessionId, session.cwd),
            false,
          );
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
      case 'turn.completed':
        if (turnId) this.completeTurn(session, turnId, false, 'completed');
        return;
      case 'turn.failed':
        if (turnId) this.completeTurn(
          session,
          turnId,
          true,
          String(data.error ?? data.message ?? 'Claude turn failed.'),
        );
        return;
    }
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    detail: string,
  ): void {
    this.resolveApprovalsForTurn(session, turnId, 'runtime_cancelled');
    this.closeOpenTools(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      this.updateSession(session, { status: 'error', lastError: detail });
      this.emitSessionEvent('turn.failed', session, turnId, {
        error: { code: 'RUNTIME_ERROR', message: detail, retryable: false, data: {} },
      });
    } else {
      this.updateSession(session, { status: 'idle', lastError: null });
      this.emitSessionEvent('turn.completed', session, turnId, { stopReason: 'completed' });
    }
    this.clearTurn(session.id, turnId);
    this.historyWatchers.get(session.id)?.resume();
    this.rebaseHistory(session);
  }

  private rebaseHistory(session: AttachedSession): void {
    const tracker = this.replayTrackers.get(session.id);
    if (!tracker) return;
    tracker.rebase(
      replayClaudeNativeSession(session.id, session.nativeSessionId, session.cwd),
    );
    this.replayBySession.set(session.id, tracker.replay());
  }

  private closeOpenTools(
    session: AttachedSession,
    turnId: string,
    status: 'succeeded' | 'failed' | 'interrupted',
  ): void {
    const key = this.turnKey(session.id, turnId);
    const tools = this.openToolsByTurn.get(key);
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

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.openToolsByTurn.delete(key);
    const requestKey = this.requestByTurn.get(key);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(key);
  }

  private turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
  }

  private rememberCatalogModels(
    models: Awaited<ReturnType<CcProxyService['listCapabilities']>>['models'],
  ): void {
    this.runtimeModelByCatalogId.clear();
    for (const model of models) {
      this.runtimeModelByCatalogId.set(model.id, model.model);
    }
    this.catalogModelsLoaded = true;
  }

  /** Resolve an opaque gian.proxy/1 catalog id to the provider-facing model
   *  value. Direct/raw model strings from older persisted Host configuration
   *  remain valid for backward compatibility. */
  private async resolveRuntimeModel(
    modelId: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (modelId === undefined || modelId === null) return modelId;
    if (!this.catalogModelsLoaded) {
      const capabilities = await this.service.listCapabilities();
      this.rememberCatalogModels(capabilities.models);
    }
    return this.runtimeModelByCatalogId.has(modelId)
      ? this.runtimeModelByCatalogId.get(modelId)!
      : modelId;
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

export function claudeProtocolError(error: unknown) {
  const standard = standardError(error);
  return {
    code: standard.code === 'PROTOCOL_VIOLATION' ? 'INVALID_REQUEST' : standard.code,
    message: standard.message,
    retryable: false,
    data: {},
  };
}
