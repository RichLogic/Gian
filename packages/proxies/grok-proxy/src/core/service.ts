import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import { createAppError } from './errors.js';
import { normalizeInputItems, toPromptBlocks } from './input.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InitializePayload,
  InterruptTurnParams,
  ListNativeSessionsParams,
  PendingApproval,
  SessionRecord,
  SessionSnapshotParams,
  SetConfigOptionParams,
  StartTurnParams,
} from './types.js';
import { nowIso, randomId } from './utils.js';
import { GrokAcpClient } from '../runtime/grok-acp-client.js';

type ProxyEventSink = (method: string, params: Record<string, unknown>) => void;

interface ActiveTurn {
  turnId: string;
  requestId?: number | string;
  isCompact: boolean;
}

interface ServiceOptions {
  runtime: GrokAcpClient;
  emitEvent?: ProxyEventSink;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAppError(400, 'INVALID_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function runtimeErrorCode(error: unknown): number | string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' || typeof code === 'string' ? code : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function mapRuntimeError(error: unknown, binaryPath: string): Error {
  if (runtimeErrorCode(error) === -32000) {
    return createAppError(
      401,
      'AUTH_REQUIRED',
      `Grok Build is not logged in. Run ${shellQuote(binaryPath)} login in a terminal, then retry.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function updateKind(notification: SessionNotification): string {
  return notification.update.sessionUpdate;
}

function permissionReason(request: RequestPermissionRequest): string {
  const title = request.toolCall.title;
  return typeof title === 'string' && title.trim()
    ? title.trim()
    : 'Grok requested a user decision.';
}

/** Grok's ACP adapter sends AskUserQuestion with a bare `title:
 *  'AskUserQuestion'` and the actual question text inside a toolCall content
 *  block — surface that text as the approval reason so the card shows the
 *  question, not just the tool name next to the answer options. */
function permissionContentText(request: RequestPermissionRequest): string | null {
  for (const block of request.toolCall.content ?? []) {
    if (block.type === 'content' && block.content.type === 'text') {
      const text = block.content.text.trim();
      if (text) return text;
    }
  }
  return null;
}

function commandName(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

function advertisedCommand(session: SessionRecord, command: string): boolean {
  const expected = commandName(command);
  return session.slashCommands.some(item => commandName(item.name) === expected);
}

function firstTextCommand(input: Array<{ type: string; text?: string }>): string | null {
  const text = input.find(item => item.type === 'text')?.text?.trim();
  if (!text?.startsWith('/')) return null;
  return text.split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

interface ModeCapability {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

interface ModelCapability {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultThinking: string | null;
  supportedThinking: string[];
}

interface ProbedCapabilities {
  modes: ModeCapability[];
  models: ModelCapability[];
  sessionOptions: SessionConfigOption[];
}

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

function flatChoices(option: SelectConfigOption) {
  return option.options.flatMap(entry =>
    'options' in entry ? entry.options : [entry]);
}

/** Classify a session config option the same way the web composer's
 *  nativeOptionRole does: category (or id) decides whether the select is the
 *  model picker, the thinking-level picker, or the approval-mode picker. */
function configOptionRole(
  option: SessionConfigOption,
): 'model' | 'thinking' | 'mode' | null {
  const category = typeof option.category === 'string'
    ? option.category.trim().toLowerCase()
    : '';
  const id = option.id.trim().toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    category === 'thought_level'
    || category === 'thought'
    || category === 'thinking'
    || category === 'effort'
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'thinking';
  if (category === 'mode' || id === 'mode') return 'mode';
  return null;
}

function selectOptionByRole(
  options: SessionConfigOption[],
  role: 'model' | 'thinking' | 'mode',
): SelectConfigOption | null {
  const found = options.find(option =>
    option.type === 'select' && configOptionRole(option) === role);
  return found && found.type === 'select' ? found : null;
}

/** Extract the approval-mode choices from a session's ACP configOptions.
 *  Select options may be flat or grouped. */
function modesFromConfigOptions(options: SessionConfigOption[]): ModeCapability[] {
  const modeOption = selectOptionByRole(options, 'mode');
  if (!modeOption) return [];
  return flatChoices(modeOption).map(choice => ({
    id: String(choice.value),
    label: choice.name || String(choice.value),
    description: typeof choice.description === 'string' ? choice.description : '',
    isDefault: choice.value === modeOption.currentValue,
  }));
}

/** Grok thinking levels are session-global (one thought-level select, not
 *  per-model), so extract them once and attach the same list to every model
 *  — the generic Settings UI reads supportedThinking off the selected model. */
function thinkingLevelsFromConfigOptions(options: SessionConfigOption[]): string[] {
  const thinkingOption = selectOptionByRole(options, 'thinking');
  if (!thinkingOption) return [];
  return flatChoices(thinkingOption).map(choice => String(choice.value));
}

function modelsFromConfigOptions(
  options: SessionConfigOption[],
  supportedThinking: string[],
): ModelCapability[] {
  const modelOption = selectOptionByRole(options, 'model');
  if (!modelOption) return [];
  return flatChoices(modelOption).map(choice => {
    const value = String(choice.value);
    return {
      id: `grok-model-${value}`,
      model: value,
      displayName: choice.name || value,
      description: typeof modelOption.description === 'string' ? modelOption.description : '',
      hidden: false,
      isDefault: choice.value === modelOption.currentValue,
      defaultThinking: null,
      supportedThinking,
    };
  });
}

function capabilitiesFromConfigOptions(options: SessionConfigOption[]): ProbedCapabilities {
  return {
    modes: modesFromConfigOptions(options),
    models: modelsFromConfigOptions(options, thinkingLevelsFromConfigOptions(options)),
    sessionOptions: [...options],
  };
}

export function parseGrokConversationUsage(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totalTokens = tokenCount(usage.totalTokens);
  // ACP SDK 0.23 marks these three fields as required. Accepting a partial
  // match as an absolute snapshot would let EventCoordinator replace every
  // missing counter with zero, so malformed/future shapes must stay unknown.
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return null;
  }
  const rawCachedRead = usage.cachedReadTokens;
  const rawCachedWrite = usage.cachedWriteTokens;
  const rawThoughtTokens = usage.thoughtTokens;
  const cachedReadTokens = tokenCount(rawCachedRead);
  const cachedWriteTokens = tokenCount(rawCachedWrite);
  const thoughtTokens = tokenCount(rawThoughtTokens);
  if (
    (rawCachedRead !== undefined && rawCachedRead !== null && cachedReadTokens === undefined)
    || (rawCachedWrite !== undefined && rawCachedWrite !== null && cachedWriteTokens === undefined)
    || (rawThoughtTokens !== undefined && rawThoughtTokens !== null && thoughtTokens === undefined)
  ) return null;
  return {
    mode: 'absolute' as const,
    inputTokens,
    outputTokens,
    cachedInputTokens: (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0),
    totalTokens,
  };
}

function conversationUsage(response: PromptResponse) {
  return parseGrokConversationUsage(response.usage);
}

export function parseGrokStatusContext(
  notifications: SessionNotification[],
): { used: number; window: number } | null {
  const text = notifications
    .map(notification => notification.update as unknown as Record<string, unknown>)
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => {
      const content = update.content;
      if (!content || typeof content !== 'object') return '';
      const block = content as Record<string, unknown>;
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
  const match = /Context\s*:\s*([\d,_]+)\s*\/\s*([\d,_]+)/i.exec(text);
  if (!match) return null;
  const used = Number(match[1]!.replaceAll(/[, _]/g, ''));
  const window = Number(match[2]!.replaceAll(/[, _]/g, ''));
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(window) || window <= 0) {
    return null;
  }
  return { used: Math.floor(used), window: Math.floor(window) };
}

export class GrokProxyService {
  private readonly runtime: GrokAcpClient;
  private emitEvent: ProxyEventSink;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly proxyIdByNativeId = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly resumePromises = new Map<string, Promise<SessionRecord>>();
  private readonly provisionalUpdates = new Map<string, SessionNotification[]>();
  private readonly unclaimedUpdates = new Map<string, SessionNotification[]>();
  private readonly slashReadySessions = new Set<string>();
  private readonly slashWaiters = new Map<string, Set<() => void>>();
  private readonly toolCallsByNativeId = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  constructor(options: ServiceOptions) {
    this.runtime = options.runtime;
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.runtime.setPermissionHandler((request) => this.handlePermissionRequest(request));
    this.runtime.on('sessionUpdate', (notification) => {
      this.handleSessionUpdate(notification);
    });
    this.runtime.on('runtimeStopped', (event) => {
      this.handleRuntimeStopped(event);
    });
    this.runtime.on('debug', (message) => {
      this.emitEvent('debug', { message });
    });
  }

  async initialize(): Promise<void> {
    await this.runtime.ensureStarted();
  }

  setEventSink(handler: ProxyEventSink): void {
    this.emitEvent = handler;
  }

  initializePayload(): InitializePayload {
    return {
      mode: 'spawn',
      protocolVersion: 'acp/1',
      methods: [
        'initialize',
        'capabilities.list',
        'slash.list',
        'session.create',
        'session.get',
        'session.listNative',
        'session.config.set',
        'turn.start',
        'turn.interrupt',
        'approval.respond',
        'session.snapshot',
        'session.close',
        'shutdown',
      ],
    };
  }

  async listCapabilities() {
    const probed = await this.probeCapabilities();
    return {
      ...await this.runtime.ensureStarted(),
      modes: probed.modes,
      models: probed.models,
      sessionOptions: probed.sessionOptions,
    };
  }

  private probedCapabilities: ProbedCapabilities | null = null;

  /** Grok only reveals its model/thinking/mode choices per session
   *  (configOptions from session/new), so learn them once: reuse an
   *  already-attached session's options when there is one, otherwise create
   *  a throwaway session in the temp dir and close it again. Cached for the
   *  process lifetime — the choices only change with the Grok version, and
   *  the proxy is respawned on upgrade (2026-08-04). On any failure (e.g.
   *  not logged in) report no modes/models rather than breaking
   *  capabilities. */
  private async probeCapabilities(): Promise<ProbedCapabilities> {
    if (this.probedCapabilities) return this.probedCapabilities;
    for (const session of this.sessionsById.values()) {
      const probed = capabilitiesFromConfigOptions(session.configOptions);
      if (
        probed.modes.length > 0
        || probed.models.length > 0
        || probed.sessionOptions.length > 0
      ) {
        this.probedCapabilities = probed;
        return probed;
      }
    }
    try {
      const response = await this.runtime.newSession({ cwd: tmpdir(), mcpServers: [] });
      const probed = capabilitiesFromConfigOptions(response.configOptions ?? []);
      try {
        await this.runtime.closeSession({ sessionId: response.sessionId });
      } catch { /* close unsupported or failed — the probe session stays detached */ }
      this.probedCapabilities = probed;
      return probed;
    } catch {
      return { modes: [], models: [], sessionOptions: [] };
    }
  }

  async listNativeSessions(params: ListNativeSessionsParams) {
    return this.runtime.listSessions({
      ...(params.cwd ? { cwd: resolve(params.cwd) } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
  }

  async listSlashCommands(params: GetSessionParams) {
    const session = this.requireSession(params.sessionId);
    await this.waitForInitialSlashCommands(session.id);
    return { commands: [...session.slashCommands] };
  }

  async createSession(input: CreateSessionParams) {
    const cwd = resolve(nonEmptyString(input.cwd, 'cwd'));
    const mcpServers = Array.isArray(input.mcpServers) ? input.mcpServers : [];
    const nativeSessionId = typeof input.nativeSessionId === 'string'
      && input.nativeSessionId.trim()
      ? input.nativeSessionId.trim()
      : null;
    const proxySessionId = randomId('sess');
    const createdAt = nowIso();

    if (!nativeSessionId) {
      try {
        const response = await this.runtime.newSession({ cwd, mcpServers });
        const session = this.makeSession({
          id: proxySessionId,
          cwd,
          nativeSessionId: response.sessionId,
          mcpServers,
          configOptions: response.configOptions ?? [],
          createdAt,
        });
        this.addSession(session);
        // Grok may publish commands before session/new resolves, when the
        // native ID is not known to the proxy yet.
        const initialUpdates = this.claimUnownedUpdates(session);
        return {
          session: this.serializeSession(session),
          replayUpdates: initialUpdates,
        };
      } catch (error) {
        throw mapRuntimeError(error, this.runtime.binaryPath);
      }
    }

    const session = this.makeSession({
      id: proxySessionId,
      cwd,
      nativeSessionId,
      mcpServers,
      configOptions: [],
      createdAt,
    });
    this.addSession(session);
    // session/load replays history during the RPC. Hold those updates until
    // load succeeds so the host can persist its row + replay transactionally.
    this.provisionalUpdates.set(session.id, []);

    try {
      const response = input.resumeMode === 'resume'
        ? await this.runtime.resumeSession({
          sessionId: nativeSessionId,
          cwd,
          mcpServers,
        })
        : await this.runtime.loadSession({
          sessionId: nativeSessionId,
          cwd,
          mcpServers,
        });
      session.configOptions = response.configOptions ?? session.configOptions;
      session.updatedAt = nowIso();
      const replayUpdates = this.provisionalUpdates.get(session.id) ?? [];
      this.provisionalUpdates.delete(session.id);
      this.toolCallsByNativeId.delete(session.nativeSessionId);
      return {
        session: this.serializeSession(session),
        replayUpdates,
      };
    } catch (error) {
      this.provisionalUpdates.delete(session.id);
      this.removeSession(session);
      throw mapRuntimeError(error, this.runtime.binaryPath);
    }
  }

  getSession(params: GetSessionParams) {
    return { session: this.serializeSession(this.requireSession(params.sessionId)) };
  }

  async startTurn(params: StartTurnParams, requestId?: number | string) {
    const session = await this.ensureAttached(this.requireSession(params.sessionId));
    if (session.activeTurnId) {
      throw createAppError(409, 'SESSION_BUSY', 'This session already has an active turn.');
    }

    const input = normalizeInputItems(params.input, session.cwd);
    const prompt = await toPromptBlocks(input);
    const command = firstTextCommand(input);
    this.toolCallsByNativeId.delete(session.nativeSessionId);
    const turnId = randomId('turn');
    const activeTurn: ActiveTurn = {
      turnId,
      ...(requestId === undefined ? {} : { requestId }),
      isCompact: command === '/compact',
    };
    this.activeTurns.set(session.id, activeTurn);
    this.updateSession(session, {
      activeTurnId: turnId,
      status: 'running',
      lastError: null,
    });
    if (activeTurn.isCompact) {
      this.emitEvent('token_usage.updated', this.eventEnvelope(session, {
        context: null,
        reason: 'compact_started',
      }, turnId));
    }
    this.emitEvent('turn.started', this.eventEnvelope(session, {
      turnId,
      status: 'running',
    }));

    // ACP session/prompt resolves only when the turn ends. Keep the proxy RPC
    // non-blocking and finish the turn through notifications.
    void this.runPrompt(session.id, turnId, prompt);

    return {
      session: this.serializeSession(session),
      turn: { id: turnId, status: 'running' },
    };
  }

  async interruptTurn(params: InterruptTurnParams) {
    const session = this.requireSession(params.sessionId);
    if (!session.activeTurnId) {
      throw createAppError(409, 'INVALID_REQUEST', 'This session does not have an active turn.');
    }
    await this.runtime.cancel(session.nativeSessionId);
    this.cancelApprovalsForSession(session.id);
    return { ok: true, session: this.serializeSession(session) };
  }

  async respondApproval(params: ApprovalResponseParams) {
    const session = this.requireSession(params.sessionId);
    const approval = this.approvalsById.get(params.approvalId);
    if (!approval || approval.sessionId !== session.id) {
      throw createAppError(404, 'APPROVAL_NOT_FOUND', 'Approval not found.');
    }

    if (!params.nativeOptionId) {
      this.resolveApproval(approval, { outcome: { outcome: 'cancelled' } });
      return { ok: true, session: this.serializeSession(session) };
    }

    if (!approval.options.some((option) => option.optionId === params.nativeOptionId)) {
      throw createAppError(
        409,
        'INVALID_APPROVAL_OPTION',
        'The selected native approval option is no longer available.',
      );
    }

    this.resolveApproval(approval, {
      outcome: {
        outcome: 'selected',
        optionId: params.nativeOptionId,
      },
    });
    return { ok: true, session: this.serializeSession(session) };
  }

  async setConfigOption(params: SetConfigOptionParams) {
    const session = await this.ensureAttached(this.requireSession(params.sessionId));
    const configId = nonEmptyString(params.configId, 'configId');
    const request = typeof params.value === 'boolean'
      ? {
        sessionId: session.nativeSessionId,
        configId,
        type: 'boolean' as const,
        value: params.value,
      }
      : {
        sessionId: session.nativeSessionId,
        configId,
        value: nonEmptyString(params.value, 'value'),
      };
    const response = await this.runtime.setSessionConfigOption(request);
    session.configOptions = response.configOptions;
    session.updatedAt = nowIso();
    return {
      session: this.serializeSession(session),
      configOptions: response.configOptions,
    };
  }

  async sessionSnapshot(params: SessionSnapshotParams) {
    const session = await this.ensureAttached(this.requireSession(params.sessionId));
    return {
      session: this.serializeSession(session),
      configOptions: session.configOptions,
      slashCommands: session.slashCommands,
    };
  }

  async closeSession(params: CloseSessionParams) {
    const session = this.requireSession(params.sessionId);
    if (session.activeTurnId) {
      await this.runtime.cancel(session.nativeSessionId).catch(() => undefined);
    }
    this.cancelApprovalsForSession(session.id);

    const nativeCloseSupported = (
      this.runtime.negotiated?.agentCapabilities?.sessionCapabilities?.close != null
    );
    if (nativeCloseSupported && session.attached) {
      await this.runtime.closeSession({ sessionId: session.nativeSessionId });
    }

    this.removeSession(session);
    return {
      ok: true,
      nativeClosed: nativeCloseSupported,
      detached: !nativeCloseSupported,
    };
  }

  async close(): Promise<void> {
    for (const approval of [...this.approvalsById.values()]) {
      this.resolveApproval(approval, { outcome: { outcome: 'cancelled' } }, false);
    }
    for (const sessionId of this.slashWaiters.keys()) {
      this.resolveSlashWaiters(sessionId);
    }
    await this.runtime.stop();
  }

  private async runPrompt(
    proxySessionId: string,
    turnId: string,
    prompt: Parameters<GrokAcpClient['prompt']>[0]['prompt'],
  ): Promise<void> {
    const session = this.sessionsById.get(proxySessionId);
    if (!session) return;

    try {
      const response = await this.runtime.prompt({
        sessionId: session.nativeSessionId,
        prompt,
      });
      const current = this.sessionsById.get(proxySessionId);
      if (!current || current.activeTurnId !== turnId) return;

      const cumulative = conversationUsage(response);
      if (cumulative) {
        this.emitEvent('token_usage.updated', this.eventEnvelope(current, {
          conversation: cumulative,
        }, turnId));
      }
      if (response.stopReason !== 'cancelled' && advertisedCommand(current, 'status')) {
        try {
          const status = await this.runtime.promptCaptured({
            sessionId: current.nativeSessionId,
            prompt: [{ type: 'text', text: '/status' }],
          });
          const context = parseGrokStatusContext(status.updates);
          if (context && current.activeTurnId === turnId) {
            this.emitEvent('token_usage.updated', this.eventEnvelope(current, {
              context,
            }, turnId));
          }
        } catch (error) {
          this.emitEvent('debug', {
            message: `[grok] Could not refresh context usage: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      this.activeTurns.delete(proxySessionId);
      this.toolCallsByNativeId.delete(current.nativeSessionId);
      this.updateSession(current, {
        activeTurnId: null,
        status: 'idle',
        lastError: null,
      });
      this.emitEvent('turn.completed', this.eventEnvelope(current, {
        turnId,
        status: response.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        stopReason: response.stopReason,
        usage: response.usage ?? null,
      }, turnId));
    } catch (error) {
      const current = this.sessionsById.get(proxySessionId);
      if (!current || current.activeTurnId !== turnId) return;
      const mappedError = mapRuntimeError(error, this.runtime.binaryPath);

      this.activeTurns.delete(proxySessionId);
      this.toolCallsByNativeId.delete(current.nativeSessionId);
      this.cancelApprovalsForSession(proxySessionId);
      this.updateSession(current, {
        activeTurnId: null,
        status: 'error',
        lastError: mappedError.message,
      });
      this.emitEvent('turn.failed', this.eventEnvelope(current, {
        turnId,
        code: runtimeErrorCode(mappedError) ?? 'PROMPT_FAILED',
        message: current.lastError,
      }, turnId));
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const completeNotification = this.completeToolUpdate(notification);
    const proxySessionId = this.proxyIdByNativeId.get(completeNotification.sessionId);
    if (!proxySessionId) {
      const pending = this.unclaimedUpdates.get(completeNotification.sessionId) ?? [];
      if (pending.length < 200) pending.push(completeNotification);
      this.unclaimedUpdates.set(completeNotification.sessionId, pending);
      if (this.unclaimedUpdates.size > 50) {
        const oldest = this.unclaimedUpdates.keys().next().value;
        if (typeof oldest === 'string') this.unclaimedUpdates.delete(oldest);
      }
      return;
    }

    const session = this.sessionsById.get(proxySessionId);
    if (!session) return;
    this.applySessionUpdate(session, completeNotification);

    const provisional = this.provisionalUpdates.get(proxySessionId);
    if (provisional) {
      provisional.push(completeNotification);
      return;
    }

    // A compact request may emit a usage sample for the summarization input.
    // Keep the numerator invalid until the captured post-compact /status
    // response emits the authoritative replacement.
    const activeTurn = this.activeTurns.get(proxySessionId);
    if (activeTurn?.isCompact && updateKind(completeNotification) === 'usage_update') {
      return;
    }

    this.emitEvent('acp.sessionUpdate', this.eventEnvelope(session, {
      update: completeNotification.update,
    }, session.activeTurnId ?? undefined, {
      method: 'session/update',
      params: completeNotification,
    }));
  }

  /**
   * ACP tool_call_update is intentionally sparse. Carry the initial tool
   * metadata forward so downstream normalizers can keep one stable card type
   * instead of turning a completed Read/Bash call into a second generic tool.
   */
  private completeToolUpdate(notification: SessionNotification): SessionNotification {
    const update = notification.update as unknown as Record<string, unknown>;
    const kind = update.sessionUpdate;
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return notification;
    if (typeof update.toolCallId !== 'string') return notification;

    let calls = this.toolCallsByNativeId.get(notification.sessionId);
    if (!calls) {
      calls = new Map();
      this.toolCallsByNativeId.set(notification.sessionId, calls);
    }
    const previous = calls.get(update.toolCallId);
    const complete = previous ? { ...previous, ...update } : { ...update };
    calls.set(update.toolCallId, complete);
    if (!previous || kind === 'tool_call') return notification;

    return {
      ...notification,
      update: {
        ...complete,
        sessionUpdate: 'tool_call_update',
      } as SessionNotification['update'],
    };
  }

  private applySessionUpdate(session: SessionRecord, notification: SessionNotification): void {
    if (updateKind(notification) === 'config_option_update') {
      session.configOptions = (
        notification.update as Extract<
          SessionNotification['update'],
          { sessionUpdate: 'config_option_update' }
        >
      ).configOptions;
    } else if (updateKind(notification) === 'available_commands_update') {
      session.slashCommands = (
        notification.update as Extract<
          SessionNotification['update'],
          { sessionUpdate: 'available_commands_update' }
        >
      ).availableCommands;
      this.slashReadySessions.add(session.id);
      this.resolveSlashWaiters(session.id);
    }
    session.updatedAt = nowIso();
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const proxySessionId = this.proxyIdByNativeId.get(request.sessionId);
    const session = proxySessionId ? this.sessionsById.get(proxySessionId) : null;
    if (!session || this.provisionalUpdates.has(session.id)) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const approvalId = randomId('approval');
    return new Promise<RequestPermissionResponse>((resolve) => {
      const approval: PendingApproval = {
        approvalId,
        sessionId: session.id,
        turnId: session.activeTurnId,
        options: request.options,
        resolve,
      };
      this.approvalsById.set(approvalId, approval);
      this.updateSession(session, { status: 'needs-approval' });
      this.emitEvent('approval.requested', this.eventEnvelope(session, {
        approvalId,
        title: permissionReason(request),
        reason: permissionContentText(request) ?? permissionReason(request),
        severity: 'medium',
        nativeOptions: request.options,
        payload: request,
      }, session.activeTurnId ?? undefined, {
        method: 'session/request_permission',
        params: request,
      }));
    });
  }

  private resolveApproval(
    approval: PendingApproval,
    response: RequestPermissionResponse,
    emit = true,
  ): void {
    this.approvalsById.delete(approval.approvalId);
    approval.resolve(response);
    const session = this.sessionsById.get(approval.sessionId);
    if (!session) return;

    this.updateSession(session, {
      status: session.activeTurnId ? 'running' : 'idle',
    });
    if (emit) {
      this.emitEvent('approval.resolved', this.eventEnvelope(session, {
        approvalId: approval.approvalId,
        nativeOptionId: response.outcome.outcome === 'selected'
          ? response.outcome.optionId
          : null,
        cancelled: response.outcome.outcome === 'cancelled',
      }, approval.turnId ?? undefined));
    }
  }

  private cancelApprovalsForSession(sessionId: string): void {
    for (const approval of [...this.approvalsById.values()]) {
      if (approval.sessionId === sessionId) {
        this.resolveApproval(approval, { outcome: { outcome: 'cancelled' } });
      }
    }
  }

  private handleRuntimeStopped(event: {
    code: number | null;
    signal: NodeJS.Signals | null;
    expected: boolean;
    error?: Error;
  }): void {
    this.unclaimedUpdates.clear();
    this.toolCallsByNativeId.clear();
    for (const approval of [...this.approvalsById.values()]) {
      this.resolveApproval(approval, { outcome: { outcome: 'cancelled' } });
    }

    for (const session of this.sessionsById.values()) {
      const turn = this.activeTurns.get(session.id);
      if (turn) {
        this.emitEvent('turn.failed', this.eventEnvelope(session, {
          turnId: turn.turnId,
          code: 'RUNTIME_STOPPED',
          message: 'Grok ACP process stopped.',
        }, turn.turnId));
      }
      this.activeTurns.delete(session.id);
      this.updateSession(session, {
        attached: false,
        activeTurnId: null,
        status: 'stale',
        lastError: event.expected ? null : 'Grok ACP process stopped unexpectedly.',
      });
    }

    this.emitEvent('runtime.stopped', {
      data: {
        code: event.code,
        signal: event.signal,
        expected: event.expected,
        error: event.error?.message ?? null,
      },
    });
  }

  private async ensureAttached(session: SessionRecord): Promise<SessionRecord> {
    if (session.attached) return session;
    const existing = this.resumePromises.get(session.id);
    if (existing) return existing;

    // A shared ACP crash invalidates every live adapter map. Rebind lazily to
    // the same native ID; never fall back to session/new.
    const resume = this.runtime.resumeSession({
      sessionId: session.nativeSessionId,
      cwd: session.cwd,
      mcpServers: session.mcpServers,
    }).then((response) => {
      session.configOptions = response.configOptions ?? session.configOptions;
      return this.updateSession(session, {
        attached: true,
        status: 'idle',
        lastError: null,
      });
    }).catch((error) => {
      this.updateSession(session, {
        attached: false,
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw mapRuntimeError(error, this.runtime.binaryPath);
    }).finally(() => {
      this.resumePromises.delete(session.id);
    });

    this.resumePromises.set(session.id, resume);
    return resume;
  }

  private claimUnownedUpdates(session: SessionRecord): SessionNotification[] {
    const updates = this.unclaimedUpdates.get(session.nativeSessionId) ?? [];
    this.unclaimedUpdates.delete(session.nativeSessionId);
    for (const notification of updates) {
      this.applySessionUpdate(session, notification);
    }
    return updates;
  }

  private makeSession(input: {
    id: string;
    cwd: string;
    nativeSessionId: string;
    mcpServers: SessionRecord['mcpServers'];
    configOptions: SessionRecord['configOptions'];
    createdAt: string;
  }): SessionRecord {
    return {
      id: input.id,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId,
      mcpServers: input.mcpServers,
      configOptions: input.configOptions,
      slashCommands: [],
      status: 'idle',
      activeTurnId: null,
      attached: true,
      lastError: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
  }

  private addSession(session: SessionRecord): void {
    if (this.proxyIdByNativeId.has(session.nativeSessionId)) {
      throw createAppError(
        409,
        'NATIVE_SESSION_ATTACHED',
        `Native Grok session ${session.nativeSessionId} is already attached.`,
      );
    }
    this.sessionsById.set(session.id, session);
    this.proxyIdByNativeId.set(session.nativeSessionId, session.id);
  }

  private removeSession(session: SessionRecord): void {
    this.sessionsById.delete(session.id);
    if (this.proxyIdByNativeId.get(session.nativeSessionId) === session.id) {
      this.proxyIdByNativeId.delete(session.nativeSessionId);
    }
    this.activeTurns.delete(session.id);
    this.resumePromises.delete(session.id);
    this.provisionalUpdates.delete(session.id);
    this.slashReadySessions.delete(session.id);
    this.resolveSlashWaiters(session.id);
    this.toolCallsByNativeId.delete(session.nativeSessionId);
  }

  private async waitForInitialSlashCommands(sessionId: string): Promise<void> {
    if (this.slashReadySessions.has(sessionId)) return;

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        const waiters = this.slashWaiters.get(sessionId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.slashWaiters.delete(sessionId);
        resolve();
      };
      const waiters = this.slashWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(finish);
      this.slashWaiters.set(sessionId, waiters);
      // Older ACP agents may never publish available_commands_update. Keep
      // slash.list bounded while giving Grok's deferred command scan time to
      // finish after session/new or session/load returns.
      timer = setTimeout(finish, 1_000);
    });
  }

  private resolveSlashWaiters(sessionId: string): void {
    const waiters = this.slashWaiters.get(sessionId);
    if (!waiters) return;
    for (const finish of [...waiters]) finish();
  }

  private requireSession(sessionId: unknown): SessionRecord {
    const normalized = nonEmptyString(sessionId, 'sessionId');
    const session = this.sessionsById.get(normalized);
    if (!session) {
      throw createAppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    }
    return session;
  }

  private updateSession(
    session: SessionRecord,
    changes: Partial<SessionRecord>,
  ): SessionRecord {
    Object.assign(session, changes, { updatedAt: nowIso() });
    return session;
  }

  private serializeSession(session: SessionRecord) {
    return {
      ...session,
      configOptions: [...session.configOptions],
      slashCommands: [...session.slashCommands],
      mcpServers: [...session.mcpServers],
    };
  }

  private eventEnvelope(
    session: SessionRecord,
    data: Record<string, unknown>,
    turnId = session.activeTurnId ?? undefined,
    rawRuntimeEvent?: { method: string; params?: unknown },
  ) {
    const activeTurn = this.activeTurns.get(session.id);
    return {
      ...(activeTurn?.requestId === undefined ? {} : { requestId: activeTurn.requestId }),
      sessionId: session.id,
      ...(turnId ? { turnId } : {}),
      data,
      ...(rawRuntimeEvent ? { rawRuntimeEvent } : {}),
    };
  }
}
