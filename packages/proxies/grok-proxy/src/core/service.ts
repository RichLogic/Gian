import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type {
  AvailableCommand,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import {
  catalogFromModelState,
  commandsFromUnknown,
  effortIdsForModel,
  modelStateFromUnknown,
  type GrokModelState,
} from './catalog.js';
import { createAppError, GrokProxyError } from './errors.js';
import { parsePromptUsage } from './events.js';
import { firstText, normalizeInputItems, toPromptBlocks } from './input.js';
import {
  grokPermissionSpec,
  parseGrokPermissionMode,
  type GrokPermissionMode,
} from './permissions.js';
import { firstSlashToken, isBlockedSlashCommand } from './slash-policy.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  ListNativeSessionsParams,
  PendingApproval,
  SessionRecord,
  SetConfigOptionParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import { GrokAcpClient } from '../runtime/grok-acp-client.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

interface ActiveTurn {
  turnId: string;
  completed: boolean;
  generation: number;
}

export interface ServiceOptions {
  binaryPath: string;
  createRuntime?: (cwd: string) => GrokAcpClient;
  emitEvent?: ProxyEventSink;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function isStructuredNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; data?: unknown };
  if (value.status === 404 || value.code === 404 || value.code === -32001) return true;
  if (value.data && typeof value.data === 'object') {
    const data = value.data as { code?: unknown; domainCode?: unknown; error?: unknown };
    return data.code === 'SESSION_NOT_FOUND'
      || data.code === 'NATIVE_SESSION_NOT_FOUND'
      || data.code === 'not_found'
      || data.domainCode === 'NATIVE_SESSION_NOT_FOUND'
      || data.error === 'not_found';
  }
  return false;
}

async function nativeSessionListed(runtime: GrokAcpClient, nativeSessionId: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await runtime.listSessions({
      ...(cursor ? { cursor } : {}),
    }) as { sessions?: Array<{ sessionId?: string }>; nextCursor?: string | null };
    if ((listed.sessions ?? []).some((item) => item.sessionId === nativeSessionId)) return true;
    if (!listed.nextCursor) return false;
    cursor = listed.nextCursor;
  }
  return false;
}

function mapRuntimeError(error: unknown, binaryPath: string): GrokProxyError {
  const message = error instanceof Error ? error.message : String(error);
  const auth = /auth|login|unauthorized|401/i.test(message);
  return createAppError(
    auth ? 401 : 502,
    auth ? 'AUTH_REQUIRED' : 'RUNTIME_ERROR',
    auth
      ? `Grok requires authentication. In the Gian Workbench Terminal run \`grok login\`, then retry. (${binaryPath})`
      : message,
  );
}

export class GrokProxyService {
  private readonly binaryPath: string;
  private readonly createRuntime: (cwd: string) => GrokAcpClient;
  private emitEvent: ProxyEventSink;
  private runtime: GrokAcpClient | null = null;
  private runtimeCwd: string | null = null;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly proxyIdByNativeId = new Map<string, string>();
  private readonly unclaimedUpdates = new Map<string, SessionNotification[]>();
  private readonly replayCollectors = new Map<string, SessionNotification[]>();
  private modelState: GrokModelState = {};
  private permissionMode: GrokPermissionMode = 'default';
  private currentModel: string | null = null;
  private currentEffort: string | null = null;
  private slashCommands: AvailableCommand[] = [];
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private promptGeneration = 0;
  private forkSupported = false;

  constructor(options: ServiceOptions) {
    this.binaryPath = options.binaryPath;
    this.createRuntime = options.createRuntime ?? ((cwd) => new GrokAcpClient({
      binaryPath: options.binaryPath,
      cwd,
    }));
    this.emitEvent = options.emitEvent ?? (() => undefined);
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  async listCapabilities() {
    const aux = this.createRuntime(resolve(tmpdir()));
    try {
      const initialized = await aux.ensureStarted();
      this.forkSupported = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
      const meta = (initialized as { _meta?: Record<string, unknown> })._meta ?? {};
      this.modelState = modelStateFromUnknown(meta.modelState);
      this.slashCommands = commandsFromUnknown(meta.availableCommands) as AvailableCommand[];
      const catalog = catalogFromModelState(this.modelState, this.permissionMode);
      return {
        ...initialized,
        ...catalog,
        slashCommands: this.slashCommands,
      };
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop();
    }
  }

  supportsFork(): boolean {
    return this.forkSupported
      || this.runtime?.negotiated?.agentCapabilities?.sessionCapabilities?.fork != null;
  }

  async listNativeSessions(params: ListNativeSessionsParams) {
    const cwd = params.cwd ? resolve(params.cwd) : resolve(tmpdir());
    const aux = this.createRuntime(cwd);
    try {
      await aux.ensureStarted();
      return await aux.listSessions({
        cwd,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
    } catch (error) {
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop();
    }
  }

  async createSession(input: CreateSessionParams) {
    if (this.sessionsById.size > 0 && input.allowAdditional !== true) {
      throw createAppError(409, 'NATIVE_SESSION_ATTACHED', 'This Grok Proxy already has an attached session.');
    }
    if (Array.isArray(input.mcpServers) && input.mcpServers.length > 0) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Grok MCP servers are not supported.');
    }
    const cwd = resolve(nonEmptyString(input.cwd, 'cwd'));
    const runtime = await this.ensureRuntime(cwd);
    const importHistory = Boolean(input.nativeSessionId?.trim()) && input.resumeMode !== 'resume';
    const nativeId = input.nativeSessionId?.trim() || null;
    if (importHistory && nativeId) this.replayCollectors.set(nativeId, []);
    try {
      const initialized = runtime.negotiated;
      const meta = (initialized as { _meta?: Record<string, unknown> } | null)?._meta ?? {};
      if (this.modelState.availableModels == null) {
        this.modelState = modelStateFromUnknown(meta.modelState);
      }
      this.slashCommands = commandsFromUnknown(meta.availableCommands) as AvailableCommand[];
      const permission = grokPermissionSpec(this.permissionMode);
      const response = nativeId
        ? input.resumeMode === 'resume'
          ? await runtime.resumeSession({ sessionId: nativeId, cwd, mcpServers: [] })
          : await runtime.loadSession({ sessionId: nativeId, cwd, mcpServers: [] })
        : await runtime.newSession({
          cwd,
          mcpServers: [],
          _meta: {
            mode: 'agent',
            ...permission.createMeta,
          },
        } as never);
      const sessionId = typeof (response as { sessionId?: unknown }).sessionId === 'string'
        ? (response as { sessionId: string }).sessionId
        : nativeId;
      if (!sessionId) throw createAppError(502, 'RUNTIME_ERROR', 'Grok did not return a session id.');
      if (this.proxyIdByNativeId.has(sessionId)) {
        throw createAppError(409, 'NATIVE_SESSION_ATTACHED', `Native Grok session ${sessionId} is already attached.`);
      }
      const session: SessionRecord = {
        id: randomId('sess'),
        cwd,
        nativeSessionId: sessionId,
        status: 'idle',
        activeTurnId: null,
        configOptions: [],
        slashCommands: this.slashCommands,
        mcpServers: [],
        attached: true,
        lastError: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.sessionsById.set(session.id, session);
      this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
      this.currentModel = this.modelState.currentModelId ?? this.currentModel;
      const replayUpdates = this.replayCollectors.get(session.nativeSessionId)
        ?? this.unclaimedUpdates.get(session.nativeSessionId)
        ?? [];
      this.replayCollectors.delete(session.nativeSessionId);
      this.unclaimedUpdates.delete(session.nativeSessionId);
      if (!importHistory) {
        for (const notification of replayUpdates) this.handleSessionUpdate(notification);
      }
      return {
        session: this.serializeSession(session),
        replayUpdates: importHistory ? replayUpdates : [],
      };
    } catch (error) {
      if (nativeId) this.replayCollectors.delete(nativeId);
      if (this.sessionsById.size === 0) await this.stopRuntime();
      throw mapRuntimeError(error, this.binaryPath);
    }
  }

  async forkSession(params: { sessionId: string }) {
    const source = this.requireSession(params.sessionId);
    if (source.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before forking the session.');
    }
    if (!this.supportsFork()) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Grok ACP does not advertise session/fork.');
    }
    const response = await this.requireRuntime().forkSession({
      sessionId: source.nativeSessionId,
      cwd: source.cwd,
      mcpServers: source.mcpServers,
    });
    const createdAt = nowIso();
    const session: SessionRecord = {
      ...source,
      id: randomId('sess'),
      nativeSessionId: response.sessionId,
      configOptions: response.configOptions ?? source.configOptions,
      slashCommands: [...source.slashCommands],
      activeTurnId: null,
      status: 'idle',
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.sessionsById.set(session.id, session);
    this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
    return { session: this.serializeSession(session) };
  }

  async listSlashCommands() {
    return { commands: [...this.slashCommands] };
  }

  currentCatalog() {
    const catalog = catalogFromModelState(this.modelState, this.permissionMode);
    return {
      ...catalog,
      sessionOptions: catalog.sessionOptions.map(option => {
        if (option.id === 'model') {
          return { ...option, currentValue: this.currentModel ?? option.currentValue };
        }
        if (option.id === 'reasoning_effort') {
          return { ...option, currentValue: this.currentEffort ?? option.currentValue };
        }
        if (option.id === 'permission_mode') {
          return { ...option, currentValue: this.permissionMode };
        }
        return option;
      }),
    };
  }

  async startTurn(params: StartTurnParams) {
    const prepared = this.prepareTurn(params);
    await this.runPreparedTurn(prepared);
    return { session: this.serializeSession(prepared.session), turn: { id: prepared.turnId } };
  }

  async beginTurn(params: StartTurnParams) {
    const prepared = this.prepareTurn(params);
    void this.runPreparedTurn(prepared).catch(() => undefined);
    return { turn: { id: prepared.turnId } };
  }

  private prepareTurn(params: StartTurnParams) {
    const session = this.requireSession(params.sessionId);
    this.requireRuntime();
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }
    const input = normalizeInputItems(params.input, session.cwd);
    const command = firstSlashToken(firstText(input));
    if (command && isBlockedSlashCommand(command)) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', `Grok command ${command} is not available in Gian.`);
    }
    const turnId = randomId('turn');
    session.activeTurnId = turnId;
    session.status = 'running';
    const generation = ++this.promptGeneration;
    this.activeTurns.set(session.id, { turnId, completed: false, generation });
    this.emitEvent('turn.started', this.envelope(session, { turnId, status: 'running' }, turnId));
    return { session, turnId, input, generation };
  }

  private async runPreparedTurn(prepared: {
    session: SessionRecord;
    turnId: string;
    input: ReturnType<typeof normalizeInputItems>;
    generation: number;
  }) {
    const runtime = this.requireRuntime();
    try {
      const response = await runtime.prompt({
        sessionId: prepared.session.nativeSessionId,
        prompt: await toPromptBlocks(prepared.input),
        _meta: { mode: 'agent' },
      } as never);
      if (this.activeTurns.get(prepared.session.id)?.generation === prepared.generation) {
        this.emitPromptUsage(prepared.session, prepared.turnId, response);
        this.completeTurn(prepared.session, prepared.turnId, this.promptStopReason(response));
      }
    } catch (error) {
      if (this.activeTurns.get(prepared.session.id)?.generation === prepared.generation) {
        this.failTurn(prepared.session, prepared.turnId, error);
      }
      throw mapRuntimeError(error, this.binaryPath);
    }
  }

  private promptStopReason(response: PromptResponse): string {
    return typeof response.stopReason === 'string' && response.stopReason.length > 0
      ? response.stopReason
      : 'completed';
  }

  async steerTurn(params: { sessionId: string; input: unknown }) {
    const session = this.requireSession(params.sessionId);
    const runtime = this.requireRuntime();
    if (!session.activeTurnId) {
      throw createAppError(404, 'TURN_NOT_FOUND', 'No active Grok turn to steer.');
    }
    const input = normalizeInputItems(params.input, session.cwd);
    const command = firstSlashToken(firstText(input));
    if (command && isBlockedSlashCommand(command)) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', `Grok command ${command} is not available in Gian.`);
    }
    await runtime.interject({
      sessionId: session.nativeSessionId,
      text: firstText(input),
      interjectionId: randomId('interject'),
    });
    return { ok: true as const, turnId: session.activeTurnId };
  }

  async interruptTurn(params: InterruptTurnParams) {
    const session = this.requireSession(params.sessionId);
    if (!session.activeTurnId) return;
    await this.requireRuntime().cancel(session.nativeSessionId);
  }

  async respondApproval(params: ApprovalResponseParams) {
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval) throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    const optionId = params.nativeOptionId;
    if (!optionId || !approval.options.some(option => option.optionId === optionId)) {
      throw createAppError(400, 'INVALID_APPROVAL_OPTION', 'Unknown native approval option.');
    }
    approval.resolve({ outcome: { outcome: 'selected', optionId } });
    this.approvalsById.delete(params.approvalId);
    return { ok: true };
  }

  async setConfigOption(params: SetConfigOptionParams) {
    const session = this.requireSession(params.sessionId);
    const runtime = this.requireRuntime();
    if (params.configId === 'model') {
      const modelId = String(params.value);
      if (!this.modelState.availableModels?.some(model => model.modelId === modelId)) {
        throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok model ${modelId}.`);
      }
      await runtime.setSessionModel({ sessionId: session.nativeSessionId, modelId });
      this.currentModel = modelId;
      this.modelState = { ...this.modelState, currentModelId: modelId };
    } else if (params.configId === 'reasoning_effort') {
      const effort = String(params.value);
      const modelId = this.currentModel ?? this.modelState.currentModelId;
      if (!modelId) throw createAppError(400, 'INVALID_REQUEST', 'No Grok model is selected.');
      if (!effortIdsForModel(this.modelState, modelId).includes(effort)) {
        throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok reasoning effort ${effort}.`);
      }
      await runtime.setSessionModel({
        sessionId: session.nativeSessionId,
        modelId,
        _meta: { reasoningEffort: effort },
      });
      this.currentEffort = effort;
    } else if (params.configId === 'permission_mode') {
      const mode = parseGrokPermissionMode(String(params.value));
      if (!mode) throw createAppError(400, 'INVALID_REQUEST', 'Unknown Grok permission mode.');
      const spec = grokPermissionSpec(mode);
      await runtime.notifyPermissionMode({
        sessionId: session.nativeSessionId,
        clientIdentifier: 'gian-grok-proxy',
        ...spec.runtime,
      });
      this.permissionMode = mode;
    } else {
      throw createAppError(400, 'INVALID_REQUEST', `Unknown Grok config ${params.configId}.`);
    }
    session.updatedAt = nowIso();
    return { session: this.serializeSession(session) };
  }

  async renameSession(params: { sessionId: string; name: string }) {
    const session = this.requireSession(params.sessionId);
    try {
      await this.requireRuntime().renameSession(session.nativeSessionId, params.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/method not found/i.test(message)) throw mapRuntimeError(error, this.binaryPath);
    }
    return { ok: true as const };
  }

  async deleteNativeSession(nativeSessionId: string) {
    if (this.proxyIdByNativeId.has(nativeSessionId)) {
      throw createAppError(409, 'CONFLICT', 'Cannot delete an attached Grok session.');
    }
    const aux = this.createRuntime(this.sessionsById.values().next().value?.cwd ?? resolve(tmpdir()));
    try {
      await aux.ensureStarted();
      if (!await nativeSessionListed(aux, nativeSessionId)) {
        throw createAppError(404, 'NATIVE_SESSION_NOT_FOUND', `Grok native session ${nativeSessionId} was not found.`);
      }
      await aux.deleteSession(nativeSessionId);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GrokProxyError) throw error;
      if (isStructuredNotFound(error)) {
        throw createAppError(404, 'NATIVE_SESSION_NOT_FOUND', `Grok native session ${nativeSessionId} was not found.`);
      }
      throw mapRuntimeError(error, this.binaryPath);
    } finally {
      await aux.stop();
    }
  }

  getSession(params: GetSessionParams) {
    return { session: this.serializeSession(this.requireSession(params.sessionId)) };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSession(params.sessionId);
    try {
      if (this.runtime) {
        await this.runtime.cancel(session.nativeSessionId).catch(() => undefined);
        await this.runtime.closeSession({ sessionId: session.nativeSessionId }).catch(() => undefined);
      }
    } finally {
      this.sessionsById.delete(session.id);
      this.proxyIdByNativeId.delete(session.nativeSessionId);
      this.activeTurns.delete(session.id);
      for (const [approvalId, approval] of this.approvalsById) {
        if (approval.sessionId === session.id) this.approvalsById.delete(approvalId);
      }
      if (this.sessionsById.size === 0) await this.stopRuntime();
    }
  }

  async close() {
    for (const session of [...this.sessionsById.values()]) {
      await this.closeSession({ sessionId: session.id });
    }
    await this.stopRuntime();
  }

  setPermissionMode(mode: GrokPermissionMode) {
    this.permissionMode = mode;
  }

  private async ensureRuntime(cwd: string): Promise<GrokAcpClient> {
    if (this.runtime) {
      if (this.runtimeCwd !== cwd) {
        throw createAppError(409, 'NATIVE_SESSION_ATTACHED', 'Forked Grok sessions must share the parent cwd.');
      }
      return this.runtime;
    }
    const runtime = this.createRuntime(cwd);
    runtime.setPermissionHandler(request => this.handlePermissionRequest(request));
    runtime.on('extensionNotification', (method, params) => {
      const nativeSessionId = params && typeof params === 'object'
        ? String((params as Record<string, unknown>).sessionId ?? '')
        : '';
      const direct = nativeSessionId
        ? this.sessionsById.get(this.proxyIdByNativeId.get(nativeSessionId) ?? '')
        : undefined;
      const active = direct ?? [...this.sessionsById.values()].filter(session => session.activeTurnId).at(0);
      if (active) this.emitEvent('extension.notification', this.envelope(active, { method, params }));
    });
    runtime.on('sessionUpdate', notification => this.handleSessionUpdate(notification));
    runtime.on('runtimeStopped', (event) => {
      if (event.expected) return;
      for (const session of this.sessionsById.values()) {
        session.status = 'stale';
        session.lastError = 'Grok runtime stopped.';
        this.emitEvent('session.updated', this.envelope(session, { status: 'stale' }));
      }
    });
    try {
      const initialized = await runtime.ensureStarted();
      this.runtime = runtime;
      this.runtimeCwd = cwd;
      this.forkSupported = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeCwd = null;
    if (runtime) await runtime.stop();
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    return session;
  }

  private requireRuntime(): GrokAcpClient {
    if (!this.runtime) throw createAppError(503, 'RUNTIME_UNAVAILABLE', 'Grok runtime is not started.');
    return this.runtime;
  }

  private serializeSession(session: SessionRecord) {
    return {
      ...session,
      model: this.currentModel,
      mode: this.permissionMode,
      effort: this.currentEffort,
    };
  }

  private envelope(session: SessionRecord, data: Record<string, unknown>, turnId?: string) {
    return {
      sessionId: session.id,
      nativeSessionId: session.nativeSessionId,
      ...(turnId ? { turnId } : {}),
      data,
    };
  }

  private completeTurn(session: SessionRecord, turnId: string, stopReason: string) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    session.activeTurnId = null;
    session.status = 'idle';
    this.emitEvent('turn.completed', this.envelope(session, { stopReason }, turnId));
  }

  private failTurn(session: SessionRecord, turnId: string, error: unknown) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    session.activeTurnId = null;
    session.status = 'error';
    session.lastError = error instanceof Error ? error.message : String(error);
    this.emitEvent('turn.failed', this.envelope(session, {
      code: /auth|login/i.test(session.lastError) ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_ERROR',
      message: session.lastError,
    }, turnId));
  }

  private emitPromptUsage(session: SessionRecord, turnId: string, response: PromptResponse) {
    const meta = (response as { _meta?: unknown })._meta;
    const usage = parsePromptUsage(meta);
    if (!usage) return;
    this.emitEvent('usage.updated', this.envelope(session, {
      conversation: {
        mode: 'delta',
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      },
      ...(usage.totalTokens !== undefined ? { context: { used: usage.totalTokens } } : {}),
    }, turnId));
  }

  private handleSessionUpdate(notification: SessionNotification) {
    const collecting = this.replayCollectors.get(notification.sessionId);
    if (collecting) {
      collecting.push(notification);
      return;
    }
    const proxySessionId = this.proxyIdByNativeId.get(notification.sessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) {
      const pending = this.unclaimedUpdates.get(notification.sessionId) ?? [];
      pending.push(notification);
      this.unclaimedUpdates.set(notification.sessionId, pending.slice(-200));
      return;
    }
    const update = notification.update as { sessionUpdate?: string } & Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? '');
    const sessionScoped = kind === 'available_commands_update'
      || kind === 'current_mode_update'
      || kind === 'current_model_update'
      || kind === 'config_update'
      || kind === 'usage_update';
    if (!sessionScoped && !session.activeTurnId) return;
    if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.slashCommands = update.availableCommands as AvailableCommand[];
      session.slashCommands = this.slashCommands;
      this.emitEvent('slash.updated', this.envelope(session, { commands: this.slashCommands }));
    }
    if (
      update.sessionUpdate === 'current_mode_update'
      && parseGrokPermissionMode(String(update.currentModeId ?? ''))
    ) {
      this.permissionMode = parseGrokPermissionMode(String(update.currentModeId))!;
      this.emitEvent('session.updated', this.envelope(session, { mode: this.permissionMode }));
    }
    if (update.sessionUpdate === 'current_model_update' && typeof update.currentModelId === 'string') {
      this.currentModel = update.currentModelId;
      this.modelState = { ...this.modelState, currentModelId: update.currentModelId };
      this.emitEvent('session.updated', this.envelope(session, { model: update.currentModelId }));
    }
    if (update.sessionUpdate === 'usage_update') {
      this.emitEvent('usage.updated', this.envelope(session, {
        context: {
          used: update.used,
          window: update.size,
        },
      }, session.activeTurnId ?? undefined));
    }
    this.emitEvent('session.update', this.envelope(session, { update }, session.activeTurnId ?? undefined));
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const proxySessionId = this.proxyIdByNativeId.get(request.sessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) return { outcome: { outcome: 'cancelled' } };
    const approvalId = randomId('appr');
    const turnId = session.activeTurnId;
    const response = await new Promise<RequestPermissionResponse>((resolve) => {
      this.approvalsById.set(approvalId, {
        approvalId,
        sessionId: session.id,
        turnId,
        options: request.options,
        resolve,
      });
      this.emitEvent('approval.requested', this.envelope(session, {
        approvalId,
        title: request.toolCall.title ?? request.toolCall.kind ?? 'Permission',
        options: request.options,
        payload: request.toolCall,
      }, turnId ?? undefined));
    });
    this.emitEvent('approval.resolved', this.envelope(session, {
      approvalId,
      optionId: 'outcome' in response.outcome && response.outcome.outcome === 'selected'
        ? response.outcome.optionId
        : null,
    }, turnId ?? undefined));
    return response;
  }
}
