import { createHash, randomUUID } from 'node:crypto';
import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import { OpaqueSidechatResumeStore } from '@gian/proxy-protocol';
import { KimiProxyError } from '../core/errors.js';
import { KimiProxyService } from '../core/service.js';
import { KimiProtocolError, type DomainCode } from '../transport/protocol.js';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type ConfigValue = string | boolean | number | null;

export type WireRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type V2EventSink = (method: string, params: Record<string, unknown>) => void;

class TurnLedger {
  private readonly streams = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();

  attach(sessionId: string, streamId: string): void {
    this.streams.set(sessionId, streamId);
    for (const key of [...this.fingerprints.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  close(sessionId: string): void {
    this.streams.delete(sessionId);
    for (const key of [...this.fingerprints.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  accept(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: unknown;
    config: unknown;
  }): 'new' | 'duplicate' {
    const active = this.streams.get(params.sessionId);
    if (active === undefined) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${params.sessionId} is not attached.`);
    }
    if (active !== params.streamId) {
      throw new KimiProtocolError('SESSION_STALE', `Stream ${params.streamId} is no longer active.`);
    }
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    const fingerprint = JSON.stringify({ input: params.input, config: params.config });
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return 'new';
    }
    if (existing !== fingerprint) {
      throw new KimiProtocolError('CONFLICT', `Turn ${params.turnId} was reused with different input.`);
    }
    return 'duplicate';
  }

  forget(params: { sessionId: string; streamId: string; turnId: string }): void {
    this.fingerprints.delete(`${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`);
  }
}

class ReplayPager {
  private readonly active = new Map<string, { streamId: string; events: readonly unknown[] }>();

  page(
    sessionId: string,
    latest: { streamId: string; events: readonly unknown[] },
    cursor: string | null,
    limit: number,
  ) {
    const snapshot = cursor === null ? latest : this.active.get(sessionId);
    if (snapshot === undefined) {
      throw new KimiProtocolError('INVALID_PARAMS', 'Replay cursor has no active snapshot.');
    }
    if (cursor === null) this.active.set(sessionId, snapshot);
    const offset = cursor === null || /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor ?? 0) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.events.length) {
      throw new KimiProtocolError('INVALID_PARAMS', 'Invalid replay cursor.');
    }
    const end = Math.min(offset + limit, snapshot.events.length);
    const nextCursor = end < snapshot.events.length ? String(end) : null;
    if (nextCursor === null) this.active.delete(sessionId);
    return {
      replayStreamId: snapshot.streamId,
      events: snapshot.events.slice(offset, end),
      nextCursor,
    };
  }

  close(sessionId: string): void {
    this.active.delete(sessionId);
  }
}

interface AttachedSession {
  id: string;
  serviceSessionId: string;
  nativeSessionId: string;
  streamId: string;
  cwd: string;
  state: 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  configOptions: SessionConfigOption[];
  sessionConfig: Record<string, ConfigValue>;
  createFingerprint: string;
  turnOrdinal: number;
  sequence: number;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

interface InteractionRef extends HostTurnRef {
  serviceApprovalId: string;
  inputIds: string[];
  actionIds: string[];
  responses: Map<string, { actionId: string; values: Record<string, unknown> }>;
}

interface ReplayEvent {
  method: string;
  eventId: string;
  sessionId: string;
  replayStreamId: string;
  sequence: number;
  sourceTurnId: string;
  emittedAt: string;
  data: Record<string, unknown>;
}

interface ReplayState {
  streamId: string;
  events: ReplayEvent[];
  turnCount: number;
}

type SidechatAnchor =
  | { type: 'empty' }
  | { type: 'turn'; turnId: string; sourceTurnId: string };

interface SidechatRecord {
  parentSessionId: string;
  resumeRefId: string;
  anchor: SidechatAnchor;
  createFingerprint?: string;
  resumeFingerprint?: string;
}

interface ServiceSessionShape {
  id: string;
  nativeSessionId: string;
  status: 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  configOptions: SessionConfigOption[];
}

const PROTOCOL_NAME = 'gian.proxy';
const PROTOCOL_V2 = '2.1';

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'session.rename': 1,
  'session.native.list': 1,
  'session.replay': 1,
  sidechat: 1,
  'session.fork': 1,
  'catalog.resolve': 1,
  interaction: 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.usage': 1,
} as const;

interface CatalogModelCapability {
  model: string;
  isDefault: boolean;
  defaultThinking: string | null;
  supportedThinking: string[];
}

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

const MAX_DETAILS_BYTES = 64 * 1024;

/** Bounded diagnostic details for degraded unknown events. */
function boundedDetails(value: unknown): JsonValue {
  const json = jsonValue(value);
  if (Buffer.byteLength(JSON.stringify(json), 'utf8') <= MAX_DETAILS_BYTES) return json;
  return {
    truncated: true,
    note: 'Native update exceeded the diagnostic details budget.',
  };
}

function isConfigValue(value: unknown): value is ConfigValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function standardError(error: unknown): KimiProtocolError {
  if (error instanceof KimiProtocolError) return error;
  if (error instanceof KimiProxyError) {
    const code: DomainCode = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_CLOSED': return 'SESSION_CLOSED';
        case 'SESSION_STALE': return 'SESSION_STALE';
        case 'SESSION_ERROR': return 'SESSION_ERROR';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'APPROVAL_NOT_FOUND': return 'INTERACTION_NOT_FOUND';
        case 'INVALID_APPROVAL_OPTION': return 'INTERACTION_ACTION_NOT_FOUND';
        case 'NATIVE_SESSION_ATTACHED': return 'CONFLICT';
        case 'AUTH_REQUIRED': return 'RUNTIME_AUTH_REQUIRED';
        case 'INVALID_REQUEST': return 'INVALID_PARAMS';
        default: return 'RUNTIME_ERROR';
      }
    })();
    return new KimiProtocolError(code, error.message, false);
  }
  return new KimiProtocolError(
    'INTERNAL',
    error instanceof Error ? error.message : String(error),
  );
}

function configRole(option: SessionConfigOption): 'model' | 'effort' | 'approval_mode' | null {
  const raw = option as SessionConfigOption & { category?: string };
  const category = raw.category?.toLowerCase() ?? '';
  const id = option.id.toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    ['thought_level', 'thought', 'thinking', 'effort'].includes(category)
    || ['thought_level', 'thought', 'thinking', 'effort', 'reasoning_effort'].includes(id)
  ) return 'effort';
  if (category === 'mode' || id === 'mode') return 'approval_mode';
  return null;
}

function flatChoices(option: SessionConfigOption) {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) => (
    'options' in entry
      ? entry.options.map((choice) => ({ ...choice, group: entry.name }))
      : [entry]
  ));
}

function catalogConfigOption(option: SessionConfigOption) {
  const role = configRole(option);
  const choices = flatChoices(option).map((choice) => ({
    value: typeof choice.value === 'string' || typeof choice.value === 'boolean'
      ? choice.value
      : String(choice.value),
    displayName: choice.name || String(choice.value),
    ...(typeof choice.description === 'string' ? { description: choice.description } : {}),
  }));
  const current = option.type === 'boolean'
    ? option.currentValue === true
    : typeof option.currentValue === 'string' ? option.currentValue : null;
  const defaultValue = option.type === 'select'
    && current !== null
    && !choices.some((choice) => Object.is(choice.value, current))
    ? null
    : current;
  const control = option.type === 'boolean' ? 'boolean' as const : 'select' as const;
  return {
    id: option.id,
    displayName: option.name,
    ...(typeof option.description === 'string' ? { description: option.description } : {}),
    // Kimi's ACP `session/set_config_option` can be applied between prompts,
    // so every option is honestly turn-bound: the proxy applies the full
    // turn.start snapshot right before each prompt. Declaring `session` here
    // while re-applying per turn was the binding/application-time mismatch.
    binding: 'turn' as const,
    ...(role ? { role } : {}),
    control,
    required: false,
    defaultValue,
    ...(control === 'select' && choices.length > 0 ? { choices } : {}),
  };
}

function hasCatalogChoices(option: ReturnType<typeof catalogConfigOption>): boolean {
  return option.control !== 'select' || Boolean(option.choices && option.choices.length > 0);
}

function choiceDisplayName(option: SessionConfigOption, value: string): string {
  const found = flatChoices(option).find((choice) => String(choice.value) === value);
  return found?.name || `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function requestedModelId(
  turnConfig: Record<string, unknown>,
  options: SessionConfigOption[],
  models: CatalogModelCapability[],
): string | null {
  const modelOption = options.find((option) => configRole(option) === 'model');
  return nonEmptyString(turnConfig[modelOption?.id ?? 'model'])
    ?? (modelOption && typeof modelOption.currentValue === 'string' ? modelOption.currentValue : null)
    ?? models.find((model) => model.isDefault)?.model
    ?? null;
}

function catalogOptionsForModel(
  sessionOptions: SessionConfigOption[],
  models: CatalogModelCapability[],
  requestedModel: string | null,
) {
  const modelCap = requestedModel
    ? models.find((model) => model.model === requestedModel)
    : undefined;
  return sessionOptions.map((option) => {
    const mapped = catalogConfigOption(option);
    if (configRole(option) === 'model' && requestedModel) {
      return { ...mapped, defaultValue: requestedModel };
    }
    if (configRole(option) === 'effort' && modelCap) {
      const choices = modelCap.supportedThinking.map((value) => ({
        value,
        displayName: choiceDisplayName(option, value),
      }));
      const defaultValue = modelCap.defaultThinking
        && choices.some((choice) => Object.is(choice.value, modelCap.defaultThinking))
        ? modelCap.defaultThinking
        : (choices[0]?.value ?? null);
      return {
        ...mapped,
        defaultValue,
        ...(choices.length > 0 ? { choices } : {}),
      };
    }
    return mapped;
  }).filter(hasCatalogChoices);
}

function kimiInput(items: unknown[]) {
  return items.map((raw) => {
    const item = record(raw);
    switch (item.type) {
      case 'text':
        return { type: 'text' as const, text: String(item.text ?? '') };
      case 'localImage':
        return {
          type: 'localImage' as const,
          path: String(item.path ?? ''),
          ...(typeof item.mime === 'string' ? { mimeType: item.mime } : {}),
        };
      case 'localFile':
        return {
          type: 'localFile' as const,
          path: String(item.path ?? ''),
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          ...(typeof item.mime === 'string' ? { mimeType: item.mime } : {}),
          ...(typeof item.size === 'number' ? { size: item.size } : {}),
        };
      case 'skill':
        throw new KimiProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'Kimi Proxy does not advertise input.skill.',
        );
      default:
        throw new KimiProtocolError('INVALID_PARAMS', 'Unsupported input item.');
    }
  });
}

function contentText(update: Record<string, unknown>): string {
  const content = record(update.content);
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function activityStatus(value: unknown): 'running' | 'succeeded' | 'failed' {
  if (value === 'failed') return 'failed';
  if (value === 'completed') return 'succeeded';
  return 'running';
}

function planUpdatedData(update: Record<string, unknown>, sourceTurnId: string) {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  return {
    planId: `plan:${sourceTurnId}`,
    title: nonEmptyString(update.text) ?? 'Plan',
    steps: entries.map((raw, index) => {
      const entry = record(raw);
      const status = String(entry.status ?? 'pending');
      return {
        id: nonEmptyString(entry.id) ?? `step-${index + 1}`,
        text: String(entry.content ?? entry.title ?? ''),
        status: status === 'completed'
          ? 'completed' as const
          : status === 'in_progress' ? 'in_progress' as const
            : status === 'failed' ? 'failed' as const : 'pending' as const,
      };
    }).filter((step) => step.text.length > 0),
  };
}

function todoListToolData(update: Record<string, unknown>) {
  const meta = record(update._meta);
  const display = record(update.display ?? meta.display);
  const rawInput = record(update.rawInput);
  const todoItems = Array.isArray(rawInput.todos)
    ? rawInput.todos
    : display.kind === 'todo_list' && Array.isArray(display.items)
      ? display.items
      : [];
  const normalizedTitle = String(update.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const todoTool = Array.isArray(rawInput.todos)
    || normalizedTitle === 'todolist'
    || normalizedTitle === 'updating todo list'
    || display.kind === 'todo_list';
  return { todoItems, todoTool };
}

function todoListPlanData(
  update: Record<string, unknown>,
  sourceTurnId: string,
): ReturnType<typeof planUpdatedData> | null {
  const { todoItems, todoTool } = todoListToolData(update);
  if (!todoTool || todoItems.length === 0) return null;
  return planUpdatedData({
    text: 'Plan',
    entries: todoItems.map((raw, index) => {
      const item = record(raw);
      const status = String(item.status ?? 'pending');
      return {
        id: nonEmptyString(item.id) ?? `step-${index + 1}`,
        content: String(item.title ?? item.content ?? ''),
        status: status === 'done' ? 'completed' : status,
      };
    }),
  }, sourceTurnId);
}

/** ACP PermissionOption.kind closed set (gian.proxy/2.1 §2.2). */
const ACP_PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

function permissionOptionKind(value: unknown): string | null {
  return typeof value === 'string' && ACP_PERMISSION_KINDS.has(value) ? value : null;
}

/** Action style comes from the ACP permission kind — never guessed from the
 *  Provider's opaque optionId text. */
function actionStyleForKind(kind: string | null): 'primary' | 'secondary' | 'danger' {
  if (kind === 'reject_once' || kind === 'reject_always') return 'danger';
  if (kind === 'allow_once') return 'primary';
  return 'secondary';
}

export class KimiProtocolV2Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly closedAttaches = new Map<string, string>();
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly sourceTurnIds = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private readonly pendingUsageByTurn = new Map<string, Record<string, unknown>>();
  private readonly interruptedTurns = new Set<string>();
  private readonly interactions = new Map<string, InteractionRef>();
  private readonly interactionResponses = new Map<string, {
    interactionId: string;
    actionId: string;
    values: Record<string, unknown>;
  }>();
  private readonly openActivitiesByTurn = new Map<string, Set<string>>();
  private readonly openContentByTurn = new Map<string, Map<string, 'text' | 'reasoning' | 'status'>>();
  private readonly eventOccurrences = new Map<string, number>();
  private readonly degradedUpdateCounts = new Map<string, number>();
  private readonly planFingerprintByTurn = new Map<string, string>();
  private readonly replayBySession = new Map<string, ReplayState>();
  private readonly replayPager = new ReplayPager();
  private readonly ledger = new TurnLedger();
  private readonly resumeStore = new OpaqueSidechatResumeStore();
  private readonly sidechats = new Map<string, SidechatRecord>();
  private readonly terminalTurns = new Set<string>();
  private readonly terminalOrderBySession = new Map<string, string[]>();
  private readonly terminalSourceTurnIds = new Map<string, string>();
  private readonly forkResults = new Map<string, { fingerprint: string; result: unknown }>();
  private notificationQueue: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  private initialized = false;
  private catalogRevision = 'kimi-empty';

  constructor(
    private readonly service: KimiProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V2EventSink,
  ) {
    service.setEventSink((method, params) => this.translateEvent(method, params));
  }

  private emit(method: string, params: Record<string, unknown>): void {
    if (this.notificationQueue) {
      this.notificationQueue.push({ method, params });
      return;
    }
    this.emitEvent(method, params);
  }

  /**
   * Two-phase dispatch: notifications produced while a request is being
   * handled are queued, so the caller can write the JSON-RPC Response first
   * and flush the queued Notifications afterwards (contract §16: a mutating
   * request's success Response precedes the Notifications it produced).
   */
  async dispatch(request: WireRequest): Promise<
    | { ok: true; result: unknown; notifications: Array<{ method: string; params: Record<string, unknown> }> }
    | { ok: false; error: unknown; notifications: Array<{ method: string; params: Record<string, unknown> }> }
  > {
    const queue: Array<{ method: string; params: Record<string, unknown> }> = [];
    const previous = this.notificationQueue;
    this.notificationQueue = queue;
    try {
      const result = await this.route(request);
      return { ok: true, result, notifications: queue };
    } catch (error) {
      return { ok: false, error, notifications: queue };
    } finally {
      this.notificationQueue = previous;
    }
  }

  async handle(request: WireRequest): Promise<unknown> {
    const outcome = await this.dispatch(request);
    for (const notification of outcome.notifications) {
      this.emitEvent(notification.method, notification.params);
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  }

  private async route(request: WireRequest): Promise<unknown> {
    if (!this.initialized && request.method !== 'initialize' && request.method !== 'shutdown') {
      throw new KimiProtocolError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    switch (request.method) {
      case 'initialize': return this.initialize(request.params);
      case 'catalog.list': return this.catalog();
      case 'session.create': return this.createSession(request.params);
      case 'session.get': return { session: this.serialize(this.requireOrdinarySession(String(request.params.sessionId ?? ''))) };
      case 'sidechat.create': return this.createSidechat(request.params);
      case 'sidechat.resume': return this.resumeSidechat(request.params);
      case 'sidechat.close': return this.closeSidechat(request.params);
      case 'session.fork': return this.forkSession(request.params);
      case 'turn.start': return this.startTurn(request.params, request.id);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'interaction.respond': return this.respondInteraction(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'session.rename': return this.renameSession(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'catalog.resolve': return this.resolveCatalog(request.params);
      case 'session.native.delete':
      case 'turn.steer':
        throw new KimiProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          `${request.method} is not advertised by Kimi Proxy.`,
        );
      case 'shutdown': return { ok: true };
      default:
        throw new KimiProtocolError('METHOD_NOT_FOUND', `Unknown method "${request.method}".`);
    }
  }

  private initialize(params: Record<string, unknown>) {
    if (this.initialized) {
      throw new KimiProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.');
    }
    const protocol = record(params.protocol);
    const versions = Array.isArray(protocol.versions) ? protocol.versions.map(String) : [];
    if (protocol.name !== PROTOCOL_NAME || !versions.includes(PROTOCOL_V2)) {
      throw new KimiProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.1 is required.');
    }
    this.initialized = true;
    return {
      protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V2 },
      plugin: { id: 'kimi', name: 'Kimi Code', version: this.pluginVersion },
      process: { scope: 'shared' as const },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    const sessionOptions = capabilities.sessionOptions as SessionConfigOption[];
    return this.finishCatalog(sessionOptions.map(catalogConfigOption).filter(hasCatalogChoices));
  }

  private async resolveCatalog(params: Record<string, unknown>) {
    const catalogRevision = nonEmptyString(params.catalogRevision);
    if (!catalogRevision) throw new KimiProtocolError('INVALID_PARAMS', 'catalogRevision is required.');
    const sessionId = nonEmptyString(params.sessionId);
    const streamId = nonEmptyString(params.streamId);
    if ((sessionId === null) !== (streamId === null)) {
      throw new KimiProtocolError('INVALID_PARAMS', 'sessionId and streamId must be sent together.');
    }
    if (sessionId && streamId) this.requireOrdinaryAttached(sessionId, streamId);
    const sessionConfig = record(params.sessionConfig);
    if (Object.keys(sessionConfig).length > 0) {
      throw new KimiProtocolError(
        'CONFIG_BINDING_INVALID',
        'Kimi config options are turn-bound; send them in turnConfig, not sessionConfig.',
      );
    }
    const turnConfig = record(params.turnConfig);
    const capabilities = await this.service.listCapabilities();
    const sessionOptions = capabilities.sessionOptions as SessionConfigOption[];
    const models = capabilities.models as CatalogModelCapability[];
    const requestedModel = requestedModelId(turnConfig, sessionOptions, models);
    this.validateTurnConfig(turnConfig, sessionOptions, models, requestedModel);
    const configOptions = catalogOptionsForModel(sessionOptions, models, requestedModel);
    const payload = await this.finishCatalog(configOptions);
    const resolvedDefaults: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } = {
      sessionConfig: {},
      turnConfig: {},
    };
    for (const option of configOptions) {
      if (turnConfig[option.id] !== undefined) continue;
      if (!isConfigValue(option.defaultValue) || option.defaultValue === null) continue;
      resolvedDefaults.turnConfig[option.id] = option.defaultValue;
    }
    return { ...payload, resolvedDefaults };
  }

  private async finishCatalog(
    configOptions: Array<ReturnType<typeof catalogConfigOption>>,
  ) {
    const optionId = (role: 'model' | 'effort' | 'approval_mode') => (
      configOptions.find((option) => option.role === role)?.id
    );
    const specialCatalogs = {
      ...(optionId('model') ? { model: optionId('model') } : {}),
      ...(optionId('effort') ? { thinking: optionId('effort') } : {}),
      ...(optionId('approval_mode') ? { approvalMode: optionId('approval_mode') } : {}),
    };
    const emittedOptions = configOptions.map(({ role: _role, ...option }) => option);
    const slashCommands = [] as Array<{
      name: string;
      description: string;
      source: 'builtin';
      argHints: Array<{ kind: 'free'; placeholder: string }>;
    }>;
    const attached = this.sessions.values().next().value as AttachedSession | undefined;
    if (attached) {
      try {
        const listed = await this.service.listSlashCommands({ sessionId: attached.serviceSessionId });
        for (const command of listed.commands) {
          slashCommands.push({
            name: command.name.startsWith('/') ? command.name : `/${command.name}`,
            description: command.description ?? '',
            source: 'builtin',
            argHints: command.input?.hint
              ? [{ kind: 'free', placeholder: command.input.hint }]
              : [],
          });
        }
      } catch {
        /* catalog remains valid without session commands */
      }
    }
    const payload = {
      catalogRevision: '',
      input: [
        { type: 'text' as const },
        { type: 'localFile' as const },
        { type: 'localImage' as const },
      ],
      configOptions: emittedOptions,
      specialCatalogs,
      actions: [
        {
          id: 'sidechat.create',
          supported: this.service.supportsFork(),
          ...(this.service.supportsFork() ? {} : { reason: 'Current Kimi ACP runtime does not support session/fork.' }),
        },
        {
          id: 'session.fork',
          supported: this.service.supportsFork(),
          ...(this.service.supportsFork() ? {} : { reason: 'Current Kimi ACP runtime does not support session/fork.' }),
        },
        { id: 'session.fork.atTurn', supported: false, reason: 'Kimi ACP only forks the current head.' },
      ],
      slashCommands,
    };
    payload.catalogRevision = stableId('catalog', {
      input: payload.input,
      configOptions: emittedOptions,
      specialCatalogs,
      actions: payload.actions,
      slashCommands,
    });
    this.catalogRevision = payload.catalogRevision;
    return payload;
  }

  /** Recompute the process catalog and emit a catalog.changed hint carrying
   *  the fresh revision. The revision must never be stale: a Host comparing
   *  revisions would otherwise skip the refetch and miss new slash commands. */
  private async refreshCatalog(reason: string): Promise<void> {
    let revision: string | undefined;
    try {
      revision = (await this.catalog()).catalogRevision;
    } catch {
      revision = undefined; // still invalidate; the Host must refetch
    }
    this.emit('catalog.changed', {
      eventId: randomUUID(),
      emittedAt: new Date().toISOString(),
      data: { reason, ...(revision ? { revision } : {}) },
    });
  }

  private advertisedOptionIds(options: SessionConfigOption[]): Set<string> {
    return new Set(options.map((option) => option.id));
  }

  private async applyConfigMap(
    serviceSessionId: string,
    config: Record<string, unknown>,
    advertised: Set<string>,
    modelConfigId?: string,
  ) {
    let last = null as Awaited<ReturnType<KimiProxyService['setConfigOption']>> | null;
    const entries = Object.entries(config).filter(([, value]) => value !== null);
    if (modelConfigId) {
      entries.sort(([left], [right]) => {
        if (left === modelConfigId) return -1;
        if (right === modelConfigId) return 1;
        return 0;
      });
    }
    for (const [configId, value] of entries) {
      if (!advertised.has(configId)) {
        throw new KimiProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
      }
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new KimiProtocolError(
          'CONFIG_VALUE_INVALID',
          `Kimi config ${configId} must be string or boolean.`,
        );
      }
      last = await this.service.setConfigOption({
        sessionId: serviceSessionId,
        configId,
        value,
      });
    }
    return last;
  }

  /** Pure validation of a turn.start config snapshot against the session's
   *  ACP configOptions. Runs before any fingerprint is recorded or any native
   *  `session/set_config_option` call, so an invalid snapshot is a clean
   *  request-scoped failure with no Provider side effects. */
  private validateTurnConfig(
    config: Record<string, unknown>,
    options: SessionConfigOption[],
    models: CatalogModelCapability[] = [],
    requestedModel: string | null = null,
  ): void {
    const modelCap = requestedModel
      ? models.find((model) => model.model === requestedModel)
      : undefined;
    for (const [configId, value] of Object.entries(config)) {
      const option = options.find((candidate) => candidate.id === configId);
      if (!option) {
        throw new KimiProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
      }
      if (!isConfigValue(value)) {
        throw new KimiProtocolError(
          'CONFIG_VALUE_INVALID',
          `Kimi config ${configId} must be a string, number, boolean, or null.`,
        );
      }
      if (value === null) continue;
      if (option.type === 'boolean') {
        if (typeof value !== 'boolean') {
          throw new KimiProtocolError(
            'CONFIG_VALUE_INVALID',
            `Kimi config ${configId} expects a boolean value.`,
          );
        }
        continue;
      }
      if (option.type === 'select') {
        const choices = configRole(option) === 'effort' && modelCap && modelCap.supportedThinking.length > 0
          ? modelCap.supportedThinking
          : flatChoices(option).map((choice) => choice.value);
        if (!choices.some((choice) => Object.is(choice, value))) {
          throw new KimiProtocolError(
            'CONFIG_VALUE_INVALID',
            `Kimi config ${configId} must be one of its advertised choices.`,
          );
        }
        continue;
      }
      throw new KimiProtocolError(
        'CONFIG_VALUE_INVALID',
        `Kimi config ${configId} has an unsupported control type.`,
      );
    }
  }

  /** Session snapshot fields replacing the turn-bound catalog subset for this
   *  session (contract §9.4). Omitted entirely when the native session did
   *  not publish options, so the process-level catalog stays in effect. */
  private turnConfigFields(options: SessionConfigOption[]): {
    turnConfigOptions?: Array<Record<string, unknown>>;
    turnConfigRevision?: string;
  } {
    const mapped = options
      .map(catalogConfigOption)
      .filter((option) => option.control !== 'select' || (option.choices && option.choices.length > 0))
      .map(({ role: _role, ...option }) => option);
    if (mapped.length === 0) return {};
    return {
      turnConfigOptions: mapped,
      turnConfigRevision: stableId('turn-config', mapped),
    };
  }

  private async createSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    if (!sessionId) throw new KimiProtocolError('INVALID_PARAMS', 'sessionId is required.');
    const workspace = record(params.workspace);
    const cwd = nonEmptyString(workspace.cwd);
    if (!cwd) throw new KimiProtocolError('INVALID_PARAMS', 'workspace.cwd is required.');
    const roots = Array.isArray(workspace.roots) ? workspace.roots.filter((item) => typeof item === 'string') : [];
    if (roots.length === 0) {
      throw new KimiProtocolError('INVALID_PARAMS', 'workspace.roots must contain at least one path.');
    }
    if (params.hostServices !== undefined) {
      throw new KimiProtocolError(
        'CAPABILITY_NOT_SUPPORTED',
        'Kimi Proxy does not advertise integration.mcp.streamableHttp.',
      );
    }
    const native = record(params.nativeSession);
    const nativeSessionId = nonEmptyString(native.id);
    const historyValue = native.history;
    let history: 'none' | 'replay' = 'none';
    if (historyValue !== undefined) {
      if (!nativeSessionId) {
        throw new KimiProtocolError('INVALID_PARAMS', 'nativeSession.history requires nativeSession.id.');
      }
      if (historyValue !== 'none' && historyValue !== 'replay') {
        throw new KimiProtocolError('INVALID_PARAMS', 'nativeSession.history must be "none" or "replay".');
      }
      history = historyValue;
    }
    const config = record(params.config);
    // Every advertised Kimi option is turn-bound (ACP applies
    // `session/set_config_option` between prompts), so a session-bound config
    // snapshot is always a binding violation. Reject before any native
    // session is created: invalid config must not cause Provider side effects.
    if (Object.keys(config).length > 0) {
      throw new KimiProtocolError(
        'CONFIG_BINDING_INVALID',
        'Kimi config options are turn-bound; send them in turn.start config, not session.create.',
      );
    }
    const fingerprint = JSON.stringify({ cwd, roots, nativeSessionId, history });
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.sidechats.has(sessionId)) {
        throw new KimiProtocolError('SESSION_NOT_FOUND', 'Session not found.');
      }
      if (existing.createFingerprint !== fingerprint) {
        throw new KimiProtocolError(
          'CONFLICT',
          `Session ${sessionId} already exists with a different create payload.`,
        );
      }
      return { session: this.serialize(existing) };
    }
    const result = await this.service.createSession({
      cwd,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(nativeSessionId
        ? { resumeMode: history === 'replay' ? 'load' as const : 'resume' as const }
        : {}),
      mcpServers: [],
    });
    const serviceSession = result.session;
    const replay = this.buildReplay(
      sessionId,
      serviceSession.nativeSessionId,
      serviceSession.updatedAt,
      result.replayUpdates as SessionNotification[],
    );
    const session: AttachedSession = {
      id: sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.nativeSessionId,
      streamId: randomUUID(),
      cwd,
      state: serviceSession.status === 'needs-approval' ? 'waiting_interaction' : 'idle',
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      configOptions: [...serviceSession.configOptions],
      sessionConfig: {},
      createFingerprint: fingerprint,
      turnOrdinal: replay.turnCount,
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    this.replayBySession.set(session.id, replay);
    void this.publishCatalogIfCommandsArrive(session);
    return { session: this.serialize(session) };
  }

  private async createSidechat(params: Record<string, unknown>) {
    this.assertForkSupported();
    const parentSessionId = nonEmptyString(params.parentSessionId);
    const parentStreamId = nonEmptyString(params.parentStreamId);
    const sidechatId = nonEmptyString(params.sidechatId);
    if (!parentSessionId || !parentStreamId || !sidechatId) {
      throw new KimiProtocolError('INVALID_PARAMS', 'parentSessionId, parentStreamId, and sidechatId are required.');
    }
    const parent = this.requireOrdinaryAttached(parentSessionId, parentStreamId);
    const fingerprint = JSON.stringify({ parentSessionId, parentStreamId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw new KimiProtocolError('CONFLICT', 'sidechatId was reused with a different parent.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new KimiProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
    }
    const anchor = this.sidechatAnchor(parent);
    const forked = await this.service.forkSession({ sessionId: parent.serviceSessionId });
    const session = this.attachForkedSession(sidechatId, parent, forked.session as ServiceSessionShape);
    const createdAt = new Date().toISOString();
    const resumeRef = this.resumeStore.seal({
      sidechatId,
      parentSessionId,
      nativeSessionId: session.nativeSessionId,
      anchor,
      sessionConfig: session.sessionConfig,
      createdAt,
    });
    const sidechat: SidechatRecord = {
      parentSessionId,
      resumeRefId: resumeRef.id,
      anchor,
      createFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, sidechat);
    return { sidechat: this.serializeSidechat(session, sidechat, createdAt) };
  }

  private async resumeSidechat(params: Record<string, unknown>) {
    this.assertForkSupported();
    const sidechatId = nonEmptyString(params.sidechatId);
    const parentSessionId = nonEmptyString(params.parentSessionId);
    const resumeRefId = nonEmptyString(record(params.resumeRef).id);
    if (!sidechatId || !parentSessionId || !resumeRefId) {
      throw new KimiProtocolError('INVALID_PARAMS', 'sidechatId, parentSessionId, and resumeRef are required.');
    }
    if (this.resumeStore.closed(resumeRefId)) {
      throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat was already closed.');
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (!payload) throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat resume reference is unavailable.');
    if (payload.sidechatId !== sidechatId || payload.parentSessionId !== parentSessionId) {
      throw new KimiProtocolError('CONFLICT', 'Side Chat resume identity does not match.');
    }
    const parent = this.requireOrdinarySession(parentSessionId);
    const fingerprint = JSON.stringify({ parentSessionId, resumeRefId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.resumeFingerprint !== fingerprint) {
        throw new KimiProtocolError('CONFLICT', 'Side Chat is already attached with another resume reference.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing, payload.createdAt) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new KimiProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
    }
    const resumed = await this.service.createSession({
      cwd: parent.cwd,
      nativeSessionId: payload.nativeSessionId,
      resumeMode: 'resume',
      mcpServers: [],
    });
    const session = this.attachForkedSession(
      sidechatId,
      parent,
      resumed.session as ServiceSessionShape,
      payload.sessionConfig,
    );
    const sidechat: SidechatRecord = {
      parentSessionId,
      resumeRefId,
      anchor: payload.anchor as SidechatAnchor,
      resumeFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, sidechat);
    return { sidechat: this.serializeSidechat(session, sidechat, payload.createdAt) };
  }

  private async closeSidechat(params: Record<string, unknown>) {
    const sidechatId = nonEmptyString(params.sidechatId);
    const resumeRefId = nonEmptyString(record(params.resumeRef).id);
    const streamId = params.streamId === undefined ? null : nonEmptyString(params.streamId);
    if (!sidechatId || !resumeRefId || (params.streamId !== undefined && !streamId)) {
      throw new KimiProtocolError('INVALID_PARAMS', 'sidechatId and resumeRef are required; streamId must be non-empty.');
    }
    const closed = this.resumeStore.closed(resumeRefId);
    if (closed) {
      return {
        ok: true as const,
        sidechatId,
        providerDataDeleted: closed.sidechatId === sidechatId ? closed.providerDataDeleted : false,
      };
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (payload && payload.sidechatId !== sidechatId) {
      throw new KimiProtocolError('CONFLICT', 'resumeRef belongs to another live Side Chat.');
    }
    const live = this.sidechats.get(sidechatId);
    if (live && live.resumeRefId !== resumeRefId) {
      throw new KimiProtocolError('CONFLICT', 'resumeRef belongs to another Side Chat attachment.');
    }
    if (live) {
      const session = this.requireSession(sidechatId);
      if (streamId && session.streamId !== streamId) {
        throw new KimiProtocolError('SESSION_STALE', 'Side Chat stream is stale.');
      }
      await this.detachSession(session, false);
      this.sidechats.delete(sidechatId);
    }
    // Kimi's current ACP delete method is unstable. Gian invalidates its own
    // encrypted ref durably and reports that Provider history may remain.
    const providerDataDeleted = false;
    this.resumeStore.rememberClosed(resumeRefId, { sidechatId, providerDataDeleted });
    return { ok: true as const, sidechatId, providerDataDeleted };
  }

  private async forkSession(params: Record<string, unknown>) {
    this.assertForkSupported();
    const sourceSessionId = nonEmptyString(params.sourceSessionId);
    const sourceStreamId = nonEmptyString(params.sourceStreamId);
    const sessionId = nonEmptyString(params.sessionId);
    const anchor = record(params.anchor);
    if (!sourceSessionId || !sourceStreamId || !sessionId || anchor.type !== 'head') {
      throw new KimiProtocolError(
        anchor.type === 'turn' ? 'CAPABILITY_NOT_SUPPORTED' : 'INVALID_PARAMS',
        anchor.type === 'turn' ? 'Kimi ACP does not support exact turn forks.' : 'A head fork anchor is required.',
      );
    }
    const fingerprint = JSON.stringify({ sourceSessionId, sourceStreamId, anchor });
    const previous = this.forkResults.get(sessionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new KimiProtocolError('CONFLICT', 'Fork sessionId was reused with another source boundary.');
      }
      return previous.result;
    }
    if (this.sessions.has(sessionId)) {
      throw new KimiProtocolError('CONFLICT', 'Fork sessionId already belongs to another Session.');
    }
    const source = this.requireOrdinaryAttached(sourceSessionId, sourceStreamId);
    const boundary = this.forkBoundary(source);
    const forked = await this.service.forkSession({ sessionId: source.serviceSessionId });
    const child = this.attachForkedSession(sessionId, source, forked.session as ServiceSessionShape);
    this.replayBySession.set(child.id, this.cloneReplay(source, child));
    const result = {
      session: this.serialize(child),
      origin: {
        kind: 'fork' as const,
        sessionId: source.id,
        turnId: boundary.turnId,
        sourceTurnId: boundary.sourceTurnId,
      },
    };
    this.forkResults.set(sessionId, { fingerprint, result });
    return result;
  }

  private assertForkSupported(): void {
    if (!this.service.supportsFork()) {
      throw new KimiProtocolError('CAPABILITY_NOT_SUPPORTED', 'Current Kimi ACP runtime does not support session/fork.');
    }
  }

  private attachForkedSession(
    id: string,
    parent: AttachedSession,
    serviceSession: ServiceSessionShape,
    sessionConfig: Record<string, ConfigValue> = parent.sessionConfig,
  ): AttachedSession {
    const session: AttachedSession = {
      id,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.nativeSessionId,
      streamId: randomUUID(),
      cwd: parent.cwd,
      state: serviceSession.status === 'needs-approval' ? 'waiting_interaction' : 'idle',
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      configOptions: [...serviceSession.configOptions],
      sessionConfig: { ...sessionConfig },
      createFingerprint: `fork:${serviceSession.nativeSessionId}`,
      turnOrdinal: this.replayBySession.get(parent.id)?.turnCount ?? parent.turnOrdinal,
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    return session;
  }

  private cloneReplay(source: AttachedSession, child: AttachedSession): ReplayState {
    const parent = this.replayBySession.get(source.id) ?? {
      streamId: stableId('replay', source.nativeSessionId),
      events: [],
      turnCount: 0,
    };
    const streamId = stableId('replay', child.nativeSessionId);
    return {
      streamId,
      turnCount: parent.turnCount,
      events: parent.events.map((event) => ({
        ...event,
        sessionId: child.id,
        replayStreamId: streamId,
      })),
    };
  }

  private sidechatAnchor(session: AttachedSession): SidechatAnchor {
    if (this.activeTurnBySession.has(session.id)) {
      throw new KimiProtocolError('SESSION_BUSY', 'Side Chat requires an idle parent Session.');
    }
    const boundary = this.latestTerminalBoundary(session.id);
    if (boundary) return { type: 'turn', ...boundary };
    if ((this.replayBySession.get(session.id)?.events.length ?? 0) === 0) return { type: 'empty' };
    throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'No stable terminal Turn is available in this attach generation.');
  }

  private forkBoundary(session: AttachedSession): { turnId: string; sourceTurnId: string } {
    if (this.activeTurnBySession.has(session.id)) {
      throw new KimiProtocolError('SESSION_BUSY', 'Fork requires an idle source Session.');
    }
    const boundary = this.latestTerminalBoundary(session.id);
    if (!boundary) throw new KimiProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'Fork requires a terminal Turn.');
    return boundary;
  }

  private latestTerminalBoundary(sessionId: string): { turnId: string; sourceTurnId: string } | null {
    const turns = this.terminalOrderBySession.get(sessionId) ?? [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turnId = turns[index]!;
      const sourceTurnId = this.terminalSourceTurnIds.get(this.turnKey(sessionId, turnId));
      if (sourceTurnId) return { turnId, sourceTurnId };
    }
    return null;
  }

  private availableActions(session: AttachedSession) {
    const busy = this.activeTurnBySession.has(session.id) || session.state !== 'idle';
    const boundary = this.latestTerminalBoundary(session.id);
    const historyEmpty = (this.replayBySession.get(session.id)?.events.length ?? 0) === 0;
    const reason = busy
      ? 'Wait for the active turn to finish.'
      : 'No stable terminal turn is available in this attach generation.';
    return {
      'sidechat.create': {
        enabled: !busy && (boundary !== null || historyEmpty),
        ...(!busy && (boundary !== null || historyEmpty) ? {} : { reason }),
      },
      'session.fork': {
        enabled: !busy && boundary !== null,
        ...(!busy && boundary !== null ? {} : { reason }),
      },
    };
  }

  private serializeSidechat(session: AttachedSession, sidechat: SidechatRecord, createdAt = session.createdAt) {
    return {
      id: session.id,
      parentSessionId: sidechat.parentSessionId,
      streamId: session.streamId,
      state: session.state,
      resumeRef: { id: sidechat.resumeRefId },
      anchor: sidechat.anchor,
      sessionConfig: session.sessionConfig,
      ...this.turnConfigFields(session.configOptions),
      lastError: session.lastError,
      createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private async publishCatalogIfCommandsArrive(session: AttachedSession): Promise<void> {
    try {
      const listed = await this.service.listSlashCommands({ sessionId: session.serviceSessionId });
      if (listed.commands.length === 0) return;
      await this.refreshCatalog('available-commands');
    } catch {
      /* slash discovery is optional */
    }
  }

  private async startTurn(params: Record<string, unknown>, requestId: string) {
    const sessionId = String(params.sessionId ?? '');
    const streamId = String(params.streamId ?? '');
    const turnId = nonEmptyString(params.turnId);
    if (!turnId) throw new KimiProtocolError('INVALID_PARAMS', 'turnId is required.');
    const session = this.requireAttached(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new KimiProtocolError('INVALID_PARAMS', 'input is required.');
    const config = record(params.config);
    // Validate the full snapshot before recording the idempotency fingerprint
    // or touching the native session. Thinking choices are per-model, so the
    // requested model (not the create-time snapshot) is authoritative.
    const capabilities = await this.service.listCapabilities();
    const models = capabilities.models as CatalogModelCapability[];
    const requestedModel = requestedModelId(config, session.configOptions, models);
    this.validateTurnConfig(config, session.configOptions, models, requestedModel);
    const accepted = this.ledger.accept({ sessionId, streamId, turnId, input, config });
    if (accepted === 'duplicate') return { accepted: true as const, turnId };
    if (this.activeTurnBySession.has(session.id)) {
      this.ledger.forget({ sessionId, streamId, turnId });
      throw new KimiProtocolError('SESSION_BUSY', 'Session already has an active turn.');
    }
    const key = this.turnKey(session.id, turnId);
    this.sourceTurnIds.set(key, this.deriveSourceTurnId(session, input));
    this.turnsByRequest.set(requestId, { sessionId: session.id, turnId });
    this.requestByTurn.set(key, requestId);
    this.activeTurnBySession.set(session.id, turnId);
    this.openActivitiesByTurn.set(key, new Set());
    this.openContentByTurn.set(key, new Map());
    try {
      const advertised = this.advertisedOptionIds(session.configOptions);
      const modelOption = session.configOptions.find((option) => configRole(option) === 'model');
      const applied = await this.applyConfigMap(
        session.serviceSessionId,
        config,
        advertised,
        modelOption?.id,
      );
      if (applied) {
        session.configOptions = [...applied.configOptions];
      }
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: kimiInput(input),
      }, requestId);
      return { accepted: true as const, turnId };
    } catch (error) {
      this.ledger.forget({ sessionId, streamId, turnId });
      this.clearTurn(session.id, turnId);
      throw standardError(error);
    }
  }

  /** Kimi ACP has no native turn ID, so derive one deterministically from
   *  immutable fields (contract §17): the native session, the turn's ordinal
   *  within that native session (history turns included), and the user text.
   *  The same derivation runs for replayed history, so a turn executed live
   *  keeps its sourceTurnId when a later attach replays it. */
  private deriveSourceTurnId(session: AttachedSession, input: unknown[]): string {
    const userText = input
      .map((item) => record(item))
      .filter((item) => item.type === 'text')
      .map((item) => String(item.text ?? ''))
      .join('');
    const sourceTurnId = stableId('kimi-turn', {
      nativeSessionId: session.nativeSessionId,
      turnIndex: session.turnOrdinal,
      userText,
    });
    session.turnOrdinal += 1;
    return sourceTurnId;
  }

  private async interruptTurn(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    // Mark before forwarding so a promptly resolving native `cancelled` maps
    // to `interrupted`; roll back if the runtime rejects the interrupt, so a
    // failed interrupt can never produce a terminal `interrupted` stopReason.
    const key = this.turnKey(session.id, turnId);
    this.interruptedTurns.add(key);
    try {
      await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    } catch (error) {
      this.interruptedTurns.delete(key);
      throw standardError(error);
    }
    this.resolveInteractionsForTurn(session, turnId, 'cancelled');
    return { accepted: true as const, turnId };
  }

  private async respondInteraction(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    const interactionId = nonEmptyString(params.interactionId);
    const responseId = nonEmptyString(params.responseId);
    const actionId = nonEmptyString(params.actionId);
    if (!interactionId || !responseId || !actionId) {
      throw new KimiProtocolError('INVALID_PARAMS', 'interactionId, responseId, and actionId are required.');
    }
    const values = record(params.values);
    // responseId idempotency outlives the interaction itself: a duplicate
    // respond arriving after resolution still returns the first result.
    const responseKey = `${this.turnKey(session.id, turnId)}${responseId}`;
    const previous = this.interactionResponses.get(responseKey);
    if (previous) {
      if (
        previous.interactionId !== interactionId
        || previous.actionId !== actionId
        || JSON.stringify(previous.values) !== JSON.stringify(values)
      ) {
        throw new KimiProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return { accepted: true as const, interactionId, responseId };
    }
    this.requireActiveTurn(session.id, turnId);
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.sessionId !== session.id || interaction.turnId !== turnId) {
      throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'Interaction not found.');
    }
    if (!interaction.actionIds.includes(actionId)) {
      throw new KimiProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Interaction action is not available.');
    }
    for (const [inputId, value] of Object.entries(values)) {
      if (!interaction.inputIds.includes(inputId)) {
        throw new KimiProtocolError(
          'INVALID_PARAMS',
          `Interaction ${interactionId} did not declare input ${inputId}.`,
        );
      }
      const valid = typeof value === 'string'
        || typeof value === 'boolean'
        || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      if (!valid) {
        throw new KimiProtocolError('INVALID_PARAMS', `Invalid value for interaction input ${inputId}.`);
      }
    }
    this.interactionResponses.set(responseKey, { interactionId, actionId, values });
    interaction.responses.set(responseId, { actionId, values });
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: interaction.serviceApprovalId,
        nativeOptionId: actionId,
      });
    } catch (error) {
      this.interactionResponses.delete(responseKey);
      interaction.responses.delete(responseId);
      throw standardError(error);
    }
    return { accepted: true as const, interactionId, responseId };
  }

  private async renameSession(params: Record<string, unknown>) {
    this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const name = typeof params.name === 'string' ? params.name : '';
    if ([...name].length > 200) {
      throw new KimiProtocolError('INVALID_PARAMS', 'Session name must not exceed 200 Unicode code points.');
    }
    return { ok: true as const };
  }

  private async closeSession(params: Record<string, unknown>) {
    const sessionId = String(params.sessionId ?? '');
    const streamId = String(params.streamId ?? '');
    const closedStreamId = this.closedAttaches.get(sessionId);
    if (closedStreamId !== undefined) {
      // Closing the same attach twice is idempotent; a stale stream is not.
      if (closedStreamId === streamId) return { ok: true as const };
      throw new KimiProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    const session = this.requireOrdinaryAttached(sessionId, streamId);
    return this.detachSession(session, true);
  }

  private async detachSession(session: AttachedSession, rememberClosed: boolean) {
    const activeTurn = this.activeTurnBySession.get(session.id);
    if (activeTurn) {
      this.resolveInteractionsForTurn(session, activeTurn, 'turn_ended');
      this.closeOpenWork(session, activeTurn, 'cancelled');
      this.emitTurnEvent('turn.completed', session, activeTurn, { stopReason: 'cancelled' });
      this.clearTurn(session.id, activeTurn);
    }
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    this.ledger.close(session.id);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    this.replayBySession.delete(session.id);
    this.replayPager.close(session.id);
    this.terminalOrderBySession.delete(session.id);
    for (const key of this.terminalTurns) {
      if (!key.startsWith(`${session.id}\u0000`)) continue;
      this.terminalTurns.delete(key);
      this.terminalSourceTurnIds.delete(key);
    }
    if (rememberClosed) {
      this.closedAttaches.set(session.id, session.streamId);
      if (this.closedAttaches.size > 200) {
        const oldest = this.closedAttaches.keys().next().value;
        if (oldest !== undefined) this.closedAttaches.delete(oldest);
      }
    }
    return { ok: true as const };
  }

  private async listNative(params: Record<string, unknown>) {
    const result = await this.service.listNativeSessions({
      ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
      ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
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
      sessions: (result.sessions ?? []).flatMap((item) => item.sessionId ? [{
        id: item.sessionId,
        ...(item.title !== undefined ? { displayName: item.title } : {}),
        ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
        ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
      }] : []),
      nextCursor: result.nextCursor ?? null,
    };
  }

  private replay(params: Record<string, unknown>) {
    this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const replay = this.replayBySession.get(String(params.sessionId ?? ''))
      ?? { streamId: stableId('replay', params.sessionId), events: [], turnCount: 0 };
    const rawLimit = params.limit;
    const limit = rawLimit === undefined ? 100 : rawLimit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new KimiProtocolError('INVALID_PARAMS', 'limit must be a positive integer up to 500.');
    }
    if (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== 'string') {
      throw new KimiProtocolError('INVALID_PARAMS', 'cursor must be a string or null.');
    }
    return this.replayPager.page(
      String(params.sessionId ?? ''),
      replay,
      params.cursor === null || typeof params.cursor === 'string' ? params.cursor : null,
      limit,
    );
  }

  private translateEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'runtime.stopped') {
      const data = record(params.data);
      if (data.expected === true) return;
      const message = String(data.error ?? 'Kimi ACP process stopped unexpectedly.');
      // The shared runtime died: every attached session loses its native
      // stream until the next request lazily resumes it. Mirror that fact.
      for (const session of this.sessions.values()) {
        this.updateSession(session, { state: 'stale', lastError: message });
        this.emitSessionEvent('session.updated', session, {
          state: 'stale',
          lastError: message,
          updatedAt: session.updatedAt,
        });
      }
      this.emit('runtime.error', {
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        data: {
          domainCode: 'RUNTIME_ERROR',
          message,
          retryable: true,
          details: jsonValue(data),
        },
      });
      return;
    }
    const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
    if (!session) return;
    const data = record(params.data);
    const requestRef = this.turnsByRequest.get(String(params.requestId ?? ''));
    const interactionRef = method === 'approval.resolved'
      ? this.interactions.get(String(data.approvalId ?? ''))
      : undefined;
    const turnId = requestRef?.turnId
      ?? interactionRef?.turnId
      ?? this.activeTurnBySession.get(session.id);

    switch (method) {
      case 'turn.started':
        if (!turnId || this.startedTurns.has(this.turnKey(session.id, turnId))) return;
        this.startedTurns.add(this.turnKey(session.id, turnId));
        this.updateSession(session, { state: 'running', lastError: null });
        this.emitTurnEvent('turn.started', session, turnId, {});
        {
          const key = this.turnKey(session.id, turnId);
          const pendingUsage = this.pendingUsageByTurn.get(key);
          if (pendingUsage) {
            this.pendingUsageByTurn.delete(key);
            this.emitTurnEvent('usage.updated', session, turnId, pendingUsage);
          }
        }
        return;
      case 'acp.sessionUpdate':
        this.translateAcpUpdate(
          session,
          turnId && this.startedTurns.has(this.turnKey(session.id, turnId))
            ? turnId
            : undefined,
          record(data.update),
        );
        return;
      case 'token_usage.updated': {
        const usage: Record<string, unknown> = {};
        if (data.context !== undefined) usage.context = data.context;
        if (data.conversation !== undefined) usage.conversation = data.conversation;
        if (usage.context === undefined && usage.conversation === undefined) return;
        if (turnId) {
          const key = this.turnKey(session.id, turnId);
          if (!this.startedTurns.has(key)) this.pendingUsageByTurn.set(key, usage);
          else this.emitTurnEvent('usage.updated', session, turnId, usage);
        }
        else this.emitSessionEvent('usage.updated', session, usage);
        return;
      }
      case 'approval.requested': {
        if (!turnId) return;
        const interactionId = nonEmptyString(data.approvalId);
        if (!interactionId) return;
        const payload = record(data.payload);
        const toolCall = record(payload.toolCall);
        const nativeOptions = Array.isArray(data.nativeOptions) ? data.nativeOptions : [];
        const permissionOptionKinds: Record<string, string> = {};
        const actions = nativeOptions.flatMap((raw) => {
          const option = record(raw);
          const id = nonEmptyString(option.optionId) ?? nonEmptyString(option.id);
          if (!id) return [];
          const kind = permissionOptionKind(option.kind);
          if (kind) permissionOptionKinds[id] = kind;
          return [{
            id,
            label: String(option.name ?? option.label ?? id),
            style: actionStyleForKind(kind),
          }];
        });
        if (actions.length === 0) {
          // The runtime asked but offered no usable native option IDs, so no
          // honest interaction card exists. Surface a diagnosable notice and
          // cancel the native request instead of hanging the turn.
          this.emitTurnEvent('activity.updated', session, turnId, {
            activityId: stableId('acp-permission', { interactionId }),
            kind: 'permission_unusable',
            title: 'Kimi permission request could not be relayed',
            status: 'cancelled',
            presentation: {
              type: 'notice',
              data: {
                message: 'Kimi requested a decision without usable options; the request was auto-cancelled.',
              },
            },
          });
          void this.service.respondApproval({
            sessionId: session.serviceSessionId,
            approvalId: interactionId,
          }).catch(() => undefined);
          return;
        }
        this.interactions.set(interactionId, {
          sessionId: session.id,
          turnId,
          serviceApprovalId: interactionId,
          inputIds: [],
          actionIds: actions.map((action) => action.id),
          responses: new Map(),
        });
        this.updateSession(session, { state: 'waiting_interaction' });
        const title = String(toolCall.title ?? data.title ?? 'Kimi permission');
        const kind = title === 'AskUserQuestion'
          ? 'question'
          : title === 'ExitPlanMode' ? 'confirmation' : 'permission';
        this.emitTurnEvent('interaction.requested', session, turnId, {
          interactionId,
          title,
          description: String(data.reason ?? data.title ?? ''),
          presentation: { kind, tone: kind === 'permission' ? 'warning' : 'neutral' },
          inputs: [],
          actions,
          ...(payload.toolCall !== undefined || Object.keys(permissionOptionKinds).length > 0
            ? {
              context: {
                ...(payload.toolCall !== undefined ? { subject: jsonValue(payload.toolCall) } : {}),
                // Schema-valid context extension (gian.proxy/2.1): the ACP
                // PermissionOption.kind per native optionId. Older Hosts
                // ignore it; strict interaction.resolved is untouched.
                ...(Object.keys(permissionOptionKinds).length > 0
                  ? { permissionOptionKinds }
                  : {}),
              },
            }
            : {}),
        });
        return;
      }
      case 'approval.resolved': {
        if (!turnId || !interactionRef) return;
        this.interactions.delete(String(data.approvalId ?? ''));
        const submitted = interactionRef.responses.size > 0;
        const last = [...interactionRef.responses.values()].at(-1);
        this.updateSession(session, { state: 'running' });
        this.emitTurnEvent('interaction.resolved', session, turnId, submitted && last
          ? {
            interactionId: String(data.approvalId ?? ''),
            outcome: 'submitted',
            actionId: last.actionId,
          }
          : {
            interactionId: String(data.approvalId ?? ''),
            outcome: 'cancelled',
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
      this.emitSessionEvent('session.updated', session, {
        ...this.turnConfigFields(session.configOptions),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (kind === 'available_commands_update') {
      // Process-level invalidation hint with a freshly recomputed revision.
      void this.refreshCatalog('available-commands');
      return;
    }
    if (kind === 'user_message_chunk') {
      // Echo of input Gian already persisted at Action time; replay covers
      // provider-native user input via input.recorded. Never re-emit live.
      return;
    }
    if (!turnId) return;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = contentText(update);
      if (!text) return;
      const contentKind = kind === 'agent_thought_chunk' ? 'reasoning' as const : 'text' as const;
      // One content stream per kind per native turn, derived from the stable
      // sourceTurnId, so a replayed turn reuses the same contentId.
      const contentId = nonEmptyString(record(update._meta).itemId)
        ?? `${contentKind}:${this.sourceTurnIdFor(session, turnId)}`;
      this.openContentByTurn.get(this.turnKey(session.id, turnId))?.set(contentId, contentKind);
      this.emitTurnEvent('content.delta', session, turnId, {
        contentId,
        kind: contentKind,
        ...(contentKind === 'text' ? { format: 'plain' } : {}),
        delta: text,
      }, this.nextContentDeltaIdentity(session.id, turnId, contentId));
      return;
    }
    if (kind === 'usage_update') {
      const used = typeof update.used === 'number' ? update.used : null;
      const window = typeof update.size === 'number' ? update.size : null;
      if (used !== null && window !== null && used >= 0 && window > 0) {
        this.emitTurnEvent('usage.updated', session, turnId, {
          context: { used, window },
        });
      }
      return;
    }
    if (kind === 'plan' || kind === 'plan_update') {
      const data = planUpdatedData(update, this.sourceTurnIdFor(session, turnId));
      this.emitPlanUpdate(session, turnId, data);
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const plan = todoListPlanData(update, this.sourceTurnIdFor(session, turnId));
      if (plan) {
        this.emitPlanUpdate(session, turnId, plan);
        return;
      }
      if (todoListToolData(update).todoTool) return;
      this.translateTool(session, turnId, update, kind === 'tool_call');
      return;
    }
    // Unknown but potentially user-visible ACP update: degrade to a generic
    // one-shot activity instead of silently dropping it (contract §14.3).
    // The occurrence counter keeps repeated identical updates as distinct
    // cards instead of upserting over each other.
    const degradedKey = `${this.turnKey(session.id, turnId)}${String(kind)}`;
    const occurrence = (this.degradedUpdateCounts.get(degradedKey) ?? 0) + 1;
    this.degradedUpdateCounts.set(degradedKey, occurrence);
    this.emitTurnEvent('activity.updated', session, turnId, {
      activityId: stableId('acp-update', { turnId, kind: String(kind), update, occurrence }),
      kind: typeof kind === 'string' && kind ? kind : 'unknown',
      title: `Kimi update: ${String(kind ?? 'unknown')}`,
      status: 'succeeded',
      presentation: { type: 'generic' },
      details: boundedDetails(update),
    });
  }

  private translateTool(
    session: AttachedSession,
    turnId: string,
    update: Record<string, unknown>,
    initial: boolean,
  ): void {
    const activityId = nonEmptyString(update.toolCallId);
    if (!activityId) return;
    const open = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
    if (!open) return;
    const name = nonEmptyString(update.kind) ?? 'tool';
    const title = String(update.title ?? 'Tool');
    const status = activityStatus(update.status);
    open.add(activityId);
    this.emitTurnEvent('activity.updated', session, turnId, {
      activityId,
      kind: 'tool',
      title,
      status: initial && status === 'running' ? 'running' : status,
      presentation: {
        type: 'tool',
        data: { name },
      },
      ...(update.rawOutput !== undefined || update.rawInput !== undefined
        ? { details: jsonValue(update.rawOutput ?? update.rawInput) }
        : {}),
    }, this.nextFactUpdateIdentity(session.id, turnId, 'activity', activityId));
    if (status !== 'running') open.delete(activityId);
  }

  private emitPlanUpdate(
    session: AttachedSession,
    turnId: string,
    data: ReturnType<typeof planUpdatedData>,
  ): void {
    const key = this.turnKey(session.id, turnId);
    const fingerprint = JSON.stringify(data);
    if (this.planFingerprintByTurn.get(key) === fingerprint) return;
    this.planFingerprintByTurn.set(key, fingerprint);
    this.emitTurnEvent(
      'plan.updated',
      session,
      turnId,
      data,
      this.nextFactUpdateIdentity(session.id, turnId, 'plan', data.planId),
    );
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    data: Record<string, unknown>,
  ): void {
    const turnKey = this.turnKey(session.id, turnId);
    if (this.terminalTurns.has(turnKey)) return;
    this.terminalTurns.add(turnKey);
    this.terminalSourceTurnIds.set(turnKey, this.sourceTurnIdFor(session, turnId));
    const terminalOrder = this.terminalOrderBySession.get(session.id) ?? [];
    if (!terminalOrder.includes(turnId)) terminalOrder.push(turnId);
    this.terminalOrderBySession.set(session.id, terminalOrder);
    this.resolveInteractionsForTurn(session, turnId, failed ? 'runtime_ended' : 'turn_ended');
    this.closeOpenWork(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      const message = String(data.message ?? 'Kimi turn failed.');
      this.updateSession(session, { state: 'error', lastError: message });
      this.emitTurnEvent('turn.failed', session, turnId, {
        error: {
          domainCode: 'RUNTIME_ERROR',
          message,
          retryable: false,
          details: {},
        },
      });
    } else {
      const interrupted = this.interruptedTurns.has(this.turnKey(session.id, turnId));
      const nativeReason = String(data.stopReason ?? data.status ?? '');
      const stopReason = interrupted
        ? 'interrupted'
        : nativeReason === 'cancelled' ? 'cancelled'
          : nativeReason === 'end_turn' || nativeReason === 'completed' ? 'completed'
            : nativeReason === 'max_tokens' || nativeReason === 'max_turn_requests' ? 'limit_reached'
              : nativeReason === 'refusal' ? 'refused' : 'other';
      this.updateSession(session, { state: 'idle', lastError: null });
      this.emitTurnEvent('turn.completed', session, turnId, { stopReason });
    }
    this.clearTurn(session.id, turnId);
    if (!this.sidechats.has(session.id) && this.service.supportsFork()) {
      this.emitSessionEvent('session.updated', session, {
        state: session.state,
        lastError: session.lastError,
        availableActions: this.availableActions(session),
        updatedAt: session.updatedAt,
      });
    }
  }

  private closeOpenWork(
    session: AttachedSession,
    turnId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): void {
    const contents = this.openContentByTurn.get(this.turnKey(session.id, turnId));
    if (contents) {
      for (const [contentId, kind] of contents) {
        this.emitTurnEvent(
          'content.completed',
          session,
          turnId,
          {
            contentId,
            kind,
            ...(kind === 'text' ? { format: 'plain' as const } : {}),
          },
          `${contentId}:completed`,
        );
      }
      contents.clear();
    }
    const activities = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
    if (activities) {
      for (const activityId of activities) {
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId,
          kind: 'tool',
          title: 'Tool',
          status,
          presentation: { type: 'tool', data: { name: 'tool' } },
        }, this.nextFactUpdateIdentity(session.id, turnId, 'activity', activityId));
      }
      activities.clear();
    }
  }

  private resolveInteractionsForTurn(
    session: AttachedSession,
    turnId: string,
    outcome: 'cancelled' | 'turn_ended' | 'runtime_ended',
  ): void {
    for (const [interactionId, interaction] of this.interactions) {
      if (interaction.sessionId !== session.id || interaction.turnId !== turnId) continue;
      this.interactions.delete(interactionId);
      this.emitTurnEvent('interaction.resolved', session, turnId, {
        interactionId,
        outcome,
      });
    }
  }

  private buildReplay(
    sessionId: string,
    nativeSessionId: string,
    updatedAt: string,
    updates: SessionNotification[],
  ): ReplayState {
    const meaningful = updates.filter((notification) => {
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
      nativeSessionId,
      updates: meaningful,
    });
    if (meaningful.length === 0) return { streamId, events: [], turnCount: 0 };
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
    const events: ReplayEvent[] = [];
    const append = (
      sourceTurnId: string,
      method: string,
      data: Record<string, unknown>,
      eventId: string,
    ) => {
      sequence += 1;
      events.push({
        method,
        eventId,
        sessionId,
        replayStreamId: streamId,
        sequence,
        sourceTurnId,
        emittedAt: updatedAt,
        data,
      });
    };
    for (const [turnIndex, turn] of turns.entries()) {
      // Same derivation as live turns (see deriveSourceTurnId), so a native
      // turn keeps one sourceTurnId across live streaming and history replay.
      const sourceTurnId = stableId('kimi-turn', {
        nativeSessionId,
        turnIndex,
        userText: turn.userText,
      });
      const fallbackOccurrences = new Map<string, number>();
      const appendTurn = (
        method: string,
        data: Record<string, unknown>,
        identity?: string,
      ) => {
        const occurrence = (fallbackOccurrences.get(method) ?? 0) + 1;
        fallbackOccurrences.set(method, occurrence);
        append(
          sourceTurnId,
          method,
          data,
          this.turnEventId(sourceTurnId, method, data, identity, occurrence),
        );
      };
      appendTurn('turn.started', {}, 'lifecycle');
      if (turn.userText) {
        const data = { input: [{ type: 'text', text: turn.userText }] };
        append(sourceTurnId, 'input.recorded', data, stableId('kimi-event', {
          sourceTurnId,
          method: 'input.recorded',
          identity: 'input',
        }));
      }
      const openTools = new Set<string>();
      const openContent = new Map<string, { kind: 'text' | 'reasoning'; deltaCount: number }>();
      const activityUpdateCounts = new Map<string, number>();
      const planUpdateCounts = new Map<string, number>();
      let lastPlanFingerprint: string | null = null;
      for (const notification of turn.updates) {
        const update = record(notification.update);
        const kind = update.sessionUpdate;
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
          const text = contentText(update);
          if (!text) continue;
          const contentKind = kind === 'agent_thought_chunk' ? 'reasoning' as const : 'text' as const;
          // Same content stream ID the live path derives (sourceTurnId-based).
          const contentId = nonEmptyString(record(update._meta).itemId)
            ?? `${contentKind}:${sourceTurnId}`;
          const open = openContent.get(contentId) ?? { kind: contentKind, deltaCount: 0 };
          open.deltaCount += 1;
          openContent.set(contentId, open);
          appendTurn('content.delta', {
            contentId,
            kind: contentKind,
            ...(contentKind === 'text' ? { format: 'plain' } : {}),
            delta: text,
          }, `${contentId}:delta:${open.deltaCount}`);
        } else if (kind === 'plan' || kind === 'plan_update') {
          const data = planUpdatedData(update, sourceTurnId);
          const fingerprint = JSON.stringify(data);
          if (fingerprint === lastPlanFingerprint) continue;
          lastPlanFingerprint = fingerprint;
          const count = (planUpdateCounts.get(data.planId) ?? 0) + 1;
          planUpdateCounts.set(data.planId, count);
          appendTurn('plan.updated', data, `${data.planId}:update:${count}`);
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const plan = todoListPlanData(update, sourceTurnId);
          if (plan) {
            const fingerprint = JSON.stringify(plan);
            if (fingerprint === lastPlanFingerprint) continue;
            lastPlanFingerprint = fingerprint;
            const count = (planUpdateCounts.get(plan.planId) ?? 0) + 1;
            planUpdateCounts.set(plan.planId, count);
            appendTurn('plan.updated', plan, `${plan.planId}:update:${count}`);
            continue;
          }
          if (todoListToolData(update).todoTool) continue;
          const activityId = nonEmptyString(update.toolCallId);
          if (!activityId) continue;
          const status = activityStatus(update.status);
          const count = (activityUpdateCounts.get(activityId) ?? 0) + 1;
          activityUpdateCounts.set(activityId, count);
          openTools.add(activityId);
          appendTurn('activity.updated', {
            activityId,
            kind: 'tool',
            title: String(update.title ?? 'Tool'),
            status,
            presentation: {
              type: 'tool',
              data: { name: nonEmptyString(update.kind) ?? 'tool' },
            },
            ...(update.rawOutput !== undefined || update.rawInput !== undefined
              ? { details: jsonValue(update.rawOutput ?? update.rawInput) }
              : {}),
          }, `${activityId}:update:${count}`);
          if (status !== 'running') openTools.delete(activityId);
        }
      }
      for (const [contentId, open] of openContent) {
        appendTurn(
          'content.completed',
          {
            contentId,
            kind: open.kind,
            ...(open.kind === 'text' ? { format: 'plain' as const } : {}),
          },
          `${contentId}:completed`,
        );
      }
      for (const activityId of openTools) {
        const count = (activityUpdateCounts.get(activityId) ?? 0) + 1;
        activityUpdateCounts.set(activityId, count);
        appendTurn('activity.updated', {
          activityId,
          kind: 'tool',
          title: 'Tool',
          status: 'succeeded',
          presentation: { type: 'tool', data: { name: 'tool' } },
        }, `${activityId}:update:${count}`);
      }
      appendTurn('turn.completed', { stopReason: 'completed' }, 'lifecycle');
    }
    return { streamId, events, turnCount: turns.length };
  }

  private emitSessionEvent(
    method: string,
    session: AttachedSession,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    this.emit(method, {
      eventId: stableId('kimi-session-event', {
        nativeSessionId: session.nativeSessionId,
        sequence: session.sequence,
        method,
        data,
      }),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private sourceTurnIdFor(session: AttachedSession, turnId: string): string {
    return this.sourceTurnIds.get(this.turnKey(session.id, turnId))
      ?? stableId('kimi-turn-orphan', {
        nativeSessionId: session.nativeSessionId,
        turnId,
      });
  }

  private emitTurnEvent(
    method: string,
    session: AttachedSession,
    turnId: string,
    data: Record<string, unknown>,
    identity?: string,
  ): void {
    session.sequence += 1;
    const key = this.turnKey(session.id, turnId);
    const sourceTurnId = this.sourceTurnIdFor(session, turnId);
    const occurrenceKey = `${key}\u0000event:${method}`;
    const occurrence = (this.eventOccurrences.get(occurrenceKey) ?? 0) + 1;
    this.eventOccurrences.set(occurrenceKey, occurrence);
    const eventId = this.turnEventId(sourceTurnId, method, data, identity, occurrence);
    const emittedAt = new Date().toISOString();
    this.emit(method, {
      eventId,
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      turnId,
      sourceTurnId,
      emittedAt,
      data,
    });
    if (!this.sidechats.has(session.id)) {
      const replay = this.replayBySession.get(session.id);
      if (replay) {
        replay.events.push({
          method,
          eventId,
          sessionId: session.id,
          replayStreamId: replay.streamId,
          sequence: (replay.events.at(-1)?.sequence ?? 0) + 1,
          sourceTurnId,
          emittedAt,
          data,
        });
        if (method === 'turn.completed' || method === 'turn.failed') replay.turnCount += 1;
      }
    }
  }

  private turnEventId(
    sourceTurnId: string,
    method: string,
    data: Record<string, unknown>,
    identity: string | undefined,
    occurrence: number,
  ): string {
    const factIdentity = identity
      ?? (method === 'turn.started' || method === 'turn.completed' || method === 'turn.failed'
        ? 'lifecycle'
        : nonEmptyString(data.contentId)
          ?? nonEmptyString(data.activityId)
          ?? nonEmptyString(data.interactionId)
          ?? nonEmptyString(data.diffId)
          ?? nonEmptyString(data.planId)
          ?? `occurrence:${occurrence}`);
    return stableId('kimi-event', { sourceTurnId, method, identity: factIdentity });
  }

  private nextContentDeltaIdentity(
    sessionId: string,
    turnId: string,
    contentId: string,
  ): string {
    const key = `${this.turnKey(sessionId, turnId)}\u0000content:${contentId}`;
    const occurrence = (this.eventOccurrences.get(key) ?? 0) + 1;
    this.eventOccurrences.set(key, occurrence);
    return `${contentId}:delta:${occurrence}`;
  }

  private nextFactUpdateIdentity(
    sessionId: string,
    turnId: string,
    kind: 'activity' | 'plan',
    factId: string,
  ): string {
    const key = `${this.turnKey(sessionId, turnId)}\u0000${kind}:${factId}`;
    const occurrence = (this.eventOccurrences.get(key) ?? 0) + 1;
    this.eventOccurrences.set(key, occurrence);
    return `${factId}:update:${occurrence}`;
  }

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.pendingUsageByTurn.delete(key);
    this.interruptedTurns.delete(key);
    this.sourceTurnIds.delete(key);
    this.openActivitiesByTurn.delete(key);
    this.openContentByTurn.delete(key);
    for (const occurrenceKey of [...this.eventOccurrences.keys()]) {
      if (occurrenceKey.startsWith(`${key}\u0000`)) this.eventOccurrences.delete(occurrenceKey);
    }
    for (const degradedKey of [...this.degradedUpdateCounts.keys()]) {
      if (degradedKey.startsWith(`${key}`)) this.degradedUpdateCounts.delete(degradedKey);
    }
    this.planFingerprintByTurn.delete(key);
    for (const responseKey of [...this.interactionResponses.keys()]) {
      if (responseKey.startsWith(`${key}`)) this.interactionResponses.delete(responseKey);
    }
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
      state: session.state,
      sessionConfig: session.sessionConfig,
      ...this.turnConfigFields(session.configOptions),
      lastError: session.lastError,
      ...(this.service.supportsFork() ? { availableActions: this.availableActions(session) } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (this.closedAttaches.has(sessionId)) {
        throw new KimiProtocolError('SESSION_CLOSED', 'Session is closed.');
      }
      throw new KimiProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    }
    return session;
  }

  private requireOrdinarySession(sessionId: string): AttachedSession {
    if (this.sidechats.has(sessionId)) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    }
    return this.requireSession(sessionId);
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new KimiProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireOrdinaryAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireOrdinarySession(sessionId);
    if (session.streamId !== streamId) {
      throw new KimiProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): void {
    if (this.activeTurnBySession.get(sessionId) !== turnId) {
      throw new KimiProtocolError('TURN_NOT_FOUND', 'Turn is not active.');
    }
  }
}
