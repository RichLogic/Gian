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
  admitHostStreamableHttpServices,
  McpAdmissionError,
  mcpSpawnDenyRules,
  scanDiskConfiguredMcpServers,
  unexpectedMcpServerNames,
  type AdmittedHostMcp,
} from './mcp-isolation.js';
import {
  grokPermissionSpec,
  parseGrokPermissionMode,
  type GrokPermissionMode,
} from './permissions.js';
import { firstSlashToken, isBlockedSlashCommand } from './slash-policy.js';
import type { GrokCustomizationRuntimeAccess } from './customization.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  ListNativeSessionsParams,
  PendingApproval,
  PendingQuestion,
  QuestionOutcome,
  SessionRecord,
  SetConfigOptionParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import {
  GrokAcpClient,
  GrokExtMethodUnsupportedError,
  isMethodNotFound,
} from '../runtime/grok-acp-client.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

interface ActiveTurn {
  turnId: string;
  completed: boolean;
  generation: number;
}

export interface ServiceOptions {
  binaryPath: string;
  createRuntime?: (cwd: string, spawn: { spawnDenyRules: readonly string[] }) => GrokAcpClient;
  emitEvent?: ProxyEventSink;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
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
  if (error instanceof GrokProxyError) return error;
  if (error instanceof GrokExtMethodUnsupportedError) {
    return createAppError(400, 'CAPABILITY_NOT_SUPPORTED', error.message);
  }
  if (error instanceof McpAdmissionError) {
    return createAppError(400, 'INVALID_REQUEST', error.message);
  }
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

/** Feature-detect newer GrokAcpClient surface so minimal runtime doubles keep working. */
function runtimeExtensionSupport(runtime: GrokAcpClient | null): { supports(method: string): boolean } | null {
  const candidate = runtime as { extensions?: { supports(method: string): boolean } } | null;
  return candidate?.extensions ?? null;
}

export class GrokProxyService {
  private readonly binaryPath: string;
  private readonly createRuntime: (cwd: string, spawn: { spawnDenyRules: readonly string[] }) => GrokAcpClient;
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
  private readonly questionsById = new Map<string, PendingQuestion>();
  /** Bounded record of settled question responses for idempotent replays. */
  private readonly settledQuestionResponses = new Map<string, {
    actionId: string;
    values: Record<string, unknown>;
  }>();
  private promptGeneration = 0;
  private forkSupported = false;
  /** Remembered x.ai/session/fork support from the last runtime initialize. */
  private nativeForkSupported = false;
  /** Host-approved MCP servers admitted before the runtime spawns. */
  private admittedHostMcp: AdmittedHostMcp | null = null;

  constructor(options: ServiceOptions) {
    this.binaryPath = options.binaryPath;
    this.createRuntime = options.createRuntime
      ?? ((cwd, spawn) => new GrokAcpClient({
        binaryPath: options.binaryPath,
        cwd,
        spawnDenyRules: spawn.spawnDenyRules,
      }));
    this.emitEvent = options.emitEvent ?? (() => undefined);
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  async listCapabilities() {
    const aux = this.createRuntime(resolve(tmpdir()), { spawnDenyRules: ['MCPTool(*)'] });
    try {
      const initialized = await aux.ensureStarted();
      this.forkSupported = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
      const auxExtensions = runtimeExtensionSupport(aux);
      this.nativeForkSupported = auxExtensions?.supports('x.ai/session/fork') === true;
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
    // Native x.ai/session/fork is preferred; the standard ACP fork capability
    // remains a fallback for runtimes that advertise it.
    const extensions = runtimeExtensionSupport(this.runtime);
    if (extensions?.supports('x.ai/session/fork') === true) return true;
    return this.forkSupported
      || this.runtime?.negotiated?.agentCapabilities?.sessionCapabilities?.fork != null;
  }

  /** Whether exact-turn forks (targetPromptIndex) are available natively. */
  supportsAtTurnFork(): boolean {
    const extensions = runtimeExtensionSupport(this.runtime);
    if (extensions) return extensions.supports('x.ai/session/fork') === true;
    return this.nativeForkSupported;
  }

  /**
   * Admit Host Streamable HTTP MCP services before the runtime spawns. The
   * admitted list also selects the spawn-time MCP deny rules (see
   * mcp-isolation.ts), so it is immutable once the runtime has started.
   */
  setHostMcpServices(hostServices: unknown): void {
    if (this.runtime) {
      throw createAppError(
        409,
        'CONFLICT',
        'Host MCP services must be provided before the Grok runtime starts; the MCP isolation boundary is fixed at spawn.',
      );
    }
    if (hostServices === undefined || hostServices === null) {
      this.admittedHostMcp = null;
      return;
    }
    this.admittedHostMcp = admitHostStreamableHttpServices(hostServices);
  }

  get hostMcpServerNames(): readonly string[] {
    return this.admittedHostMcp?.names ?? [];
  }

  get hostMcpServers(): Array<Record<string, unknown>> {
    return this.admittedHostMcp?.servers ?? [];
  }

  async listNativeSessions(params: ListNativeSessionsParams) {
    const cwd = params.cwd ? resolve(params.cwd) : resolve(tmpdir());
    const aux = this.createRuntime(cwd, { spawnDenyRules: ['MCPTool(*)'] });
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
    const cwd = resolve(nonEmptyString(input.cwd, 'cwd'));
    if (input.mcpServers && input.mcpServers.length > 0 && !this.admittedHostMcp) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Only admitted Host Streamable HTTP MCP servers are supported.');
    }
    const diskDiagnostics = this.runtime ? [] : (await scanDiskConfiguredMcpServers(cwd)).diagnostics;
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
      const hostMcp = this.hostMcpServers as never[];
      const response = nativeId
        ? input.resumeMode === 'resume'
          ? await runtime.resumeSession({ sessionId: nativeId, cwd, mcpServers: hostMcp })
          : await runtime.loadSession({ sessionId: nativeId, cwd, mcpServers: hostMcp })
        : await runtime.newSession({
          cwd,
          mcpServers: hostMcp,
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
        mcpServers: [...hostMcp] as SessionRecord['mcpServers'],
        attached: true,
        lastError: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.sessionsById.set(session.id, session);
      this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
      this.currentModel = this.modelState.currentModelId ?? this.currentModel;
      if (this.admittedHostMcp) {
        void this.verifyMcpBoundary(session, diskDiagnostics);
      }
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

  /**
   * Fork a session. Prefers the native `x.ai/session/fork` (supports
   * `targetPromptIndex` for exact-turn forks); falls back to the standard ACP
   * fork when the runtime advertises it (head-only). The native fork copies
   * session files without starting them, so the forked native session is
   * attached through `resume` in the same runtime.
   */
  async forkSession(params: { sessionId: string; targetPromptIndex?: number }) {
    const source = this.requireSession(params.sessionId);
    if (source.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before forking the session.');
    }
    const runtime = this.requireRuntime();
    const runtimeExtensions = runtimeExtensionSupport(runtime);
    const useNative = runtimeExtensions?.supports('x.ai/session/fork') === true;
    if (!useNative && !this.supportsFork()) {
      throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', 'Grok ACP does not advertise session/fork.');
    }

    let forked: { sessionId: string; configOptions?: unknown };
    let parentChildIsolation = false;
    if (useNative) {
      const response = await runtime.nativeForkSession({
        sourceSessionId: source.nativeSessionId,
        sourceCwd: source.cwd,
        newCwd: source.cwd,
        ...(params.targetPromptIndex !== undefined
          ? { targetPromptIndex: params.targetPromptIndex }
          : {}),
      });
      // The fork exists on disk only; attach it in this runtime via resume so
      // parent and child remain separate native sessions with stable ids.
      const attached = await this.createSession({
        cwd: source.cwd,
        nativeSessionId: response.newSessionId,
        resumeMode: 'resume',
        mcpServers: [...source.mcpServers],
        allowAdditional: true,
      });
      forked = {
        sessionId: attached.session.nativeSessionId,
        configOptions: attached.session.configOptions,
      };
      parentChildIsolation = true;
    } else {
      const response = await runtime.forkSession({
        sessionId: source.nativeSessionId,
        cwd: source.cwd,
        mcpServers: source.mcpServers,
      });
      forked = { sessionId: response.sessionId, configOptions: response.configOptions };
    }
    const createdAt = nowIso();
    const session: SessionRecord = {
      ...source,
      id: randomId('sess'),
      nativeSessionId: forked.sessionId,
      configOptions: (forked.configOptions as SessionRecord['configOptions']) ?? source.configOptions,
      slashCommands: [...source.slashCommands],
      activeTurnId: null,
      status: 'idle',
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    if (parentChildIsolation) {
      // createSession already registered the resumed fork; reuse that record
      // so native-id mapping stays 1:1 and both rows never claim one id.
      const existingId = this.proxyIdByNativeId.get(session.nativeSessionId);
      if (existingId) {
        const existing = this.sessionsById.get(existingId)!;
        return { session: this.serializeSession(existing) };
      }
    }
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
    // Cancel pending structured questions first so the agent's blocked
    // reverse request settles before the cancel notification arrives.
    this.resolveQuestionsForSession(session.id);
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

  /**
   * Respond to a pending structured question (x.ai/ask_user_question),
   * plan-approval (x.ai/exit_plan_mode), or MCP elicit request mapped to a
   * Gian interaction. Repeated identical responses are idempotent; a repeated
   * responseId with a different payload is a conflict.
   */
  async respondQuestion(params: {
    questionId: string;
    responseId: string;
    actionId: string;
    values?: Record<string, unknown>;
  }) {
    const values = params.values ?? {};
    const replayKey = `${params.questionId}\u0000${params.responseId}`;
    const settled = this.settledQuestionResponses.get(replayKey);
    if (settled) {
      if (settled.actionId !== params.actionId
        || JSON.stringify(settled.values) !== JSON.stringify(values)) {
        throw createAppError(409, 'CONFLICT', 'responseId was reused with a different payload.');
      }
      return { ok: true as const };
    }
    const question = this.questionsById.get(params.questionId);
    if (!question) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Interaction not found.');
    }
    if (!question.actionIds.includes(params.actionId)) {
      throw createAppError(400, 'INVALID_APPROVAL_OPTION', 'Interaction action is not available.');
    }
    const previous = question.responses.get(params.responseId);
    if (previous) {
      if (previous.actionId !== params.actionId
        || JSON.stringify(previous.values) !== JSON.stringify(values)) {
        throw createAppError(409, 'CONFLICT', 'responseId was reused with a different payload.');
      }
      return { ok: true as const };
    }
    question.responses.set(params.responseId, { actionId: params.actionId, values });
    const outcome = this.questionOutcomeFromAction(question.kind, params.actionId, values);
    question.resolve(outcome);
    this.rememberSettledQuestion(replayKey, { actionId: params.actionId, values });
    this.questionsById.delete(params.questionId);
    const session = this.sessionsById.get(question.sessionId);
    if (session) {
      this.emitEvent('question.resolved', this.envelope(session, {
        questionId: params.questionId,
        actionId: params.actionId,
      }, question.turnId ?? undefined));
    }
    return { ok: true as const };
  }

  private rememberSettledQuestion(
    replayKey: string,
    record: { actionId: string; values: Record<string, unknown> },
  ): void {
    if (this.settledQuestionResponses.size >= 256) {
      const oldest = this.settledQuestionResponses.keys().next().value;
      if (oldest !== undefined) this.settledQuestionResponses.delete(oldest);
    }
    this.settledQuestionResponses.set(replayKey, record);
  }

  private questionOutcomeFromAction(
    kind: PendingQuestion['kind'],
    actionId: string,
    values: Record<string, unknown>,
  ): QuestionOutcome {
    if (actionId === 'cancel') return { kind: 'cancelled' };
    if (kind === 'plan') {
      if (actionId === 'submit' || actionId === 'approve') {
        return { kind: 'plan_approved' };
      }
      const feedback = typeof values.feedback === 'string' ? values.feedback : undefined;
      return {
        kind: 'plan_cancelled',
        ...(feedback !== undefined ? { feedback } : {}),
      };
    }
    if (kind === 'elicit') {
      if (actionId === 'submit') return { kind: 'elicit_accept', content: values.content ?? null };
      return { kind: 'elicit_decline' };
    }
    // ask_user_question
    if (actionId === 'submit') {
      const answers: Record<string, string[]> = {};
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') answers[key] = [value];
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
          answers[key] = value as string[];
        }
      }
      const notes = recordField(values, 'annotations');
      for (const [key, value] of Object.entries(notes)) {
        if (value && typeof value === 'object') {
          const annotation = value as Record<string, unknown>;
          annotations[key] = {
            ...(typeof annotation.preview === 'string' ? { preview: annotation.preview } : {}),
            ...(typeof annotation.notes === 'string' ? { notes: annotation.notes } : {}),
          };
        }
      }
      return { kind: 'submitted', answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) };
    }
    if (actionId === 'chat_about_this' || actionId === 'skip_interview') {
      const partial: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') partial[key] = value;
        else if (Array.isArray(value) && value.every(item => typeof item === 'string') && value.length > 0) {
          partial[key] = (value as string[])[0]!;
        }
      }
      return { kind: actionId, partialAnswers: partial };
    }
    return { kind: 'cancelled' };
  }

  /** Handle reverse x.ai/* requests from the agent. Never fabricates success. */
  private async handleRuntimeExtMethod(method: string, params: unknown): Promise<unknown> {
    const payload = params && typeof params === 'object'
      ? params as Record<string, unknown>
      : {};
    if (method === 'x.ai/ask_user_question') {
      return this.handleAskUserQuestion(payload);
    }
    if (method === 'x.ai/exit_plan_mode') {
      return this.handleExitPlanMode(payload);
    }
    if (method === 'x.ai/mcp/elicit') {
      return this.handleMcpElicit(payload);
    }
    throw new Error(`Method not found: ${method}`);
  }

  private async handleAskUserQuestion(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) return { outcome: 'cancelled' };
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'question',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.toolCallId === 'string' ? payload.toolCallId : questionId,
        mode: payload.mode === 'plan' ? 'plan' : 'default',
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        actionIds: ['submit', 'cancel', ...(payload.mode === 'plan' ? ['chat_about_this', 'skip_interview'] : [])],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
        questions: payload.questions ?? [],
        mode: payload.mode === 'plan' ? 'plan' : 'default',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) {
      // Resolved externally (turn end/cancel) — the map entry is cleaned by the resolver path.
      this.questionsById.delete(questionId);
    }
    switch (response.kind) {
      case 'submitted':
        return {
          outcome: 'accepted',
          answers: response.answers,
          ...(response.annotations ? { annotations: response.annotations } : {}),
        };
      case 'chat_about_this':
        return { outcome: 'chat_about_this', partial_answers: response.partialAnswers };
      case 'skip_interview':
        return { outcome: 'skip_interview', partial_answers: response.partialAnswers };
      default:
        return { outcome: 'cancelled' };
    }
  }

  private async handleExitPlanMode(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) return { outcome: 'cancelled', feedback: undefined };
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'plan',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.toolCallId === 'string' ? payload.toolCallId : questionId,
        mode: 'plan',
        questions: [],
        actionIds: ['approve', 'cancel'],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
        plan: typeof payload.planContent === 'string' ? payload.planContent : null,
        mode: 'plan',
        kind: 'exit_plan_mode',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) this.questionsById.delete(questionId);
    if (response.kind === 'plan_approved') return { outcome: 'approved' };
    return {
      outcome: 'cancelled',
      ...(response.kind === 'plan_cancelled' && response.feedback
        ? { feedback: response.feedback }
        : {}),
    };
  }

  private async handleMcpElicit(payload: Record<string, unknown>): Promise<unknown> {
    const nativeSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const proxySessionId = this.proxyIdByNativeId.get(nativeSessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : undefined;
    if (!session) return 'decline';
    const questionId = randomId('iq');
    const turnId = session.activeTurnId;
    const response = await new Promise<QuestionOutcome>((resolve) => {
      this.questionsById.set(questionId, {
        questionId,
        kind: 'elicit',
        sessionId: session.id,
        turnId,
        nativeRequestId: typeof payload.serverName === 'string' ? payload.serverName : questionId,
        mode: 'default',
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        actionIds: ['submit', 'decline', 'cancel'],
        responses: new Map(),
        resolve,
      });
      this.emitEvent('question.requested', this.envelope(session, {
        questionId,
        toolCallId: typeof payload.serverName === 'string' ? payload.serverName : null,
        requestedSchema: payload.requestedSchema ?? null,
        kind: 'mcp_elicit',
      }, turnId ?? undefined));
    });
    if (this.questionsById.has(questionId)) this.questionsById.delete(questionId);
    if (response.kind === 'elicit_accept') {
      return { accept: { content: response.content ?? {} } };
    }
    return 'decline';
  }

  /** Resolve every pending question for a session (turn end, cancel, close). */
  private resolveQuestionsForSession(sessionId: string, outcome: QuestionOutcome['kind'] = 'cancelled'): void {
    for (const [questionId, question] of [...this.questionsById]) {
      if (question.sessionId !== sessionId) continue;
      this.questionsById.delete(questionId);
      question.resolve({ kind: outcome } as QuestionOutcome);
      const session = this.sessionsById.get(question.sessionId);
      if (session) {
        this.emitEvent('question.resolved', this.envelope(session, {
          questionId,
          actionId: null,
        }, question.turnId ?? undefined));
      }
    }
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
    // Upstream enforces a 100-scalar title limit; reject early rather than
    // relying on the runtime's sanitized rejection.
    if ([...params.name].length > 100) {
      throw createAppError(400, 'INVALID_REQUEST', 'Grok session names are limited to 100 Unicode code points.');
    }
    try {
      await this.requireRuntime().renameSession(session.nativeSessionId, params.name, session.cwd);
    } catch (error) {
      if (isMethodNotFound(error)) {
        throw createAppError(
          400,
          'CAPABILITY_NOT_SUPPORTED',
          `Grok runtime does not support x.ai/session/rename: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw mapRuntimeError(error, this.binaryPath);
    }
    session.updatedAt = nowIso();
    return { ok: true as const };
  }

  async deleteNativeSession(nativeSessionId: string) {
    // Guard 1: never delete a native session this Proxy still has attached.
    if (this.proxyIdByNativeId.has(nativeSessionId)) {
      throw createAppError(409, 'CONFLICT', 'Cannot delete an attached Grok session.');
    }
    // Guard 2: ownership must be provable — the session has to appear in the
    // native directory listing before a destructive call is issued.
    const scopedCwd = this.sessionsById.values().next().value?.cwd ?? null;
    const aux = this.createRuntime(scopedCwd ?? resolve(tmpdir()), { spawnDenyRules: ['MCPTool(*)'] });
    try {
      await aux.ensureStarted();
      if (!await nativeSessionListed(aux, nativeSessionId)) {
        throw createAppError(404, 'NATIVE_SESSION_NOT_FOUND', `Grok native session ${nativeSessionId} was not found.`);
      }
      await aux.deleteSession(nativeSessionId, scopedCwd ?? undefined);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GrokProxyError) throw error;
      if (error instanceof GrokExtMethodUnsupportedError) {
        throw createAppError(400, 'CAPABILITY_NOT_SUPPORTED', error.message);
      }
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
      this.resolveQuestionsForSession(session.id);
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

  /** Runtime access for the read-only customization inspector. */
  customizationAccess(): GrokCustomizationRuntimeAccess {
    return {
      createAuxRuntime: (cwd: string) => this.createRuntime(cwd, { spawnDenyRules: ['MCPTool(*)'] }),
      attachedRuntime: () => {
        const session = this.sessionsById.values().next().value;
        if (!session || !this.runtime || this.runtimeCwd !== session.cwd) return null;
        return {
          runtime: this.runtime,
          nativeSessionId: session.nativeSessionId,
          cwd: session.cwd,
        };
      },
    };
  }

  private async ensureRuntime(cwd: string): Promise<GrokAcpClient> {
    if (this.runtime) {
      if (this.runtimeCwd !== cwd) {
        throw createAppError(409, 'NATIVE_SESSION_ATTACHED', 'Forked Grok sessions must share the parent cwd.');
      }
      return this.runtime;
    }
    // The MCP isolation boundary is fixed here: disk-configured server names
    // are enumerated once and denied per name when Host MCP is injected.
    const diskScan = await scanDiskConfiguredMcpServers(cwd);
    const denyRules = mcpSpawnDenyRules(this.admittedHostMcp, diskScan.names);
    const runtime = this.createRuntime(cwd, { spawnDenyRules: denyRules });
    runtime.setPermissionHandler(request => this.handlePermissionRequest(request));
    if (typeof (runtime as { setExtMethodHandler?: unknown }).setExtMethodHandler === 'function') {
      runtime.setExtMethodHandler((method, params) => this.handleRuntimeExtMethod(method, params));
    }
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
        this.resolveQuestionsForSession(session.id);
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

  /**
   * Runtime MCP isolation verification: compare the effective server catalog
   * (`x.ai/mcp/list`, a pure read that contacts nothing) against the approved
   * Host set. Unexpected servers are reported honestly; they were already
   * denied at spawn when their names came from disk config, so this catches
   * the residual (e.g. plugin-contributed) sources.
   */
  private async verifyMcpBoundary(session: SessionRecord, diskDiagnostics: readonly string[]): Promise<void> {
    try {
      const catalog = await this.runtime?.mcpList();
      const entries = catalog && typeof catalog === 'object'
        ? (catalog as { servers?: unknown }).servers
        : undefined;
      const effective = (Array.isArray(entries) ? entries : []).flatMap((raw) => {
        const entry = raw && typeof raw === 'object' ? (raw as { name?: unknown }) : {};
        return typeof entry.name === 'string' && entry.name ? [entry.name] : [];
      });
      const unexpected = unexpectedMcpServerNames(effective, this.admittedHostMcp?.names ?? []);
      if (unexpected.length === 0 && diskDiagnostics.length === 0) return;
      this.emitEvent('mcp.boundary', this.envelope(session, {
        approved: this.admittedHostMcp?.names ?? [],
        unexpected,
        ...(diskDiagnostics.length > 0 ? { diagnostics: diskDiagnostics } : {}),
      }));
    } catch {
      // Verification is best-effort; the spawn-time deny rules remain the
      // hard boundary. Absence of x.ai/mcp/list is reported via capabilities.
    }
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
    this.resolveQuestionsForSession(session.id);
    this.emitEvent('turn.completed', this.envelope(session, { stopReason }, turnId));
  }

  private failTurn(session: SessionRecord, turnId: string, error: unknown) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    session.activeTurnId = null;
    session.status = 'error';
    session.lastError = error instanceof Error ? error.message : String(error);
    this.resolveQuestionsForSession(session.id);
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
