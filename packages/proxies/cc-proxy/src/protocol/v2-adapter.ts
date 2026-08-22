import { createHash, randomUUID } from 'node:crypto';

import { AppError } from '../core/errors.js';
import { normalizeInputItems } from '../core/input.js';
import { buildPrompt, CcProxyService } from '../core/service.js';
import type { InputItem, ModelCapabilities, PermissionMode } from '../core/types.js';
import { ClaudeProtocolError, type DomainCode } from '../transport/protocol.js';
import {
  ClaudeNativeHistoryWatcher,
  IncrementalReplayTracker,
  activityEventId,
  contentCompletedEventId,
  countReplayableNativeTurns,
  listClaudeNativeSessions,
  nativeTurnSourceId,
  normalizeNativePrompt,
  renameClaudeNativeSession,
  replayClaudeNativeSession,
  turnCompletedEventId,
  turnFailedEventId,
  turnStartedEventId,
  type NativeReplay,
} from './native-history.js';

type ConfigValue = string | boolean | number | null;

export type WireRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type V2EventSink = (method: string, params: Record<string, unknown>) => void;

type CatalogRole = 'model' | 'effort' | 'approval_mode';

type CatalogOption = {
  id: string;
  displayName: string;
  description?: string;
  binding: 'session' | 'turn';
  role?: CatalogRole;
  control: 'select';
  required: boolean;
  defaultValue: ConfigValue;
  choices: Array<{ value: ConfigValue; displayName: string; description?: string }>;
  enabledWhen?: Array<{ optionId: string; oneOf: ConfigValue[] }>;
};

type InteractionInput = {
  id: string;
  type: 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean';
  label: string;
  required: boolean;
  description?: string;
  choices?: Array<{ value: string; displayName: string }>;
};

type ActivityMeta = {
  kind: string;
  title: string;
  presentation: Record<string, unknown>;
};

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
      throw new ClaudeProtocolError('SESSION_NOT_FOUND', `Session ${params.sessionId} is not attached.`);
    }
    if (active !== params.streamId) {
      throw new ClaudeProtocolError('SESSION_STALE', `Stream ${params.streamId} is no longer active.`);
    }
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    const fingerprint = JSON.stringify({ input: params.input, config: params.config });
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return 'new';
    }
    if (existing !== fingerprint) {
      throw new ClaudeProtocolError('CONFLICT', `Turn ${params.turnId} was reused with different input.`);
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
      throw new ClaudeProtocolError('INVALID_PARAMS', 'Replay cursor has no active snapshot.');
    }
    if (cursor === null) this.active.set(sessionId, snapshot);
    const offset = cursor === null || /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor ?? 0) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.events.length) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'Invalid replay cursor.');
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
  /** Only Session-bound options. Claude currently has none, so this is
   *  always empty. Turn-bound model/effort/permission_mode are deliberately
   *  not mirrored here. */
  sessionConfig: Record<string, ConfigValue>;
  displayName: string | null;
  sequence: number;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

interface ActiveTurnState {
  hostTurnId: string;
  sourceTurnId: string;
  serviceTurnId: string | null;
}

interface InteractionRef extends HostTurnRef {
  serviceApprovalId: string;
  actionIds: string[];
  inputs: InteractionInput[];
  responses: Map<string, { actionId: string; values: Record<string, unknown> }>;
}

interface DeferredNotification {
  method: string;
  params: Record<string, unknown>;
}

interface ClosedAttach {
  streamId: string;
  closedAt: string;
}

const PROTOCOL_NAME = 'gian.proxy';
const PROTOCOL_V2 = '2.0';
const MAX_ACTIVITY_JSON_BYTES = 1024 * 1024;

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'catalog.resolve': 1,
  'session.rename': 1,
  'session.native.list': 1,
  'session.replay': 1,
  interaction: 1,
  'event.reasoning': 1,
  'event.usage': 1,
} as const;

const FALLBACK_PERMISSION_MODES = ['manual', 'acceptEdits', 'bypassPermissions'] as const;

/** Product decision: plan mode is not offered by this Proxy build. */
const DISABLED_PERMISSION_MODES = new Set(['plan']);

const INTERACTION_ACTION_BEHAVIORS: Record<string, 'allow' | 'deny'> = {
  allow_once: 'allow',
  reject_once: 'deny',
} as const;

const PERMISSION_MODE_COPY: Record<string, { displayName: string; description: string }> = {
  manual: {
    displayName: 'Ask (manual)',
    description: 'Ask before actions that require permission.',
  },
  default: {
    displayName: 'Ask (default)',
    description: 'Ask before risky actions.',
  },
  acceptEdits: {
    displayName: 'Accept edits',
    description: 'Auto-accept file edits; ask for other tools.',
  },
  bypassPermissions: {
    displayName: 'Bypass permissions',
    description: 'Skip permission prompts for this turn.',
  },
  auto: {
    displayName: 'Auto',
    description: 'Let Claude review actions automatically.',
  },
  dontAsk: {
    displayName: "Don't ask",
    description: 'Deny risky actions without asking.',
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecordValue(value)) {
    throw new ClaudeProtocolError('INVALID_PARAMS', `${field} must be an object.`);
  }
  return value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isClaudeAuthError(message: string): boolean {
  return /(?:oauth|authenticat|not logged in|login required|credential).*(?:expired|failed|required|refresh|missing)|(?:expired|failed).*(?:oauth|authenticat|credential)/i
    .test(message);
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function boundedJson(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    return String(value).slice(0, 2048);
  }
  if (Buffer.byteLength(text, 'utf8') <= MAX_ACTIVITY_JSON_BYTES) {
    return JSON.parse(text) as unknown;
  }
  return {
    truncated: true,
    byteLength: Buffer.byteLength(text, 'utf8'),
    preview: text.slice(0, 2048),
  };
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function isConfigValue(value: unknown): value is ConfigValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function standardError(error: unknown): ClaudeProtocolError {
  if (error instanceof ClaudeProtocolError) return error;
  if (error instanceof AppError) {
    const code: DomainCode = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_CLOSED': return 'SESSION_CLOSED';
        case 'SESSION_STALE': return 'SESSION_STALE';
        case 'SESSION_ERROR': return 'SESSION_ERROR';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'TURN_NOT_FOUND': return 'TURN_NOT_FOUND';
        case 'APPROVAL_NOT_FOUND': return 'INTERACTION_NOT_FOUND';
        case 'INVALID_REQUEST': return 'INVALID_PARAMS';
        case 'PROCESS_SPAWN_FAILED': return 'RUNTIME_UNAVAILABLE';
        default: return 'RUNTIME_ERROR';
      }
    })();
    return new ClaudeProtocolError(code, error.message, false);
  }
  return new ClaudeProtocolError(
    'INTERNAL',
    error instanceof Error ? error.message : String(error),
  );
}

function actionStyle(optionId: string): 'primary' | 'secondary' | 'danger' {
  const id = optionId.toLowerCase();
  if (id.includes('reject') || id.includes('deny') || id.includes('cancel') || id === 'keep_planning') return 'danger';
  if (id.includes('allow') || id.includes('accept') || id.includes('approve')) return 'primary';
  return 'secondary';
}

function sessionUpdatedData(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (data.nativeSession !== undefined) next.nativeSession = data.nativeSession;
  if (data.state !== undefined) next.state = data.state;
  if (data.lastError !== undefined) next.lastError = data.lastError;
  if (data.turnConfigOptions !== undefined) next.turnConfigOptions = data.turnConfigOptions;
  if (data.turnConfigRevision !== undefined) next.turnConfigRevision = data.turnConfigRevision;
  if (data.updatedAt !== undefined) next.updatedAt = data.updatedAt;
  if (Object.keys(next).length === 0) next.updatedAt = new Date().toISOString();
  return next;
}

function sanitizeUsage(data: Record<string, unknown>): Record<string, unknown> | null {
  const next: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(data, 'context')) {
    if (data.context === null) {
      next.context = null;
    } else {
      const context = record(data.context);
      const used = typeof context.used === 'number' && Number.isFinite(context.used) && context.used >= 0
        ? Math.floor(context.used)
        : undefined;
      const window = typeof context.window === 'number' && Number.isSafeInteger(context.window) && context.window > 0
        ? context.window
        : undefined;
      if (used !== undefined) {
        next.context = { used, ...(window !== undefined ? { window } : {}) };
      }
    }
  }
  const conversation = record(data.conversation);
  if (conversation.mode === 'reset') {
    next.conversation = { mode: 'reset' };
  } else if (conversation.mode === 'delta' || conversation.mode === 'absolute') {
    const conv: Record<string, unknown> = { mode: conversation.mode };
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'] as const) {
      const value = conversation[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        conv[key] = Math.floor(value);
      }
    }
    next.conversation = conv;
  }
  if (next.context === undefined && next.conversation === undefined) return null;
  return next;
}

function uniqueEfforts(models: ModelCapabilities[]): Array<{ id: string; displayName: string }> {
  const seen = new Map<string, { id: string; displayName: string }>();
  for (const model of models) {
    for (const effort of model.supportedEfforts) {
      if (!seen.has(effort)) seen.set(effort, { id: effort, displayName: effort });
    }
  }
  return [...seen.values()];
}

function questionInputs(payload: Record<string, unknown>): InteractionInput[] {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const inputs: InteractionInput[] = [];
  for (const raw of questions) {
    const question = record(raw);
    const label = typeof question.question === 'string'
      ? question.question
      : typeof question.header === 'string' ? question.header : '';
    if (!label) continue;
    const options = Array.isArray(question.options) ? question.options : [];
    const choices = options.flatMap((rawOption) => {
      const option = record(rawOption);
      const value = typeof option.label === 'string' && option.label
        ? option.label
        : typeof option.value === 'string' ? option.value : '';
      if (!value) return [];
      return [{ value, displayName: value }];
    });
    const multi = question.multiSelect === true || question.allow_multiple === true;
    const description = typeof question.header === 'string' && question.header !== label
      ? question.header
      : undefined;
    inputs.push(choices.length > 0
      ? {
          id: label,
          type: multi ? 'multi_select' : 'single_select',
          label,
          required: false,
          ...(description ? { description } : {}),
          choices,
        }
      : {
          id: label,
          type: 'text',
          label,
          required: false,
          ...(description ? { description } : {}),
        });
  }
  return inputs;
}

function answersFromValues(values: Record<string, unknown>): Record<string, string | string[]> | undefined {
  const answers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') answers[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      answers[key] = value;
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function agentState(status: unknown): 'running' | 'completed' | 'failed' | 'interrupted' {
  if (status === 'done' || status === 'completed') return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return 'running';
}

function agentActivityStatus(state: 'running' | 'completed' | 'failed' | 'interrupted') {
  if (state === 'completed') return 'succeeded' as const;
  if (state === 'failed') return 'failed' as const;
  if (state === 'interrupted') return 'cancelled' as const;
  return 'running' as const;
}

function parseInputPreview(preview: unknown): Record<string, unknown> {
  if (typeof preview !== 'string' || !preview.trim()) return {};
  try {
    const parsed = JSON.parse(preview) as unknown;
    return record(parsed);
  } catch {
    return {};
  }
}

export class ClaudeProtocolV2Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly closedAttaches = new Map<string, ClosedAttach>();
  private readonly creationFingerprints = new Map<string, string>();
  private readonly runtimeModelByCatalogId = new Map<string, string>();
  private catalogModelsLoaded = false;
  private advertisedOptions: CatalogOption[] = [];
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly activeTurnStateBySession = new Map<string, ActiveTurnState>();
  private readonly startedTurns = new Set<string>();
  private readonly pendingUsageByTurn = new Map<string, Record<string, unknown>>();
  private readonly acceptedInterruptTurns = new Set<string>();
  private readonly interactions = new Map<string, InteractionRef>();
  private readonly interactionResponses = new Map<string, {
    sessionId: string;
    fingerprint: string;
    result: { accepted: true; interactionId: string; responseId: string };
  }>();
  private readonly openActivitiesByTurn = new Map<string, Map<string, ActivityMeta>>();
  private readonly openContentByTurn = new Map<string, Map<string, 'text' | 'reasoning' | 'status'>>();
  private readonly contentTextByTurn = new Map<string, Map<string, string>>();
  private readonly replayBySession = new Map<string, NativeReplay>();
  private readonly replayTrackers = new Map<string, IncrementalReplayTracker>();
  private readonly replayPager = new ReplayPager();
  private readonly historyWatchers = new Map<string, ClaudeNativeHistoryWatcher>();
  private readonly ledger = new TurnLedger();
  private initialized = false;
  private catalogRevision = '';
  private deferDepth = 0;
  private readonly deferredNotifications: DeferredNotification[] = [];

  constructor(
    private readonly service: CcProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V2EventSink,
  ) {
    service.setEventSink((method, params) => this.translateEvent(method, params));
  }

  async handle(request: WireRequest): Promise<unknown> {
    if (!this.initialized && request.method !== 'initialize' && request.method !== 'shutdown') {
      throw new ClaudeProtocolError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    this.deferDepth += 1;
    try {
      switch (request.method) {
        case 'initialize': return this.initialize(request.params);
        case 'catalog.list': return await this.catalog();
        case 'catalog.resolve': return await this.resolveCatalog(request.params);
        case 'session.create': return await this.createSession(request.params);
        case 'session.get': return { session: this.serialize(this.requireSession(String(request.params.sessionId ?? ''))) };
        case 'turn.start': return await this.startTurn(request.params, request.id);
        case 'turn.interrupt': return await this.interruptTurn(request.params);
        case 'interaction.respond': return await this.respondInteraction(request.params);
        case 'session.close': return await this.closeSession(request.params);
        case 'session.rename': return await this.renameSession(request.params);
        case 'session.native.list': return this.listNative(request.params);
        case 'session.replay': return this.replay(request.params);
        case 'session.native.delete':
        case 'turn.steer':
          throw new ClaudeProtocolError(
            'CAPABILITY_NOT_SUPPORTED',
            `${request.method} is not advertised by Claude Proxy.`,
          );
        case 'shutdown': return { ok: true };
        default:
          throw new ClaudeProtocolError('METHOD_NOT_FOUND', `Unknown method "${request.method}".`);
      }
    } finally {
      this.deferDepth -= 1;
    }
  }

  /** Flush notifications produced while handling a Request. The CLI writer
   *  calls this only after the Response line has been written, preserving
   *  the protocol's Response-before-Notification invariant. */
  flushDeferredNotifications(): void {
    const queued = this.deferredNotifications.splice(0);
    for (const item of queued) this.emitEvent(item.method, item.params);
  }

  private initialize(params: Record<string, unknown>) {
    if (this.initialized) {
      throw new ClaudeProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.');
    }
    const protocol = requireRecord(params.protocol, 'protocol');
    const versions = Array.isArray(protocol.versions)
      ? protocol.versions.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    if (protocol.name !== PROTOCOL_NAME || !versions.includes(PROTOCOL_V2)) {
      throw new ClaudeProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.0 is required.');
    }
    const host = requireRecord(params.host, 'host');
    if (typeof host.name !== 'string' || host.name.length === 0
      || typeof host.version !== 'string' || host.version.length === 0) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'initialize.params.host is required.');
    }
    this.initialized = true;
    return {
      protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V2 },
      plugin: { id: 'claude', name: 'Claude Code', version: this.pluginVersion },
      process: { scope: 'session' as const },
      capabilities: CAPABILITIES,
    };
  }

  private permissionModes(): string[] {
    const discovered = this.service.getPermissionModes();
    const seen = new Set<string>();
    const modes: string[] = [];
    for (const mode of discovered.length > 0 ? discovered : FALLBACK_PERMISSION_MODES) {
      if (DISABLED_PERMISSION_MODES.has(mode) || !nonEmptyString(mode) || seen.has(mode)) continue;
      seen.add(mode);
      modes.push(mode);
    }
    return modes;
  }

  private buildCatalogOptions(
    models: ModelCapabilities[],
    draft: Record<string, ConfigValue> = {},
  ): CatalogOption[] {
    const visible = models.filter((model) => !model.hidden);
    const defaultModel = visible.find((model) => model.isDefault) ?? visible[0];
    const options: CatalogOption[] = [];
    if (visible.length > 0) {
      options.push({
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: defaultModel?.id ?? null,
        choices: visible.map((model) => ({
          value: model.id,
          displayName: model.displayName || model.id,
          ...(model.description ? { description: model.description } : {}),
        })),
      });
    }

    const selectedModelId = typeof draft.model === 'string'
      ? draft.model
      : defaultModel?.id ?? null;
    const selectedModel = visible.find((model) => model.id === selectedModelId) ?? defaultModel;
    const effortChoices = selectedModel && selectedModel.supportedEfforts.length > 0
      ? uniqueEfforts([selectedModel])
      : uniqueEfforts(visible);
    if (effortChoices.length > 0) {
      const selectedEfforts = new Set(selectedModel?.supportedEfforts ?? []);
      const defaultEffort = selectedModel?.defaultEffort && selectedEfforts.has(selectedModel.defaultEffort)
        ? selectedModel.defaultEffort
        : effortChoices[0]?.id ?? null;
      const effortModels = visible.filter((model) => model.supportedEfforts.length > 0);
      options.push({
        id: 'effort',
        displayName: 'Effort',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: defaultEffort,
        choices: effortChoices.map((effort) => ({
          value: effort.id,
          displayName: effort.displayName,
        })),
        ...(effortModels.length > 0 && effortModels.length < visible.length
          ? {
              enabledWhen: [{
                optionId: 'model',
                oneOf: effortModels.map((model) => model.id),
              }],
            }
          : {}),
      });
    }

    const permissionChoices = this.permissionModes().map((mode) => ({
      value: mode,
      displayName: PERMISSION_MODE_COPY[mode]?.displayName ?? mode,
      description: PERMISSION_MODE_COPY[mode]?.description,
    }));
    if (permissionChoices.length > 0) {
      options.push({
        id: 'permission_mode',
        displayName: 'Permission mode',
        description: 'Claude CLI --permission-mode for this turn.',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: permissionChoices.some((choice) => choice.value === 'manual')
          ? 'manual'
          : permissionChoices.some((choice) => choice.value === 'default')
            ? 'default'
            : permissionChoices[0]!.value,
        choices: permissionChoices.flatMap((choice) => choice.description
          ? [{ value: choice.value, displayName: choice.displayName, description: choice.description }]
          : [{ value: choice.value, displayName: choice.displayName }]),
      });
    }
    return options;
  }

  private serializeOption(option: CatalogOption) {
    return {
      id: option.id,
      displayName: option.displayName,
      ...(option.description ? { description: option.description } : {}),
      binding: option.binding,
      ...(option.role ? { role: option.role } : {}),
      control: option.control,
      required: option.required,
      defaultValue: option.defaultValue,
      choices: option.choices,
      ...(option.enabledWhen ? { enabledWhen: option.enabledWhen } : {}),
    };
  }

  private async catalogPayload(
    models: ModelCapabilities[],
    options: CatalogOption[],
    cwd?: string,
  ) {
    const slashCommands: Array<{
      name: string;
      description: string;
      source: 'builtin' | 'user' | 'project';
      argHints: Array<{ kind: 'free' | 'model' | 'path' | 'agent' | 'enum'; placeholder?: string; values?: string[] }>;
    }> = [];
    try {
      const listed = await this.service.listSlashCommands(cwd);
      for (const command of listed.commands) {
        slashCommands.push({
          name: command.name.startsWith('/') ? command.name : `/${command.name}`,
          description: command.description ?? '',
          source: command.source,
          argHints: (command.argHints ?? []).map((hint) => ({
            kind: hint.kind,
            ...(hint.placeholder ? { placeholder: hint.placeholder } : {}),
            ...(hint.values ? { values: hint.values } : {}),
          })),
        });
      }
    } catch {
      /* catalog remains valid without slash commands */
    }
    const payload = {
      catalogRevision: '',
      input: [
        { type: 'text' as const },
        { type: 'localFile' as const },
        { type: 'localImage' as const },
      ],
      configOptions: options.map((option) => this.serializeOption(option)),
      slashCommands,
    };
    payload.catalogRevision = stableId('catalog', {
      input: payload.input,
      configOptions: payload.configOptions,
      slashCommands: payload.slashCommands,
    });
    return payload;
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    this.rememberCatalogModels(capabilities.models);
    const options = this.buildCatalogOptions(capabilities.models);
    this.advertisedOptions = options;
    const attached = this.sessions.values().next().value as AttachedSession | undefined;
    const payload = await this.catalogPayload(capabilities.models, options, attached?.cwd);
    this.catalogRevision = payload.catalogRevision;
    return payload;
  }

  private async resolveCatalog(params: Record<string, unknown>) {
    const catalogRevision = nonEmptyString(params.catalogRevision);
    if (!catalogRevision) throw new ClaudeProtocolError('INVALID_PARAMS', 'catalogRevision is required.');
    const sessionId = nonEmptyString(params.sessionId);
    const streamId = nonEmptyString(params.streamId);
    if ((sessionId === null) !== (streamId === null)) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'sessionId and streamId must be sent together.');
    }
    if (sessionId && streamId) this.requireAttached(sessionId, streamId);
    if (this.advertised().length === 0) await this.catalog();
    const sessionConfig = this.validateConfig(requireRecord(params.sessionConfig, 'sessionConfig'), 'session');
    const explicitTurnConfig = this.validateConfig(requireRecord(params.turnConfig, 'turnConfig'), 'turn');
    const capabilities = await this.service.listCapabilities();
    this.rememberCatalogModels(capabilities.models);
    const draft: Record<string, ConfigValue> = {};
    for (const option of this.advertisedOptions) {
      const value = explicitTurnConfig[option.id];
      if (isConfigValue(value)) draft[option.id] = value;
    }
    this.validateEnabledConditions(draft, 'turn');
    const options = this.buildCatalogOptions(capabilities.models, draft);
    const payload = await this.catalogPayload(capabilities.models, options);
    const resolvedDefaults: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } = {
      sessionConfig: {},
      turnConfig: {},
    };
    for (const option of options) {
      if (option.binding !== 'turn' || explicitTurnConfig[option.id] !== undefined) continue;
      const defaultValue = option.defaultValue;
      if (defaultValue === null) continue;
      resolvedDefaults.turnConfig[option.id] = defaultValue;
    }
    return { ...payload, resolvedDefaults };
  }

  private advertised(): CatalogOption[] {
    return this.advertisedOptions;
  }

  private validateConfig(
    config: Record<string, unknown>,
    binding: 'session' | 'turn',
  ): Record<string, ConfigValue> {
    const advertised = new Map(this.advertised().map((option) => [option.id, option]));
    const next: Record<string, ConfigValue> = {};
    for (const [configId, value] of Object.entries(config)) {
      const option = advertised.get(configId);
      if (!option) {
        throw new ClaudeProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
      }
      if (option.binding !== binding) {
        throw new ClaudeProtocolError(
          'CONFIG_BINDING_INVALID',
          `Claude config ${configId} is ${option.binding}-bound, not ${binding}-bound.`,
        );
      }
      if (!isConfigValue(value)) {
        throw new ClaudeProtocolError('CONFIG_VALUE_INVALID', `Claude config ${configId} must be a config value.`);
      }
      if (
        option.control === 'select'
        && value !== null
        && !option.choices.some((choice) => Object.is(choice.value, value))
      ) {
        throw new ClaudeProtocolError('CONFIG_VALUE_INVALID', `Unknown choice for ${configId}.`);
      }
      next[configId] = value;
    }
    for (const option of this.advertised()) {
      if (option.binding === binding && option.required && next[option.id] === undefined) {
        throw new ClaudeProtocolError('CONFIG_REQUIRED', `Claude config ${option.id} is required.`);
      }
    }
    return next;
  }

  private effectiveConfig(
    options: CatalogOption[],
    explicit: Record<string, ConfigValue>,
    binding: 'session' | 'turn',
  ): Record<string, ConfigValue> {
    const next: Record<string, ConfigValue> = {};
    for (const option of options) {
      if (option.binding !== binding) continue;
      const value = explicit[option.id] !== undefined
        ? explicit[option.id]
        : option.defaultValue;
      if (isConfigValue(value) && value !== null) next[option.id] = value;
    }
    return next;
  }

  private validateEnabledConditions(
    effective: Record<string, ConfigValue>,
    binding: 'session' | 'turn',
  ): void {
    for (const option of this.advertised()) {
      if (option.binding !== binding || effective[option.id] === undefined) continue;
      if (option.enabledWhen && !this.conditionsMatch(option.enabledWhen, effective)) {
        throw new ClaudeProtocolError(
          'CONFIG_VALUE_INVALID',
          `Claude config ${option.id} is not enabled for the current draft.`,
        );
      }
    }
  }

  private conditionsMatch(
    conditions: Array<{ optionId: string; oneOf: ConfigValue[] }>,
    config: Record<string, ConfigValue>,
  ): boolean {
    return conditions.every((condition) => (
      config[condition.optionId] !== undefined
      && condition.oneOf.some((value) => Object.is(value, config[condition.optionId]))
    ));
  }

  private async createSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    if (!sessionId) throw new ClaudeProtocolError('INVALID_PARAMS', 'sessionId is required.');
    const workspace = requireRecord(params.workspace, 'workspace');
    const cwd = nonEmptyString(workspace.cwd);
    if (!cwd) throw new ClaudeProtocolError('INVALID_PARAMS', 'workspace.cwd is required.');
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    if (roots.length === 0) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'workspace.roots must contain at least one path.');
    }
    if (params.hostServices !== undefined) {
      throw new ClaudeProtocolError(
        'CAPABILITY_NOT_SUPPORTED',
        'Claude Proxy does not advertise integration.mcp.streamableHttp.',
      );
    }

    let nativeSessionId: string | null = null;
    let history: 'none' | 'replay' = 'none';
    if (params.nativeSession !== undefined) {
      const native = requireRecord(params.nativeSession, 'nativeSession');
      nativeSessionId = nonEmptyString(native.id);
      if (!nativeSessionId) throw new ClaudeProtocolError('INVALID_PARAMS', 'nativeSession.id is required.');
      if (native.history !== undefined) {
        if (native.history !== 'none' && native.history !== 'replay') {
          throw new ClaudeProtocolError('INVALID_PARAMS', 'nativeSession.history must be none or replay.');
        }
        history = native.history;
      }
    }

    if (this.advertised().length === 0) await this.catalog();
    const config = this.validateConfig(requireRecord(params.config, 'config'), 'session');
    const fingerprint = JSON.stringify({
      workspace: { cwd, roots },
      nativeSession: nativeSessionId ? { id: nativeSessionId, history } : null,
      config,
      hostServices: params.hostServices,
    });
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.creationFingerprints.get(sessionId) !== fingerprint) {
        throw new ClaudeProtocolError('CONFLICT', `Session ${sessionId} was reused with different parameters.`);
      }
      return { session: this.serialize(existing) };
    }

    const result = await this.service.createSession({
      cwd,
      ...(nativeSessionId ? { claudeSessionId: nativeSessionId } : {}),
    });
    const serviceSession = result.session;
    const session: AttachedSession = {
      id: sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.claudeSessionId,
      streamId: randomUUID(),
      cwd,
      state: 'idle',
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      sessionConfig: {},
      displayName: null,
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.creationFingerprints.set(session.id, fingerprint);
    this.ledger.attach(session.id, session.streamId);
    const replayTracker = new IncrementalReplayTracker();
    replayTracker.attach(
      replayClaudeNativeSession(session.id, session.nativeSessionId, session.cwd),
      Boolean(nativeSessionId) && history === 'replay',
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
        this.emitSessionEvent('history.changed', session, {
          reason: 'native-history-changed',
        });
      },
    );
    historyWatcher.start();
    this.historyWatchers.set(session.id, historyWatcher);
    void this.publishCatalogIfCommandsArrive(session);
    return { session: this.serialize(session) };
  }

  private async publishCatalogIfCommandsArrive(session: AttachedSession): Promise<void> {
    try {
      const listed = await this.service.listSlashCommands(session.cwd);
      if (listed.commands.length === 0) return;
      this.emitEvent('catalog.changed', {
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        data: { reason: 'available-commands', revision: this.catalogRevision },
      });
    } catch {
      /* slash discovery is optional */
    }
  }

  private claudeInput(items: unknown[]): InputItem[] {
    return items.map((raw) => {
      const item = record(raw);
      switch (item.type) {
        case 'text':
          if (typeof item.text !== 'string') {
            throw new ClaudeProtocolError('INVALID_PARAMS', 'text input requires a string text field.');
          }
          return { type: 'text' as const, text: item.text };
        case 'localImage':
        case 'localFile': {
          const path = nonEmptyString(item.path);
          if (!path) throw new ClaudeProtocolError('INVALID_PARAMS', `${String(item.type)} input requires path.`);
          return {
            type: item.type,
            path,
            ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
            ...(typeof item.mime === 'string' && item.mime ? { mime: item.mime } : {}),
            ...(typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
              ? { size: item.size }
              : {}),
          } as InputItem;
        }
        case 'skill':
          throw new ClaudeProtocolError(
            'CAPABILITY_NOT_SUPPORTED',
            'Claude Proxy does not advertise input.skill.',
          );
        default:
          throw new ClaudeProtocolError('INVALID_PARAMS', 'Unsupported input item.');
      }
    });
  }

  private async startTurn(params: Record<string, unknown>, requestId: string) {
    const sessionId = nonEmptyString(params.sessionId);
    const streamId = nonEmptyString(params.streamId);
    const turnId = nonEmptyString(params.turnId);
    if (!sessionId || !streamId || !turnId) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'sessionId, streamId, and turnId are required.');
    }
    const session = this.requireAttached(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new ClaudeProtocolError('INVALID_PARAMS', 'input is required.');
    if (this.advertised().length === 0) await this.catalog();
    const explicitConfig = this.validateConfig(requireRecord(params.config, 'config'), 'turn');
    const effective = this.effectiveConfig(this.advertised(), explicitConfig, 'turn');
    this.validateEnabledConditions(effective, 'turn');
    const serviceInput = this.claudeInput(input);
    // Fingerprint the normalized request so duplicate turn.start is truly
    // idempotent for semantically identical input/config, not key-order
    // dependent on the raw JSON object.
    const accepted = this.ledger.accept({
      sessionId,
      streamId,
      turnId,
      input: serviceInput,
      config: explicitConfig,
    });
    if (accepted === 'duplicate') return { accepted: true as const, turnId };
    if (this.activeTurnBySession.has(session.id)) {
      this.ledger.forget({ sessionId, streamId, turnId });
      throw new ClaudeProtocolError('SESSION_BUSY', 'Session already has an active turn.');
    }

    let prompt: string;
    try {
      prompt = buildPrompt(normalizeInputItems(serviceInput, session.cwd));
    } catch (error) {
      this.ledger.forget({ sessionId, streamId, turnId });
      throw standardError(error);
    }
    const sourceTurnId = prompt.trim() === '/clear'
      ? stableId('claude-synthetic-turn', { nativeSessionId: session.nativeSessionId, turnId })
      : nativeTurnSourceId(
          session.nativeSessionId,
          normalizeNativePrompt(prompt),
          countReplayableNativeTurns(session.nativeSessionId, session.cwd),
        );

    this.turnsByRequest.set(requestId, { sessionId: session.id, turnId });
    this.requestByTurn.set(this.turnKey(session.id, turnId), requestId);
    this.activeTurnBySession.set(session.id, turnId);
    this.activeTurnStateBySession.set(session.id, {
      hostTurnId: turnId,
      sourceTurnId,
      serviceTurnId: null,
    });
    this.openActivitiesByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.openContentByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.contentTextByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.historyWatchers.get(session.id)?.pause();
    try {
      const runtimeModel = await this.resolveRuntimeModel(
        typeof effective.model === 'string' ? effective.model : null,
      );
      const permissionMode = typeof effective.permission_mode === 'string'
        ? effective.permission_mode as PermissionMode
        : undefined;
      const effort = typeof effective.effort === 'string' ? effective.effort : undefined;
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: serviceInput,
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(session.displayName ? { displayName: session.displayName } : {}),
        ...(runtimeModel !== undefined ? { model: runtimeModel } : {}),
        ...(effort !== undefined ? { thinking: effort } : {}),
      }, requestId);
      return { accepted: true as const, turnId };
    } catch (error) {
      this.ledger.forget({ sessionId, streamId, turnId });
      this.clearTurn(session.id, turnId);
      this.historyWatchers.get(session.id)?.resume();
      this.rebaseHistory(session);
      throw standardError(error);
    }
  }

  private async interruptTurn(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    const streamId = nonEmptyString(params.streamId);
    const turnId = nonEmptyString(params.turnId);
    if (!sessionId || !streamId || !turnId) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'sessionId, streamId, and turnId are required.');
    }
    const session = this.requireAttached(sessionId, streamId);
    this.requireActiveTurn(session.id, turnId);
    this.acceptedInterruptTurns.add(this.turnKey(session.id, turnId));
    try {
      await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    } catch (error) {
      throw standardError(error);
    }
    // The interrupt action was accepted by the Runtime. Only now resolve the
    // pending interactions and close open work; a failed interrupt must leave
    // the pending interaction intact so the Host never sees a zombie.
    this.resolveInteractionsForTurn(session, turnId, 'cancelled');
    this.closeOpenWork(session, turnId, 'cancelled');
    this.updateSession(session, { state: 'idle', lastError: null });
    this.emitTurnEvent('turn.completed', session, turnId, {
      stopReason: 'interrupted',
    }, turnCompletedEventId(this.activeTurnStateBySession.get(session.id)?.sourceTurnId ?? turnId));
    this.clearTurn(session.id, turnId);
    this.historyWatchers.get(session.id)?.resume();
    this.rebaseHistory(session);
    return { accepted: true as const, turnId };
  }

  private async respondInteraction(params: Record<string, unknown>) {
    const session = this.requireAttached(
      String(params.sessionId ?? ''),
      String(params.streamId ?? ''),
    );
    const turnId = nonEmptyString(params.turnId);
    if (!turnId) throw new ClaudeProtocolError('INVALID_PARAMS', 'turnId is required.');
    const interactionId = nonEmptyString(params.interactionId);
    const responseId = nonEmptyString(params.responseId);
    const actionId = nonEmptyString(params.actionId);
    if (!interactionId || !responseId || !actionId) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'interactionId, responseId, and actionId are required.');
    }
    const values = requireRecord(params.values, 'values');
    const responseKey = `${session.id}\u0000${responseId}`;
    const fingerprint = JSON.stringify({
      streamId: session.streamId,
      turnId,
      interactionId,
      actionId,
      values,
    });
    const completed = this.interactionResponses.get(responseKey);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new ClaudeProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return completed.result;
    }
    this.requireActiveTurn(session.id, turnId);
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.sessionId !== session.id || interaction.turnId !== turnId) {
      throw new ClaudeProtocolError('INTERACTION_NOT_FOUND', 'Interaction not found.');
    }
    if (!interaction.actionIds.includes(actionId)) {
      throw new ClaudeProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Interaction action is not available.');
    }
    const previous = interaction.responses.get(responseId);
    if (previous) {
      if (previous.actionId !== actionId || JSON.stringify(previous.values) !== JSON.stringify(values)) {
        throw new ClaudeProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return { accepted: true as const, interactionId, responseId };
    }
    this.validateInteractionValues(interaction, values);
    interaction.responses.set(responseId, { actionId, values });
    const answers = answersFromValues(values);
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: interaction.serviceApprovalId,
        behavior: this.behaviorForAction(actionId),
        ...(answers ? { answers } : {}),
      });
    } catch (error) {
      interaction.responses.delete(responseId);
      throw standardError(error);
    }
    const result = { accepted: true as const, interactionId, responseId };
    this.interactionResponses.set(responseKey, {
      sessionId: session.id,
      fingerprint,
      result,
    });
    return result;
  }

  private behaviorForAction(actionId: string): 'allow' | 'deny' {
    const behavior = INTERACTION_ACTION_BEHAVIORS[actionId];
    if (!behavior) {
      throw new ClaudeProtocolError(
        'INTERACTION_ACTION_NOT_FOUND',
        'Interaction action has no native approval behavior mapping.',
      );
    }
    return behavior;
  }

  private validateInteractionValues(
    interaction: InteractionRef,
    values: Record<string, unknown>,
  ): void {
    const inputs = new Map(interaction.inputs.map((input) => [input.id, input]));
    for (const key of Object.keys(values)) {
      if (!inputs.has(key)) {
        throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${key} was not advertised.`);
      }
    }
    for (const input of interaction.inputs) {
      const value = values[input.id];
      if (value === undefined) {
        if (input.required) {
          throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${input.id} is required.`);
        }
        continue;
      }
      switch (input.type) {
        case 'text':
        case 'multiline_text':
          if (typeof value !== 'string') {
            throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${input.id} must be a string.`);
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${input.id} must be a boolean.`);
          }
          break;
        case 'single_select':
          if (typeof value !== 'string' || !input.choices?.some((choice) => choice.value === value)) {
            throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${input.id} has an invalid choice.`);
          }
          break;
        case 'multi_select':
          if (!Array.isArray(value)
            || !value.every((item) => typeof item === 'string')
            || !value.every((item) => input.choices?.some((choice) => choice.value === item))) {
            throw new ClaudeProtocolError('INVALID_PARAMS', `Interaction input ${input.id} has invalid choices.`);
          }
          break;
      }
    }
  }

  private async renameSession(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const name = typeof params.name === 'string' ? params.name : '';
    if ([...name].length > 200) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'Session name must not exceed 200 Unicode code points.');
    }
    session.displayName = name;
    renameClaudeNativeSession(session.nativeSessionId, session.cwd, name);
    return { ok: true as const };
  }

  private async closeSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    const streamId = nonEmptyString(params.streamId);
    if (!sessionId || !streamId) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'sessionId and streamId are required.');
    }
    const closed = this.closedAttaches.get(sessionId);
    if (closed?.streamId === streamId) return { ok: true as const };
    const session = this.requireAttached(sessionId, streamId);
    const activeTurn = this.activeTurnBySession.get(session.id);
    if (activeTurn) {
      try {
        await this.service.interruptTurn({ sessionId: session.serviceSessionId });
      } catch {
        /* already idle */
      }
    }
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    if (activeTurn) {
      this.resolveInteractionsForTurn(session, activeTurn, 'turn_ended');
      this.closeOpenWork(session, activeTurn, 'cancelled');
      this.emitTurnEvent('turn.completed', session, activeTurn, {
        stopReason: 'cancelled',
      }, turnCompletedEventId(this.activeTurnStateBySession.get(session.id)?.sourceTurnId ?? activeTurn));
      this.clearTurn(session.id, activeTurn);
    }
    this.historyWatchers.get(session.id)?.stop();
    this.historyWatchers.delete(session.id);
    this.ledger.close(session.id);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    for (const [responseKey, response] of this.interactionResponses) {
      if (response.sessionId === session.id) this.interactionResponses.delete(responseKey);
    }
    this.creationFingerprints.delete(session.id);
    this.replayBySession.delete(session.id);
    this.replayTrackers.delete(session.id);
    this.replayPager.close(session.id);
    this.closedAttaches.set(session.id, { streamId, closedAt: new Date().toISOString() });
    return { ok: true as const };
  }

  private async listNative(params: Record<string, unknown>) {
    const sessions = listClaudeNativeSessions(typeof params.cwd === 'string' ? params.cwd : undefined);
    const offset = params.cursor === null || params.cursor === undefined
      ? 0
      : Number.parseInt(String(params.cursor), 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > sessions.length) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'Invalid native session cursor.');
    }
    const limit = this.positiveLimit(params.limit, 100);
    const end = Math.min(offset + limit, sessions.length);
    return {
      sessions: sessions.slice(offset, end),
      nextCursor: end < sessions.length ? String(end) : null,
    };
  }

  private replay(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const limit = this.positiveLimit(params.limit, 100);
    const state = this.replayBySession.get(session.id)
      ?? { streamId: stableId('replay', session.id), events: [] };
    const result = this.replayPager.page(
      session.id,
      state,
      params.cursor === null || typeof params.cursor === 'string' ? params.cursor : null,
      limit,
    );
    if (result.nextCursor === null) {
      this.replayTrackers.get(session.id)?.acknowledge();
      const replay = this.replayTrackers.get(session.id)?.replay();
      if (replay) this.replayBySession.set(session.id, replay);
    }
    return result;
  }

  private positiveLimit(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    const limit = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ClaudeProtocolError('INVALID_PARAMS', 'limit must be a positive safe integer <= 500.');
    }
    return limit;
  }

  private translateEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'debug') return;
    const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
    if (!session) return;
    const data = record(params.data);
    const serviceTurnId = nonEmptyString(params.turnId);
    const requestRef = this.turnsByRequest.get(String(params.requestId ?? ''));
    const activeHostTurn = this.activeTurnBySession.get(session.id);
    const interactionRef = method === 'approval.resolved'
      ? this.interactions.get(String(data.approvalId ?? ''))
      : undefined;

    let turnId: string | null = null;
    if (requestRef && activeHostTurn === requestRef.turnId) {
      turnId = requestRef.turnId;
    } else if (serviceTurnId && activeHostTurn) {
      const state = this.activeTurnStateBySession.get(session.id);
      if (state?.serviceTurnId === serviceTurnId) turnId = activeHostTurn;
    } else if (interactionRef && activeHostTurn === interactionRef.turnId) {
      turnId = interactionRef.turnId;
    }
    if (!turnId) return;
    const sourceTurnId = this.activeTurnStateBySession.get(session.id)?.sourceTurnId;

    switch (method) {
      case 'turn.started':
        if (this.startedTurns.has(this.turnKey(session.id, turnId))) return;
        this.startedTurns.add(this.turnKey(session.id, turnId));
        if (serviceTurnId) {
          const state = this.activeTurnStateBySession.get(session.id);
          if (state) state.serviceTurnId = serviceTurnId;
        }
        this.updateSession(session, { state: 'running', lastError: null });
        if (sourceTurnId) {
          this.emitTurnEvent('turn.started', session, turnId, {}, turnStartedEventId(sourceTurnId));
        }
        {
          const key = this.turnKey(session.id, turnId);
          const pendingUsage = this.pendingUsageByTurn.get(key);
          if (pendingUsage) {
            this.pendingUsageByTurn.delete(key);
            this.emitTurnEvent('usage.updated', session, turnId, pendingUsage);
          }
        }
        return;
      case 'output.text':
        this.emitContent(session, turnId, data, 'text');
        return;
      case 'output.reasoning':
        this.emitContent(session, turnId, data, 'reasoning');
        return;
      case 'tool.use': {
        const activityId = nonEmptyString(data.callId);
        if (!activityId) return;
        const name = nonEmptyString(data.toolName) ?? 'unknown';
        const meta: ActivityMeta = {
          kind: 'tool',
          title: name,
          presentation: {
            type: 'tool',
            data: {
              name,
              ...(data.input !== undefined ? { input: jsonValue(data.input) } : {}),
            },
          },
        };
        this.openActivitiesByTurn.get(this.turnKey(session.id, turnId))?.set(activityId, meta);
        this.emitActivity(session, turnId, activityId, 'running', meta, sourceTurnId);
        return;
      }
      case 'tool.result': {
        const activityId = nonEmptyString(data.callId);
        if (!activityId) return;
        const open = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
        const meta = open?.get(activityId);
        if (!open || !meta) return;
        open.delete(activityId);
        const isError = data.isError === true;
        this.emitActivity(session, turnId, activityId, isError ? 'failed' : 'succeeded', {
          ...meta,
          presentation: {
            type: 'tool',
            data: {
              name: (meta.presentation.data as Record<string, unknown> | null)?.name ?? 'tool',
              ...(data.output !== undefined ? { output: jsonValue(data.output) } : {}),
            },
          },
        }, sourceTurnId);
        return;
      }
      case 'claude.task': {
        const agentId = nonEmptyString(data.taskId);
        if (!agentId) return;
        const state = agentState(data.status);
        const open = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
        const meta: ActivityMeta = {
          kind: 'agent',
          title: String(data.description ?? 'Agent'),
          presentation: {
            type: 'agent',
            data: {
              agentId,
              state,
              ...(nonEmptyString(data.agentType) ? { displayName: data.agentType } : {}),
              ...(nonEmptyString(data.summary) ? { output: data.summary } : {}),
            },
          },
        };
        if (state === 'running') open?.set(agentId, meta);
        else open?.delete(agentId);
        this.emitActivity(session, turnId, agentId, agentActivityStatus(state), meta, sourceTurnId);
        return;
      }
      case 'auto.classifier_denied':
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: randomUUID(),
          kind: 'notice',
          title: 'Action blocked',
          status: 'succeeded',
          presentation: {
            type: 'notice',
            tone: 'warning',
            data: {
              message: String(data.reason ?? data.action ?? ''),
              code: 'CLAUDE_AUTO_CLASSIFIER_DENIED',
            },
          },
        });
        return;
      case 'auto.circuit_breaker':
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: randomUUID(),
          kind: 'notice',
          title: 'Automatic execution stopped',
          status: 'succeeded',
          presentation: {
            type: 'notice',
            tone: 'danger',
            data: {
              message: `Claude stopped after repeated blocked actions (${String(data.trigger ?? 'limit')}).`,
              code: 'CLAUDE_AUTO_CIRCUIT_BREAKER',
            },
          },
        });
        return;
      case 'token_usage.updated': {
        const usage = sanitizeUsage(data);
        if (!usage) return;
        const conversation = record(usage.conversation);
        if (conversation.mode === 'delta' && !turnId) return;
        if (turnId) {
          const key = this.turnKey(session.id, turnId);
          if (!this.startedTurns.has(key)) this.pendingUsageByTurn.set(key, usage);
          else this.emitTurnEvent('usage.updated', session, turnId, usage);
        }
        else this.emitSessionEvent('usage.updated', session, usage);
        return;
      }
      case 'approval.requested': {
        const interactionId = nonEmptyString(data.approvalId);
        if (!interactionId) return;
        const toolName = String(data.toolName ?? '');
        const payload = parseInputPreview(data.inputPreview);
        const inputs = questionInputs(payload);
        const question = toolName === 'AskUserQuestion' || inputs.length > 0;
        const actions = question
          ? [
              { id: 'allow_once', label: 'Submit', style: actionStyle('allow_once') },
              { id: 'reject_once', label: 'Cancel', style: actionStyle('reject_once') },
            ]
          : [
              { id: 'allow_once', label: 'Allow once', style: actionStyle('allow_once') },
              { id: 'reject_once', label: 'Reject', style: actionStyle('reject_once') },
            ];
        this.interactions.set(interactionId, {
          sessionId: session.id,
          turnId,
          serviceApprovalId: interactionId,
          actionIds: actions.map((action) => action.id),
          inputs,
          responses: new Map(),
        });
        this.updateSession(session, { state: 'waiting_interaction' });
        this.emitTurnEvent('interaction.requested', session, turnId, {
          interactionId,
          title: toolName ? `${toolName} requires approval` : 'Review request',
          description: String(data.description ?? ''),
          presentation: {
            kind: question ? 'question' : 'permission',
            tone: question ? 'neutral' : 'warning',
          },
          inputs,
          actions,
          context: {
            subject: jsonValue({
              toolName,
              inputPreview: data.inputPreview ?? '',
            }),
          },
        });
        return;
      }
      case 'approval.resolved': {
        const interactionId = String(data.approvalId ?? '');
        const interaction = this.interactions.get(interactionId);
        if (!interaction) return;
        this.interactions.delete(interactionId);
        const submitted = interaction.responses.size > 0;
        const last = [...interaction.responses.values()].at(-1);
        const waiting = [...this.interactions.values()].some((item) => (
          item.sessionId === session.id && item.turnId === turnId
        ));
        this.updateSession(session, { state: waiting ? 'waiting_interaction' : 'running' });
        this.emitTurnEvent('interaction.resolved', session, turnId, submitted && last
          ? {
              interactionId,
              outcome: 'submitted',
              actionId: last.actionId,
              displaySummary: this.interactionSummary(last.actionId, interaction),
            }
          : {
              interactionId,
              outcome: 'cancelled',
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
        this.emitSessionEvent('session.updated', session, sessionUpdatedData({
          nativeSession: { id: nativeSessionId },
          updatedAt: session.updatedAt,
        }));
        this.emitSessionEvent('usage.updated', session, {
          context: null,
          conversation: { mode: 'reset' },
        });
        return;
      }
      case 'turn.completed':
        this.completeTurn(session, turnId, false, 'completed');
        return;
      case 'turn.failed':
        this.completeTurn(
          session,
          turnId,
          true,
          String(data.error ?? data.message ?? 'Claude turn failed.'),
        );
        return;
      case 'claude.unknown_event':
      case 'unknown_event': {
        const event = record(data.event);
        const eventType = nonEmptyString(event.type) ?? nonEmptyString(data.eventType) ?? 'unknown';
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: randomUUID(),
          kind: `claude.${eventType}`,
          title: `Claude event: ${eventType}`,
          status: 'succeeded',
          presentation: {
            type: 'generic',
            tone: 'info',
          },
          details: { event: boundedJson(event) },
        });
        return;
      }
      default:
        // A service event added in a future cc-proxy release must never be
        // silently dropped. Degrade it to a generic diagnostic activity.
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: randomUUID(),
          kind: `claude.internal.${method}`,
          title: `Claude event: ${method}`,
          status: 'succeeded',
          presentation: { type: 'generic', tone: 'info' },
          details: { event: boundedJson(data) },
        });
    }
  }

  private interactionSummary(actionId: string, interaction: InteractionRef): string | undefined {
    const action = interaction.actionIds.includes(actionId) ? actionId : '';
    if (!action) return undefined;
    if (interaction.inputs.length === 0) return action;
    return undefined;
  }

  private emitActivity(
    session: AttachedSession,
    turnId: string,
    activityId: string,
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled',
    meta: ActivityMeta,
    sourceTurnId?: string,
  ): void {
    this.emitTurnEvent('activity.updated', session, turnId, {
      activityId,
      kind: meta.kind,
      title: meta.title,
      status,
      presentation: meta.presentation,
    }, sourceTurnId
      ? activityEventId(sourceTurnId, activityId, status)
      : randomUUID());
  }

  private emitContent(
    session: AttachedSession,
    turnId: string,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    const delta = String(data.text ?? data.delta ?? '');
    if (!delta) return;
    const nativeItemId = nonEmptyString(data.itemId)
      ?? stableId('content', { session: session.id, turnId });
    const contentId = `${kind}:${nativeItemId}`;
    this.openContentByTurn.get(this.turnKey(session.id, turnId))?.set(contentId, kind);
    const textByContent = this.contentTextByTurn.get(this.turnKey(session.id, turnId));
    textByContent?.set(contentId, `${textByContent.get(contentId) ?? ''}${delta}`);
    this.emitTurnEvent('content.delta', session, turnId, {
      contentId,
      kind,
      ...(kind === 'text' ? { format: 'plain' as const } : {}),
      delta,
    });
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    detail: string,
  ): void {
    if (this.activeTurnBySession.get(session.id) !== turnId) return;
    const sourceTurnId = this.activeTurnStateBySession.get(session.id)?.sourceTurnId ?? turnId;
    this.resolveInteractionsForTurn(session, turnId, failed ? 'runtime_ended' : 'turn_ended');
    this.closeOpenWork(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      this.updateSession(session, { state: 'error', lastError: detail });
      this.emitTurnEvent('turn.failed', session, turnId, {
        error: {
          domainCode: isClaudeAuthError(detail) ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_ERROR',
          message: detail,
          retryable: false,
          details: {},
        },
      }, turnFailedEventId(sourceTurnId));
    } else {
      this.updateSession(session, { state: 'idle', lastError: null });
      this.emitTurnEvent('turn.completed', session, turnId, {
        stopReason: 'completed',
      }, turnCompletedEventId(sourceTurnId));
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

  private closeOpenWork(
    session: AttachedSession,
    turnId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): void {
    const sourceTurnId = this.activeTurnStateBySession.get(session.id)?.sourceTurnId;
    const contents = this.openContentByTurn.get(this.turnKey(session.id, turnId));
    if (contents) {
      for (const [contentId, kind] of contents) {
        const content = this.contentTextByTurn.get(this.turnKey(session.id, turnId))?.get(contentId);
        this.emitTurnEvent('content.completed', session, turnId, {
          contentId,
          kind,
          ...(kind === 'text' ? { format: 'plain' as const } : {}),
          ...(content !== undefined ? { content } : {}),
        }, sourceTurnId ? contentCompletedEventId(sourceTurnId, contentId) : randomUUID());
      }
      contents.clear();
      this.contentTextByTurn.get(this.turnKey(session.id, turnId))?.clear();
    }
    const activities = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
    if (activities) {
      for (const [activityId, meta] of activities) {
        this.emitActivity(session, turnId, activityId, status, {
          ...meta,
          presentation: {
            ...meta.presentation,
            data: {
              ...(record(meta.presentation.data)),
              ...(meta.presentation.type === 'agent'
                ? { state: status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'interrupted' : 'failed' }
                : {}),
            },
          },
        }, sourceTurnId);
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

  private emitSessionEvent(
    method: string,
    session: AttachedSession,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    this.enqueueNotification(method, {
      eventId: randomUUID(),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private emitTurnEvent(
    method: string,
    session: AttachedSession,
    turnId: string,
    data: Record<string, unknown>,
    eventId: string = randomUUID(),
  ): void {
    const sourceTurnId = this.activeTurnStateBySession.get(session.id)?.sourceTurnId;
    if (!sourceTurnId) return;
    session.sequence += 1;
    this.enqueueNotification(method, {
      eventId,
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      turnId,
      sourceTurnId,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private enqueueNotification(method: string, params: Record<string, unknown>): void {
    if (this.deferDepth > 0) {
      this.deferredNotifications.push({ method, params });
      return;
    }
    this.emitEvent(method, params);
  }

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.activeTurnStateBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.pendingUsageByTurn.delete(key);
    this.acceptedInterruptTurns.delete(key);
    this.openActivitiesByTurn.delete(key);
    this.openContentByTurn.delete(key);
    this.contentTextByTurn.delete(key);
    const requestKey = this.requestByTurn.get(key);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(key);
  }

  private turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
  }

  private rememberCatalogModels(models: ModelCapabilities[]): void {
    this.runtimeModelByCatalogId.clear();
    for (const model of models) {
      this.runtimeModelByCatalogId.set(model.id, model.model);
    }
    this.catalogModelsLoaded = true;
  }

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
      state: session.state,
      sessionConfig: session.sessionConfig,
      lastError: session.lastError,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    if (this.closedAttaches.has(sessionId)) {
      throw new ClaudeProtocolError('SESSION_CLOSED', 'Session is closed.');
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new ClaudeProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    return session;
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new ClaudeProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): void {
    if (this.activeTurnBySession.get(sessionId) !== turnId) {
      throw new ClaudeProtocolError('TURN_NOT_FOUND', 'Turn is not active.');
    }
  }
}
