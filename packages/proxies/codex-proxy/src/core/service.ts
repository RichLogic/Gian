import { resolve } from 'node:path';

import { buildCapabilitiesPayload } from './capabilities.js';
import { createAppError } from './errors.js';
import { isCodexNativeCommandName, listCodexSlashCommands } from './slash.js';
import { localFileDirectories, normalizeInputItems } from './input.js';
import type {
  ApprovalResponseParams,
  CapabilitiesPayload,
  CloseSessionParams,
  CommandExecutionSummary,
  CompletedTurnSummary,
  CreateSessionParams,
  FileChangeSummary,
  GetSessionParams,
  SetNameParams,
  InitializePayload,
  InputItem,
  PendingApproval,
  SessionRecord,
  SessionSnapshotParams,
  StartTurnParams,
  SteerTurnParams,
  ThinkingLevel,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import type { CodexRuntime, RuntimeNotification, RuntimeServerRequest } from '../runtime/types.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

const REQUEST_USER_INPUT_METHOD = 'item/tool/requestUserInput';
const MCP_SERVER_ELICITATION_METHOD = 'mcpServer/elicitation/request';

interface ActiveTurnContext {
  sessionId: string;
  requestId?: number | string;
  turnId: string;
  generation: number;
  outputText: string;
  isCompact: boolean;
}

interface PendingTurnContext {
  sessionId: string;
  requestId?: number | string;
  generation: number;
  notifications: RuntimeNotification[];
  serverRequests: RuntimeServerRequest[];
}

interface ContextCompactionUsageGuard {
  stage: 'running' | 'completed';
  manual: boolean;
}

interface ServiceOptions {
  runtime: CodexRuntime;
  emitEvent?: ProxyEventSink;
}

function normalizeThinking(value: unknown): ThinkingLevel | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function extractThreadId(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === 'string') {
    return record.threadId;
  }
  if (record.thread && typeof record.thread === 'object') {
    const thread = record.thread as Record<string, unknown>;
    if (typeof thread.id === 'string') {
      return thread.id;
    }
  }
  return null;
}

function extractTurnId(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.turnId === 'string') {
    return record.turnId;
  }
  if (record.turn && typeof record.turn === 'object') {
    const turn = record.turn as Record<string, unknown>;
    if (typeof turn.id === 'string') {
      return turn.id;
    }
  }
  return null;
}

function runtimeErrorWillRetry(params: unknown) {
  return Boolean(
    params
    && typeof params === 'object'
    && (params as Record<string, unknown>).willRetry === true,
  );
}

function inProgressTurnId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const turns = (snapshot as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!turn || typeof turn !== 'object') continue;
    const record = turn as { id?: unknown; status?: unknown };
    if (
      typeof record.id === 'string'
      && (record.status === 'inProgress' || record.status === 'running')
    ) {
      return record.id;
    }
  }
  return null;
}

function mcpElicitationMetadata(params: Record<string, unknown>) {
  const value = params._meta ?? params.meta;
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function mcpElicitationSupportsSession(params: Record<string, unknown>) {
  const persist = mcpElicitationMetadata(params).persist;
  return persist === 'session'
    || (Array.isArray(persist) && persist.includes('session'));
}

function approvalTitle(method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'Approve command execution';
    case 'item/fileChange/requestApproval':
      return 'Approve file change';
    case 'item/permissions/requestApproval':
      return 'Grant extra permissions';
    case REQUEST_USER_INPUT_METHOD:
      return 'Codex needs your input';
    case MCP_SERVER_ELICITATION_METHOD: {
      const connectorName = mcpElicitationMetadata(params).connector_name;
      return typeof connectorName === 'string' && connectorName.trim()
        ? `Allow ${connectorName.trim()}`
        : 'Review MCP request';
    }
    default:
      return 'Review Codex request';
  }
}

function approvalReason(method: string, params: Record<string, unknown>) {
  if (method === 'item/commandExecution/requestApproval') {
    return String(params.reason ?? params.command ?? 'Codex requested command approval.');
  }
  if (method === 'item/fileChange/requestApproval') {
    return String(params.reason ?? 'Codex requested file write approval.');
  }
  if (method === 'item/permissions/requestApproval') {
    return String(params.reason ?? 'Codex requested additional permissions.');
  }
  if (method === REQUEST_USER_INPUT_METHOD) {
    const questions = requestUserInputQuestions(params);
    return questions[0]?.question ?? 'Codex asked a question.';
  }
  if (method === MCP_SERVER_ELICITATION_METHOD) {
    return typeof params.message === 'string' && params.message.trim()
      ? params.message.trim()
      : 'An MCP server requested a user decision.';
  }
  return 'Codex requested a user decision.';
}

function approvalSeverity(method: string, params: Record<string, unknown>): 'low' | 'medium' | 'high' {
  // Codex's app-server doesn't tag approvals with severity yet. Default
  // everything to medium so the host always surfaces a card; the only
  // downgrade is permission requests that are *purely* network — those
  // are explicitly safe enough to skip the prompt when host mode allows it.
  if (method === 'item/permissions/requestApproval') {
    return classifyPermissionsKind(requestedPermissionsFromParams(params)) === 'network'
      ? 'low'
      : 'medium';
  }
  if (method === REQUEST_USER_INPUT_METHOD) return 'low';
  if (method === MCP_SERVER_ELICITATION_METHOD) {
    const riskLevel = mcpElicitationMetadata(params).riskLevel;
    if (riskLevel === 'low' || riskLevel === 'medium' || riskLevel === 'high') {
      return riskLevel;
    }
  }
  return 'medium';
}

interface RequestUserInputQuestion {
  id: string;
  question: string;
}

function requestUserInputQuestions(payload: unknown): RequestUserInputQuestion[] {
  if (!payload || typeof payload !== 'object') return [];
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const question = value as { id?: unknown; question?: unknown };
    if (typeof question.id !== 'string' || !question.id) return [];
    if (typeof question.question !== 'string' || !question.question) return [];
    return [{ id: question.id, question: question.question }];
  });
}

function requestUserInputResponse(
  payload: unknown,
  answers: Record<string, string | string[]> | undefined,
) {
  const byQuestionId = answers ?? {};
  const mapped: Record<string, { answers: string[] }> = {};
  for (const question of requestUserInputQuestions(payload)) {
    const answer = byQuestionId[question.id];
    if (typeof answer === 'string') {
      mapped[question.id] = { answers: [answer] };
    } else if (Array.isArray(answer)) {
      mapped[question.id] = { answers: answer };
    }
  }
  return { answers: mapped };
}

function cancelledServerRequestResponse(method: string) {
  if (method === REQUEST_USER_INPUT_METHOD) return { answers: {} };
  if (method === MCP_SERVER_ELICITATION_METHOD) return { action: 'cancel', content: null };
  return { decision: 'cancel' };
}

function classifyPermissionsKind(
  permissions: Record<string, unknown>,
): 'network' | 'file' | 'mixed' | 'other' {
  const keys = Object.keys(permissions);
  if (keys.length === 0) return 'other';
  const networkKeys = new Set(['web', 'network', 'internet']);
  const fileKeys = new Set(['fileWrite', 'file_write', 'workspaceWrite', 'workspace_write', 'fs', 'files']);
  let hasNetwork = false;
  let hasFile = false;
  for (const [key, value] of Object.entries(permissions)) {
    if (!isTruthyPermissionValue(value)) continue;
    if (networkKeys.has(key)) hasNetwork = true;
    else if (fileKeys.has(key)) hasFile = true;
    else return 'other';
  }
  if (hasNetwork && hasFile) return 'mixed';
  if (hasNetwork) return 'network';
  if (hasFile) return 'file';
  return 'other';
}

function isTruthyPermissionValue(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  }
  return value != null;
}

function requestedPermissionsFromParams(params: unknown) {
  if (!params || typeof params !== 'object') {
    return {};
  }
  const permissions = (params as Record<string, unknown>).permissions;
  return permissions && typeof permissions === 'object'
    ? permissions as Record<string, unknown>
    : {};
}

function currentTurnStatus(params: unknown) {
  if (!params || typeof params !== 'object') {
    return 'completed';
  }
  const record = params as Record<string, unknown>;
  if (record.turn && typeof record.turn === 'object' && typeof (record.turn as { status?: unknown }).status === 'string') {
    return (record.turn as { status: string }).status;
  }
  if (typeof record.status === 'string') {
    return record.status;
  }
  return 'completed';
}

function singleTextInput(input: InputItem[]): string | null {
  return input.length === 1 && input[0]?.type === 'text' ? input[0].text.trim() : null;
}

function firstSlashToken(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const first = text.split(/\s+/, 1)[0];
  return first ? first.toLowerCase() : null;
}

function isContextCompactionItem(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  const item = (params as { item?: unknown }).item;
  if (!item || typeof item !== 'object') return false;
  const type = (item as { type?: unknown }).type;
  return type === 'contextCompaction' || type === 'context_compaction';
}

const CONTENT_ONLY_ITEM_TYPES = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'contextCompaction',
]);

function codexItemLifecycle(
  params: unknown,
  phase: 'started' | 'completed',
): Record<string, unknown> | null {
  if (!params || typeof params !== 'object') return null;
  const envelope = params as Record<string, unknown>;
  const item = envelope.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.type !== 'string' || CONTENT_ONLY_ITEM_TYPES.has(record.type)) return null;

  const timestamp = phase === 'started' ? envelope.startedAtMs : envelope.completedAtMs;
  return {
    phase,
    item: record,
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? { nativeTimestampMs: timestamp }
      : {}),
  };
}

function codexNotice(method: string, params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  if (method === 'warning' || method === 'guardianWarning') {
    if (typeof record.message !== 'string' || !record.message) return null;
    return {
      code: method,
      title: method === 'guardianWarning' ? 'Guardian warning' : 'Codex warning',
      message: record.message,
      tone: 'warning',
    };
  }
  if (method === 'model/rerouted') {
    const fromModel = typeof record.fromModel === 'string' ? record.fromModel : 'requested model';
    const toModel = typeof record.toModel === 'string' ? record.toModel : 'fallback model';
    return {
      code: method,
      title: 'Model rerouted',
      message: `${fromModel} -> ${toModel}`,
      tone: 'info',
      details: record,
    };
  }
  return null;
}

interface CodexAgentUpdate {
  agentId: string;
  description: string;
  status: 'running' | 'done' | 'error';
  agentType?: string;
  model?: string;
  output?: string;
}

function codexAgentStatus(value: unknown, fallback: unknown): CodexAgentUpdate['status'] {
  switch (value) {
    case 'completed':
    case 'shutdown':
      return 'done';
    case 'errored':
    case 'interrupted':
    case 'notFound':
      return 'error';
    case 'pendingInit':
    case 'running':
      return 'running';
    default:
      return fallback === 'failed' ? 'error' : 'running';
  }
}

/** Project only Codex's native subagent ThreadItem variants. The proxy keeps
 * every executor-specific field it can; the host decides how to display it. */
function codexAgentUpdates(params: unknown): CodexAgentUpdate[] {
  if (!params || typeof params !== 'object') return [];
  const item = (params as { item?: unknown }).item;
  if (!item || typeof item !== 'object') return [];
  const record = item as Record<string, unknown>;

  if (record.type === 'subAgentActivity') {
    const agentId = typeof record.agentThreadId === 'string' ? record.agentThreadId : '';
    if (!agentId) return [];
    const path = typeof record.agentPath === 'string' ? record.agentPath : '';
    return [{
      agentId,
      description: path || 'Agent',
      status: record.kind === 'interrupted' ? 'error' : 'running',
      ...(path ? { agentType: path } : {}),
    }];
  }

  if (record.type !== 'collabAgentToolCall') return [];
  const states = record.agentsStates && typeof record.agentsStates === 'object'
    ? record.agentsStates as Record<string, unknown>
    : {};
  const receiverIds = Array.isArray(record.receiverThreadIds)
    ? record.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const agentIds = [...new Set([...receiverIds, ...Object.keys(states)])];
  if (agentIds.length === 0) return [];

  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  const model = typeof record.model === 'string' ? record.model : undefined;
  return agentIds.map(agentId => {
    const state = states[agentId] && typeof states[agentId] === 'object'
      ? states[agentId] as Record<string, unknown>
      : {};
    return {
      agentId,
      description: record.tool === 'spawnAgent' && prompt ? prompt : 'Agent',
      status: codexAgentStatus(state.status, record.status),
      ...(model ? { model } : {}),
      ...(typeof state.message === 'string' && state.message ? { output: state.message } : {}),
    };
  });
}

function codexPlanText(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const record = params as Record<string, unknown>;
  if (typeof record.plan === 'string') return record.plan;
  if (typeof record.text === 'string') return record.text;
  if (!Array.isArray(record.plan)) return '';

  const explanation = typeof record.explanation === 'string'
    ? record.explanation.trim()
    : '';
  const steps = record.plan.flatMap(step => {
    if (!step || typeof step !== 'object') return [];
    const item = step as Record<string, unknown>;
    const text = typeof item.step === 'string' ? item.step.trim() : '';
    if (!text) return [];
    const checked = item.status === 'completed' ? 'x' : ' ';
    const suffix = item.status === 'inProgress' ? ' (in progress)' : '';
    return [`- [${checked}] ${text}${suffix}`];
  });
  return [explanation, steps.join('\n')].filter(Boolean).join('\n\n');
}

export class CodexProxyService {
  private readonly runtime: CodexRuntime;
  private emitEvent: ProxyEventSink;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly sessionsByThreadId = new Map<string, SessionRecord>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly approvalsBySessionId = new Map<string, Map<string, PendingApproval>>();
  private readonly activeTurnsByThreadId = new Map<string, ActiveTurnContext>();
  private readonly pendingTurnsByThreadId = new Map<string, PendingTurnContext>();
  private nextTurnGeneration = 1;
  /** Compaction usage is untrustworthy until its replacement history is live. */
  private readonly contextCompactionUsageGuards = new Map<string, ContextCompactionUsageGuard>();

  constructor(options: ServiceOptions) {
    this.runtime = options.runtime;
    this.emitEvent = options.emitEvent ?? (() => undefined);
  }

  async initialize() {
    this.runtime.on('notification', (message) => {
      this.handleRuntimeNotification(message).catch((error) => {
        this.emitEvent('runtime.error', {
          code: 'NOTIFICATION_HANDLER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.runtime.on('serverRequest', (message) => {
      this.handleRuntimeServerRequest(message).catch((error) => {
        void this.runtime.respond(
          message.id,
          cancelledServerRequestResponse(message.method),
        ).catch(() => undefined);
        this.emitEvent('runtime.error', {
          code: 'SERVER_REQUEST_HANDLER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.runtime.on('runtimeStopped', () => {
      void this.handleRuntimeStopped();
    });
  }

  setEventSink(handler: ProxyEventSink) {
    this.emitEvent = handler;
  }

  async close() {
    await this.runtime.stop();
  }

  initializePayload(): InitializePayload {
    return {
      mode: 'spawn',
      protocolVersion: '0.1.0',
      methods: [
        'initialize',
        'capabilities.list',
        'slash.list',
        'session.create',
        'session.get',
        'session.setName',
        'turn.start',
        'turn.interrupt',
        'turn.steer',
        'approval.respond',
        'session.snapshot',
        'session.close',
        'shutdown',
      ],
    };
  }

  async listCapabilities(): Promise<CapabilitiesPayload> {
    return {
      ...buildCapabilitiesPayload(await this.runtime.listAllModels()),
      slashCommands: listCodexSlashCommands({ data: [] }),
    };
  }

  async listSlashCommands(cwd?: string): Promise<{ commands: import('@gian/shared').SlashCommand[] }> {
    try {
      const response = await this.runtime.listSkills(cwd);
      return { commands: listCodexSlashCommands(response) };
    } catch {
      // skills/list can fail before a thread exists or when codex is older;
      // still surface the built-ins instead of crashing the whole RPC.
      return { commands: listCodexSlashCommands({ data: [] }) };
    }
  }

  async listNativeThreads(cwd?: string) {
    return this.runtime.listNativeThreads?.(cwd) ?? null;
  }

  async createSession(input: CreateSessionParams) {
    const cwd = resolve(normalizeNonEmptyString(input.cwd, 'cwd'));
    const thinking = input.thinking === undefined ? null : normalizeThinking(input.thinking);
    if (input.thinking !== undefined && !thinking) {
      throw createAppError(400, 'INVALID_REQUEST', 'Unsupported thinking value.');
    }

    // Adoption path: caller passed an existing threadId. Resume that codex
    // thread instead of starting a fresh one. The on-disk rollout JSONL is
    // the source of truth — Gian's turns get appended to it by codex.
    let threadId: string;
    let configuredPermissions: SessionRecord['configuredPermissions'];
    const adoptThreadId = typeof input.threadId === 'string' && input.threadId.trim().length > 0
      ? input.threadId.trim()
      : null;
    if (adoptThreadId) {
      try {
        const resumed = await this.runtime.resumeThread(adoptThreadId);
        threadId = adoptThreadId;
        configuredPermissions = resumed.configuredPermissions;
      } catch (err) {
        throw createAppError(404, 'THREAD_NOT_FOUND', `Could not resume codex thread ${adoptThreadId}: ${String(err)}`);
      }
    } else {
      // Let Codex resolve config.toml here. We retain the effective policy so
      // the composer can restore it after an explicit permission preset.
      const thread = await this.runtime.startThread({
        cwd,
        model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
        ephemeral: input.ephemeral === true,
      });
      threadId = thread.thread.id;
      configuredPermissions = thread.configuredPermissions;
    }

    const createdAt = nowIso();
    const session: SessionRecord = {
      id: randomId('sess'),
      cwd,
      threadId,
      configuredPermissions,
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
      thinking,
      status: 'idle',
      activeTurnId: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };

    this.addSession(session);
    return { session: this.serializeSession(session) };
  }

  async forkSession(params: { sessionId: string; lastTurnId?: string }) {
    const source = await this.ensureSessionUsable(this.requireSessionById(params.sessionId));
    if (source.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before forking the session.');
    }
    const forked = await this.runtime.forkThread(source.threadId, {
      cwd: source.cwd,
      ...(params.lastTurnId ? { lastTurnId: params.lastTurnId } : {}),
    });
    const createdAt = nowIso();
    const session: SessionRecord = {
      id: randomId('sess'),
      cwd: source.cwd,
      threadId: forked.thread.id,
      configuredPermissions: forked.configuredPermissions,
      model: source.model,
      thinking: source.thinking,
      status: 'idle',
      activeTurnId: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.addSession(session);
    return { session: this.serializeSession(session) };
  }

  async archiveNativeThread(threadId: string): Promise<boolean> {
    if (!this.runtime.archiveThread) return false;
    await this.runtime.archiveThread(threadId);
    return false;
  }

  getSession(params: GetSessionParams) {
    const session = this.requireSessionById(params.sessionId);
    return { session: this.serializeSession(session) };
  }

  /**
   * SESSION-NAME-001: set the underlying codex thread's display name via the
   * app-server `thread/name/set` RPC so the Gian session name shows in
   * `codex resume` / Codex app listings. Empty/whitespace names are a no-op
   * (we never clear an existing thread name).
   */
  async setName(params: SetNameParams) {
    const session = this.requireSessionById(params.sessionId);
    const name = typeof params.name === 'string'
      // eslint-disable-next-line no-control-regex
      ? [...params.name.replace(/[\x00-\x1F\x7F]/g, ' ').trim()].slice(0, 200).join('')
      : '';
    if (!name) return { ok: true as const };
    if (!this.runtime.setThreadName) {
      throw createAppError(501, 'NOT_SUPPORTED', 'Runtime does not support thread/name/set.');
    }
    await this.runtime.setThreadName(session.threadId, name);
    return { ok: true as const };
  }

  async startTurn(params: StartTurnParams, requestId?: number | string) {
    const session = await this.ensureSessionUsable(this.requireSessionById(params.sessionId));
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }

    const localFileDirs = localFileDirectories(params.input, session.cwd);
    const input = normalizeInputItems(params.input, session.cwd);
    const text = singleTextInput(input);
    const nativeCommand = text ? firstSlashToken(text) : null;
    if (nativeCommand && isCodexNativeCommandName(nativeCommand)) {
      if (nativeCommand === '/compact') {
        return this.handleCompactIntercept(session, requestId);
      }
      if (nativeCommand === '/clear' || nativeCommand === '/new') {
        return this.handleClearIntercept(session, nativeCommand, requestId);
      }
    }

    const thinking = params.thinking === undefined ? session.thinking : normalizeThinking(params.thinking);
    if (params.thinking !== undefined && !thinking) {
      throw createAppError(400, 'INVALID_REQUEST', 'Unsupported thinking value.');
    }

    const configuredPermissions = params.useConfiguredPermissions
      ? session.configuredPermissions
      : null;
    const effectiveModel = typeof params.model === 'string' && params.model.trim()
      ? params.model.trim()
      : session.model;
    const effectiveThinking = thinking ?? session.thinking;
    if (params.collaborationMode && !effectiveModel) {
      throw createAppError(
        400,
        'INVALID_REQUEST',
        'Codex collaboration mode requires an effective model.',
      );
    }
    const runtimeWorkspaceRoots = [...new Set([
      session.cwd,
      ...(params.additionalWorkspaceRoots ?? []).map(root => resolve(session.cwd, root)),
      ...localFileDirs,
    ])];
    const generation = this.nextTurnGeneration++;
    const pending: PendingTurnContext = {
      sessionId: session.id,
      generation,
      notifications: [],
      serverRequests: [],
      ...(requestId === undefined ? {} : { requestId }),
    };
    this.pendingTurnsByThreadId.set(session.threadId, pending);
    let turnResponse: Awaited<ReturnType<CodexRuntime['startTurn']>>;
    try {
      turnResponse = await this.runtime.startTurn(session.threadId, input, {
        model: effectiveModel,
        thinking: effectiveThinking,
        sandbox: configuredPermissions ? null : params.sandbox ?? null,
        sandboxPolicy: configuredPermissions?.sandboxPolicy ?? null,
        runtimeWorkspaceRoots,
        permissions: configuredPermissions?.permissions ?? null,
        approvalPolicy: configuredPermissions?.approvalPolicy ?? params.approvalPolicy ?? null,
        approvalsReviewer: configuredPermissions?.approvalsReviewer ?? params.approvalsReviewer ?? null,
        collaborationMode: params.collaborationMode && effectiveModel
          ? {
              mode: params.collaborationMode,
              settings: {
                model: effectiveModel,
                reasoning_effort: effectiveThinking ?? null,
                developer_instructions: null,
              },
            }
          : null,
        reasoningSummary: params.reasoningSummary ?? null,
        serviceTier: params.serviceTier ?? null,
      });
    } catch (error) {
      if (this.pendingTurnsByThreadId.get(session.threadId)?.generation === generation) {
        this.pendingTurnsByThreadId.delete(session.threadId);
      }
      throw error;
    }
    // A non-compact turn's usage stream is the next authoritative context
    // sample. Keep suppressing compact traffic until startTurn succeeds.
    this.contextCompactionUsageGuards.delete(session.threadId);

    const turnId = turnResponse.turn.id;
    const updatedSession = this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      model: effectiveModel,
      thinking: effectiveThinking,
      lastError: null,
    });

    const context: ActiveTurnContext = {
      sessionId: updatedSession.id,
      turnId,
      generation,
      outputText: '',
      isCompact: false,
      ...(requestId === undefined ? {} : { requestId }),
    };
    this.activeTurnsByThreadId.set(updatedSession.threadId, context);

    this.emitEvent('turn.started', {
      requestId,
      sessionId: updatedSession.id,
      turnId,
      data: {
        turnId,
        status: turnResponse.turn.status,
      },
    });

    if (this.pendingTurnsByThreadId.get(updatedSession.threadId)?.generation === generation) {
      this.pendingTurnsByThreadId.delete(updatedSession.threadId);
    }
    for (const notification of pending.notifications) {
      await this.handleRuntimeNotification(notification);
    }
    for (const serverRequest of pending.serverRequests) {
      await this.handleRuntimeServerRequest(serverRequest);
    }

    return {
      session: this.serializeSession(updatedSession),
      turn: turnResponse.turn,
    };
  }

  async interruptTurn(params: { sessionId: string }) {
    const session = await this.ensureSessionUsable(this.requireSessionById(params.sessionId));
    const activeTurnId = session.activeTurnId
      ?? this.activeTurnsByThreadId.get(session.threadId)?.turnId
      ?? null;
    if (!activeTurnId) {
      throw createAppError(409, 'INVALID_REQUEST', 'This session does not have an active turn.');
    }

    await this.runtime.interruptTurn(session.threadId, activeTurnId);
    return { ok: true };
  }

  async steerTurn(params: SteerTurnParams) {
    const session = await this.ensureSessionUsable(this.requireSessionById(params.sessionId));
    if (!session.activeTurnId) {
      throw createAppError(409, 'NO_ACTIVE_TURN', 'Steering requires an active turn; send a normal message instead.');
    }
    if (!this.runtime.steerTurn) {
      throw createAppError(400, 'UNSUPPORTED', 'This runtime does not support steering.');
    }

    const input = normalizeInputItems(params.input, session.cwd);
    const result = await this.runtime.steerTurn(session.threadId, session.activeTurnId, input);
    return { ok: true, turnId: result.turnId };
  }

  async respondApproval(params: ApprovalResponseParams) {
    const session = this.requireSessionById(params.sessionId);
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval || approval.sessionId !== session.id) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    }

    const scope = params.scope === 'session' ? 'session' : 'once';
    const accepted = params.decision !== 'decline';
    if (approval.method === REQUEST_USER_INPUT_METHOD) {
      await this.runtime.respond(
        approval.rpcRequestId,
        requestUserInputResponse(
          approval.payload,
          params.decision === 'decline' ? undefined : params.answers,
        ),
      );
    } else if (approval.method === 'item/commandExecution/requestApproval') {
      await this.runtime.respond(approval.rpcRequestId, {
        decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (approval.method === 'item/fileChange/requestApproval') {
      await this.runtime.respond(approval.rpcRequestId, {
        decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (approval.method === 'item/permissions/requestApproval') {
      const permissions = requestedPermissionsFromParams(approval.payload);
      await this.runtime.respond(approval.rpcRequestId, {
        permissions: accepted ? permissions : {},
        scope: scope === 'session' ? 'session' : 'turn',
      });
    } else if (approval.method === MCP_SERVER_ELICITATION_METHOD) {
      await this.runtime.respond(approval.rpcRequestId, accepted
        ? {
          action: 'accept',
          content: {},
          ...(scope === 'session' ? { _meta: { persist: 'session' } } : {}),
        }
        : { action: 'decline', content: null });
    } else {
      await this.runtime.respond(approval.rpcRequestId, {
        decision: accepted ? 'accept' : 'cancel',
      });
    }

    this.removeApproval(approval);
    const updatedSession = this.updateSession(session, {
      status: session.activeTurnId ? 'running' : 'idle',
      lastError: null,
    });
    this.emitEvent('approval.resolved', {
      sessionId: updatedSession.id,
      turnId: updatedSession.activeTurnId ?? undefined,
      data: {
        approvalId: approval.approvalId,
        decision: params.decision,
        scope,
        auto: false,
        ...(params.answers ? { answers: params.answers } : {}),
      },
    });
    return { ok: true, session: this.serializeSession(updatedSession) };
  }

  async sessionSnapshot(params: SessionSnapshotParams) {
    const session = await this.ensureSessionUsable(this.requireSessionById(params.sessionId));
    const snapshot = await this.runtime.readThread(session.threadId);
    return {
      session: this.serializeSession(session),
      thread: snapshot.thread,
    };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSessionById(params.sessionId);
    if (session.activeTurnId && !params.force) {
      throw createAppError(409, 'SESSION_BUSY', 'Stop the active turn before closing the session.');
    }

    if (params.force) {
      // Proxy-local activeTurnId can diverge from Codex after a retryable
      // stream error was misclassified as terminal. Read the runtime's own
      // thread state so Force Recover interrupts the turn Codex actually owns.
      const snapshot = await this.runtime.readThread(session.threadId);
      const activeTurnId = inProgressTurnId(snapshot.thread);
      if (activeTurnId) {
        try {
          await this.runtime.interruptTurn(session.threadId, activeTurnId);
        } catch (error) {
          // Completion can race the interrupt after thread/read. Treat that as
          // recovered only when a fresh runtime snapshot confirms no turn is
          // still active; otherwise preserve the real interrupt failure.
          let stillActive: boolean;
          try {
            const refreshed = await this.runtime.readThread(session.threadId);
            stillActive = inProgressTurnId(refreshed.thread) !== null;
          } catch {
            throw error;
          }
          if (stillActive) throw error;
        }
      }
    }

    if (typeof this.runtime.unsubscribeThread === 'function') {
      await this.runtime.unsubscribeThread(session.threadId).catch(() => undefined);
    }

    this.activeTurnsByThreadId.delete(session.threadId);
    this.pendingTurnsByThreadId.delete(session.threadId);
    this.removeSession(session);
    return { ok: true };
  }

  /**
   * Structured equivalent of Codex CLI `/compact`.
   *
   * `thread/compact/start` returns immediately and streams real progress via
   * normal turn/item notifications. We create the active-turn context before
   * issuing the RPC so those notifications carry the original request id and
   * get tied back to the host's already-open turn.
   */
  private async handleCompactIntercept(
    session: SessionRecord,
    requestId?: number | string,
  ) {
    const turnId = randomId('turn');
    const updatedSession = this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      lastError: null,
    });
    this.activeTurnsByThreadId.set(updatedSession.threadId, {
      sessionId: updatedSession.id,
      ...(requestId === undefined ? {} : { requestId }),
      turnId,
      generation: this.nextTurnGeneration++,
      outputText: '',
      isCompact: true,
    });
    this.contextCompactionUsageGuards.set(updatedSession.threadId, {
      stage: 'running',
      manual: true,
    });

    this.emitEvent('token_usage.updated', {
      requestId,
      sessionId: updatedSession.id,
      turnId,
      data: { context: null, reason: 'compact_started' },
    });

    this.emitEvent('turn.started', {
      requestId,
      sessionId: updatedSession.id,
      turnId,
      data: { turnId, status: 'running', command: '/compact' },
    });

    try {
      await this.runtime.compactThread(updatedSession.threadId);
    } catch (error) {
      this.activeTurnsByThreadId.delete(updatedSession.threadId);
      this.updateSession(updatedSession, {
        activeTurnId: null,
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return {
      session: this.serializeSession(updatedSession),
      turn: { id: turnId, status: 'running' },
    };
  }

  /**
   * Structured equivalent of Codex CLI `/clear` and `/new`: keep the Gian
   * session stable but rotate the underlying Codex thread id.
   */
  private async handleClearIntercept(
    session: SessionRecord,
    command: '/clear' | '/new',
    requestId?: number | string,
  ) {
    const oldThreadId = session.threadId;
    const thread = await this.runtime.startThread({
      cwd: session.cwd,
      model: session.model,
      ephemeral: false,
    });
    const newThreadId = thread.thread.id;
    const updated = this.updateSession(session, {
      threadId: newThreadId,
      configuredPermissions: thread.configuredPermissions,
      activeTurnId: null,
      status: 'idle',
      lastError: null,
    });
    this.activeTurnsByThreadId.delete(oldThreadId);
    this.contextCompactionUsageGuards.delete(oldThreadId);

    this.emitEvent('session.rotated', {
      sessionId: updated.id,
      data: {
        oldNativeSessionId: oldThreadId,
        newNativeSessionId: newThreadId,
      },
    });

    const ackText = command === '/clear'
      ? 'Conversation cleared. Next message starts a fresh Codex context.'
      : 'Started a fresh Codex conversation for this Gian session.';
    return this.emitSyntheticCompletedTurn(updated, requestId, ackText, command);
  }

  private emitSyntheticCompletedTurn(
    session: SessionRecord,
    requestId: number | string | undefined,
    text: string,
    command: string,
  ) {
    const turnId = randomId('turn');
    const running = this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      lastError: null,
    });
    this.emitEvent('turn.started', {
      requestId,
      sessionId: running.id,
      turnId,
      data: { turnId, status: 'running', command },
    });
    this.emitEvent('output.text.delta', {
      requestId,
      sessionId: running.id,
      turnId,
      data: { delta: text, itemId: turnId },
    });
    const completed = this.updateSession(running, {
      activeTurnId: null,
      status: 'idle',
      lastError: null,
    });
    this.emitEvent('turn.completed', {
      requestId,
      sessionId: completed.id,
      turnId,
      data: { status: 'completed', result: text, command },
    });

    return {
      session: this.serializeSession(completed),
      turn: { id: turnId, status: 'completed' },
    };
  }

  private addSession(session: SessionRecord) {
    this.sessionsById.set(session.id, session);
    this.sessionsByThreadId.set(session.threadId, session);
  }

  private removeSession(session: SessionRecord) {
    this.sessionsById.delete(session.id);
    this.sessionsByThreadId.delete(session.threadId);
    this.contextCompactionUsageGuards.delete(session.threadId);
    this.pendingTurnsByThreadId.delete(session.threadId);
    const approvals = this.approvalsBySessionId.get(session.id);
    if (approvals) {
      for (const approvalId of approvals.keys()) {
        this.approvalsById.delete(approvalId);
      }
      this.approvalsBySessionId.delete(session.id);
    }
  }

  private updateSession(session: SessionRecord, patch: Partial<SessionRecord>) {
    const next: SessionRecord = {
      ...session,
      ...patch,
      updatedAt: nowIso(),
    };
    this.sessionsById.set(next.id, next);
    if (
      next.threadId !== session.threadId &&
      this.sessionsByThreadId.get(session.threadId)?.id === session.id
    ) {
      this.sessionsByThreadId.delete(session.threadId);
    }
    this.sessionsByThreadId.set(next.threadId, next);
    return next;
  }

  private serializeSession(session: SessionRecord) {
    return {
      id: session.id,
      cwd: session.cwd,
      threadId: session.threadId,
      model: session.model,
      thinking: session.thinking,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError,
    };
  }

  private requireSessionById(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    }
    return session;
  }

  private approvalsForSession(sessionId: string) {
    let approvals = this.approvalsBySessionId.get(sessionId);
    if (!approvals) {
      approvals = new Map();
      this.approvalsBySessionId.set(sessionId, approvals);
    }
    return approvals;
  }

  private addApproval(approval: PendingApproval) {
    this.approvalsById.set(approval.approvalId, approval);
    this.approvalsForSession(approval.sessionId).set(approval.approvalId, approval);
  }

  private removeApproval(approval: PendingApproval) {
    this.approvalsById.delete(approval.approvalId);
    const approvals = this.approvalsBySessionId.get(approval.sessionId);
    approvals?.delete(approval.approvalId);
    if (approvals && approvals.size === 0) {
      this.approvalsBySessionId.delete(approval.sessionId);
    }
  }

  private async ensureSessionUsable(session: SessionRecord) {
    if (session.status === 'closed') {
      throw createAppError(409, 'SESSION_CLOSED', 'This session is closed.');
    }
    // Restart scenario: if the proxy died and came back, the session is
    // no longer in memory; `requireSessionById` already threw
    // SESSION_NOT_FOUND. Host's reconnect path then calls
    // `session.create({ threadId })` to trigger resumeThread.
    if (session.status === 'stale') {
      throw createAppError(409, 'SESSION_STALE', session.lastError ?? 'The bound Codex thread is no longer available.');
    }
    if (session.status === 'error') {
      throw createAppError(409, 'SESSION_ERROR', session.lastError ?? 'The session is in error state.');
    }
    return session;
  }

  private async handleRuntimeStopped() {
    for (const session of this.sessionsById.values()) {
      const context = this.activeTurnsByThreadId.get(session.threadId);
      if (context) {
        this.emitEvent('turn.failed', {
          requestId: context.requestId,
          sessionId: session.id,
          turnId: context.turnId,
          data: {
            turnId: context.turnId,
            code: 'RUNTIME_STOPPED',
            message: 'Codex runtime stopped while the session had an active turn.',
          },
        });
      }
      this.updateSession(session, {
        status: session.activeTurnId ? 'stale' : session.status,
        lastError: session.activeTurnId ? 'Codex runtime stopped while the session had an active turn.' : session.lastError,
        activeTurnId: session.activeTurnId ? null : session.activeTurnId,
      });
    }
    this.activeTurnsByThreadId.clear();
    this.pendingTurnsByThreadId.clear();
    this.contextCompactionUsageGuards.clear();
  }

  private async handleRuntimeNotification(message: RuntimeNotification) {
    if (process.env.GIAN_CODEX_DEBUG) {
      // Permanent debug hatch: every runtime notification logs its method
      // exactly once, env-gated so production stays quiet. Useful when new
      // codex versions add notifications we haven't routed yet — flip the env
      // var on, exercise the session, then check what comes through.
      process.stderr.write(`[codex-proxy:notif] ${message.method}\n`);
    }
    const threadId = extractThreadId(message.params);
    if (!threadId) {
      return;
    }

    const session = this.sessionsByThreadId.get(threadId);
    if (!session) {
      return;
    }

    const context = this.activeTurnsByThreadId.get(threadId);
    const pending = this.pendingTurnsByThreadId.get(threadId);
    if (!context && pending) {
      pending.notifications.push(message);
      return;
    }
    const runtimeTurnId = extractTurnId(message.params);
    if (runtimeTurnId && (!context || (!context.isCompact && runtimeTurnId !== context.turnId))) {
      return;
    }
    const requestId = context?.requestId;
    const turnId = runtimeTurnId ?? context?.turnId;

    if (message.method === 'item/agentMessage/delta' && context) {
      const delta = typeof (message.params as { delta?: unknown } | undefined)?.delta === 'string'
        ? (message.params as { delta: string }).delta
        : '';
      context.outputText += delta;
      this.emitEvent('output.text.delta', {
        requestId,
        sessionId: session.id,
        turnId,
        data: {
          delta,
          itemId: (message.params as { itemId?: unknown; item_id?: unknown } | undefined)?.itemId
            ?? (message.params as { item_id?: unknown } | undefined)?.item_id
            ?? null,
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'item/commandExecution/outputDelta' && context) {
      this.emitEvent('output.command.delta', {
        requestId,
        sessionId: session.id,
        turnId,
        data: {
          delta: (message.params as { delta?: unknown } | undefined)?.delta ?? '',
          itemId: (message.params as { itemId?: unknown } | undefined)?.itemId ?? null,
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    // Reasoning streams — `textDelta` is the full reasoning trace, while
    // `summaryTextDelta` is the model's condensed "what I'm thinking" recap.
    // Both arrive as deltas keyed by itemId; `summaryPartAdded` delimits
    // section boundaries via a new itemId on subsequent deltas, so we don't
    // need to forward it separately. The `kind` field steers normalize-codex
    // toward one or the other reasoning slot.
    if (
      (message.method === 'item/reasoning/textDelta' ||
        message.method === 'item/reasoning/summaryTextDelta') &&
      context
    ) {
      const params = message.params as { delta?: unknown; itemId?: unknown; item_id?: unknown } | undefined;
      const delta = typeof params?.delta === 'string' ? params.delta : '';
      if (!delta) return;
      this.emitEvent('output.reasoning.delta', {
        requestId,
        sessionId: session.id,
        turnId,
        data: {
          delta,
          itemId: params?.itemId ?? params?.item_id ?? null,
          kind: message.method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'full',
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    // Plan content stream. `item/plan/delta` is intra-turn streaming; the
    // accompanying `turn/plan/updated` carries the cumulative final plan
    // markdown when the model commits to it. We emit two distinct events so
    // the consumer can choose to render incremental vs. final.
    if (message.method === 'item/plan/delta' && context) {
      const params = message.params as { delta?: unknown; itemId?: unknown } | undefined;
      const delta = typeof params?.delta === 'string' ? params.delta : '';
      if (!delta) return;
      this.emitEvent('output.plan.delta', {
        requestId,
        sessionId: session.id,
        turnId,
        data: { delta, itemId: params?.itemId ?? null },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'turn/plan/updated') {
      const text = codexPlanText(message.params);
      this.emitEvent('output.plan.final', {
        requestId,
        sessionId: session.id,
        turnId,
        data: { text },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      const updates = codexAgentUpdates(message.params);
      if (updates.length > 0) {
        this.emitEvent('codex.agent', {
          requestId,
          sessionId: session.id,
          turnId,
          data: { updates },
          rawRuntimeEvent: message,
        });
        return;
      }
    }

    // Turn lifecycle. Codex's runtime emits `turn/started` but the proxy was
    // previously silent on it; surfacing it lets the host drive the pending /
    // thinking-ticker state from real signals instead of the client-side
    // optimistic flag alone.
    if (message.method === 'turn/started') {
      this.emitEvent('turn.started', {
        requestId,
        sessionId: session.id,
        turnId,
        data: { params: message.params ?? {} },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'turn/diff/updated') {
      this.emitEvent('diff.updated', {
        requestId,
        sessionId: session.id,
        turnId,
        data: {
          params: message.params ?? {},
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'item/started' && isContextCompactionItem(message.params)) {
      const existing = this.contextCompactionUsageGuards.get(threadId);
      this.contextCompactionUsageGuards.set(threadId, {
        stage: 'running',
        manual: existing?.manual ?? context?.isCompact ?? false,
      });
      if (!existing) {
        this.emitEvent('token_usage.updated', {
          requestId,
          sessionId: session.id,
          turnId,
          data: { context: null, reason: 'compact_started' },
        });
      }
      return;
    }

    if (message.method === 'item/completed' && isContextCompactionItem(message.params)) {
      const existing = this.contextCompactionUsageGuards.get(threadId);
      this.contextCompactionUsageGuards.set(threadId, {
        stage: 'completed',
        manual: existing?.manual ?? context?.isCompact ?? false,
      });
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      const lifecycle = codexItemLifecycle(
        message.params,
        message.method === 'item/started' ? 'started' : 'completed',
      );
      if (lifecycle) {
        this.emitEvent('codex.item', {
          requestId,
          sessionId: session.id,
          turnId,
          data: lifecycle,
          rawRuntimeEvent: message,
        });
      }
      // The wrapper notification is never independently user-visible. A
      // supported ThreadItem becomes one stable activity above; content-only
      // and internal items are already represented by their semantic streams.
      return;
    }

    const notice = codexNotice(message.method, message.params);
    if (notice) {
      this.emitEvent('codex.notice', {
        requestId,
        sessionId: session.id,
        turnId,
        data: notice,
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'thread/tokenUsage/updated') {
      // App-server can publish the compaction request's own (pre-summary)
      // token sample and a heuristic replacement-history estimate. Do not
      // mistake either for post-compact model usage. Auto-compaction resumes
      // the ordinary turn, so the first sample after its item completes is
      // authoritative; manual compaction waits for the next ordinary turn.
      const guard = this.contextCompactionUsageGuards.get(threadId);
      if (guard) {
        if (guard.stage === 'running' || guard.manual) return;
        this.contextCompactionUsageGuards.delete(threadId);
      }
      this.emitEvent('token_usage.updated', {
        requestId,
        sessionId: session.id,
        turnId,
        data: {
          params: message.params ?? {},
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'error') {
      // Codex owns response-stream retries and will publish the eventual turn
      // completion or terminal error. Keep the active turn intact meanwhile.
      if (runtimeErrorWillRetry(message.params)) {
        return;
      }
      const updatedSession = this.updateSession(session, {
        status: 'error',
        activeTurnId: null,
        lastError: JSON.stringify(message.params ?? {}),
      });
      this.activeTurnsByThreadId.delete(threadId);
      this.emitEvent('runtime.error', {
        requestId,
        sessionId: updatedSession.id,
        turnId,
        data: {
          message: updatedSession.lastError,
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method === 'thread/compacted') {
      if (!context) return;
      const completedTurnId = turnId ?? context?.turnId ?? session.activeTurnId;
      this.activeTurnsByThreadId.delete(threadId);
      const summary = await this.buildCompletedTurnSummary(session, completedTurnId);
      const updatedSession = this.updateSession(session, {
        activeTurnId: null,
        status: 'idle',
        lastError: null,
      });
      this.emitEvent('turn.completed', {
        requestId,
        sessionId: updatedSession.id,
        turnId: completedTurnId ?? undefined,
        data: {
          status: 'completed',
          summary,
          compacted: true,
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (message.method !== 'turn/completed') {
      this.emitEvent('codex.unknown', {
        ...(requestId !== undefined ? { requestId } : {}),
        sessionId: session.id,
        ...(turnId !== undefined ? { turnId } : {}),
        data: {
          method: message.method,
          payload: message.params ?? {},
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    if (!context) return;

    const status = currentTurnStatus(message.params);
    this.activeTurnsByThreadId.delete(threadId);
    const summary = await this.buildCompletedTurnSummary(session, turnId ?? session.activeTurnId);
    const nextStatus = status === 'failed' ? 'error' : 'idle';
    const updatedSession = this.updateSession(session, {
      activeTurnId: null,
      status: nextStatus,
      lastError: status === 'failed' ? 'Codex reported a failed turn.' : null,
    });

    if (status === 'failed') {
      this.emitEvent('turn.failed', {
        requestId,
        sessionId: updatedSession.id,
        turnId: turnId ?? undefined,
        data: {
          status,
          summary,
        },
        rawRuntimeEvent: message,
      });
      return;
    }

    this.emitEvent('turn.completed', {
      requestId,
      sessionId: updatedSession.id,
      turnId: turnId ?? undefined,
      data: {
        status,
        summary,
      },
      rawRuntimeEvent: message,
    });
  }

  private async handleRuntimeServerRequest(message: RuntimeServerRequest) {
    const threadId = extractThreadId(message.params);
    if (!threadId) {
      await this.runtime.respond(message.id, cancelledServerRequestResponse(message.method));
      return;
    }

    const session = this.sessionsByThreadId.get(threadId);
    if (!session) {
      await this.runtime.respond(message.id, cancelledServerRequestResponse(message.method));
      return;
    }

    const context = this.activeTurnsByThreadId.get(threadId);
    const pending = this.pendingTurnsByThreadId.get(threadId);
    if (!context && pending) {
      pending.serverRequests.push(message);
      return;
    }
    const runtimeTurnId = extractTurnId(message.params);
    if (runtimeTurnId && (!context || (!context.isCompact && runtimeTurnId !== context.turnId))) {
      await this.runtime.respond(message.id, cancelledServerRequestResponse(message.method));
      return;
    }
    const requestId = context?.requestId;

    // Always relay app-server requests. The current turn's provider-native
    // approvalPolicy/approvalsReviewer decides which requests reach this
    // bridge; Gian only renders the exact interaction and returns the user's
    // explicit response.
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reason = approvalReason(message.method, params);
    const permissionsKind = message.method === 'item/permissions/requestApproval'
      ? classifyPermissionsKind(requestedPermissionsFromParams(params))
      : undefined;
    const approval: PendingApproval = {
      approvalId: String(message.id),
      sessionId: session.id,
      rpcRequestId: message.id,
      method: message.method,
      title: approvalTitle(message.method, params),
      reason,
      severity: approvalSeverity(message.method, params),
      ...(permissionsKind !== undefined ? { permissionsKind } : {}),
      // Mirror reason into the legacy `risk` field so older consumers don't
      // regress while the host migrates to `reason` + `severity`.
      risk: reason,
      scopeOptions: message.method === REQUEST_USER_INPUT_METHOD
        ? ['once']
        : message.method === MCP_SERVER_ELICITATION_METHOD && !mcpElicitationSupportsSession(params)
          ? ['once']
          : ['once', 'session'],
      payload: params,
      createdAt: nowIso(),
    };

    this.addApproval(approval);
    this.updateSession(session, {
      status: 'needs-approval',
    });

    this.emitEvent('approval.requested', {
      requestId,
      sessionId: session.id,
      turnId: context?.turnId,
      data: approval,
      rawRuntimeEvent: message,
    });
  }

  private async buildCompletedTurnSummary(session: SessionRecord, turnId: string | null): Promise<CompletedTurnSummary | null> {
    if (!turnId) {
      return null;
    }

    try {
      const snapshot = await this.runtime.readThread(session.threadId);
      const thread = snapshot.thread as {
        preview?: unknown;
        turns?: Array<{
          id?: unknown;
          status?: unknown;
          items?: unknown[];
        }>;
      };
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const turn = turns.find((entry) => entry && entry.id === turnId);
      if (!turn) {
        return null;
      }

      const items = Array.isArray(turn.items) ? turn.items : [];
      const assistantText = items
        .filter((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'agentMessage')
        .map((item) => typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '')
        .join('');

      const commands: CommandExecutionSummary[] = items
        .filter((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'commandExecution')
        .map((item) => ({
          id: typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : randomId('cmd'),
          command: typeof (item as { command?: unknown }).command === 'string' ? (item as { command: string }).command : '',
          cwd: typeof (item as { cwd?: unknown }).cwd === 'string' ? (item as { cwd: string }).cwd : session.cwd,
          status: typeof (item as { status?: unknown }).status === 'string' ? (item as { status: string }).status : 'completed',
          exitCode: typeof (item as { exitCode?: unknown }).exitCode === 'number' ? (item as { exitCode: number }).exitCode : null,
          aggregatedOutput: typeof (item as { aggregatedOutput?: unknown }).aggregatedOutput === 'string'
            ? (item as { aggregatedOutput: string }).aggregatedOutput
            : null,
        }));

      const fileChanges: FileChangeSummary[] = items
        .filter((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'fileChange')
        .map((item) => ({
          id: typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : randomId('file'),
          status: typeof (item as { status?: unknown }).status === 'string' ? (item as { status: string }).status : 'completed',
          changes: Array.isArray((item as { changes?: unknown }).changes)
            ? ((item as { changes: Array<{ path?: unknown; kind?: { type?: unknown }; diff?: unknown }> }).changes).map((change) => ({
              path: typeof change.path === 'string' ? change.path : 'unknown',
              kind: typeof change.kind?.type === 'string' ? change.kind.type : 'update',
              diff: typeof change.diff === 'string' ? change.diff : null,
            }))
            : [],
        }));

      return {
        turnId,
        status: typeof turn.status === 'string' ? turn.status : 'completed',
        assistantText,
        commands,
        fileChanges,
        threadPreview: typeof thread.preview === 'string' ? thread.preview : null,
      };
    } catch {
      return null;
    }
  }
}
