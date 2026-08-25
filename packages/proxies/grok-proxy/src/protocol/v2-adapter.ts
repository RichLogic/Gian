import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { OpaqueSidechatResumeStore } from '@gian/proxy-protocol';

import { toV2ConfigOptions } from '../core/catalog.js';
import { GrokProxyError } from '../core/errors.js';
import {
  extensionName,
  isExcludedExtension,
  sessionUpdateText,
  translateExtension,
  translateSessionUpdate,
} from '../core/events.js';
import { normalizeInputItems } from '../core/input.js';
import { parseGrokPermissionMode } from '../core/permissions.js';
import { filterAdvertisedCommands } from '../core/slash-policy.js';
import { GrokProxyService } from '../core/service.js';
import { NativeTurnIdentityStore } from './replay-identity.js';
import { GrokJsonRpcError, GrokProtocolError, type DomainCode } from '../transport/protocol.js';

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
      throw new GrokProtocolError('SESSION_NOT_FOUND', `Session ${params.sessionId} is not attached.`);
    }
    if (active !== params.streamId) {
      throw new GrokProtocolError('SESSION_STALE', `Stream ${params.streamId} is no longer active.`);
    }
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    const fingerprint = JSON.stringify({ input: params.input, config: params.config });
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return 'new';
    }
    if (existing !== fingerprint) {
      throw new GrokProtocolError('CONFLICT', `Turn ${params.turnId} was reused with different input.`);
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
      throw new GrokJsonRpcError(-32602, 'Replay cursor has no active snapshot.');
    }
    if (cursor === null) this.active.set(sessionId, snapshot);
    const offset = cursor === null || /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor ?? 0) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.events.length) {
      throw new GrokJsonRpcError(-32602, 'Invalid replay cursor.');
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
  sessionConfig: Record<string, ConfigValue>;
  sequence: number;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

interface InteractionRef extends HostTurnRef {
  serviceApprovalId: string;
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
  sequence: number;
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
}

const PROTOCOL_NAME = 'gian.proxy';
const PROTOCOL_V2 = '2.0';
const REPLAYABLE = new Set([
  'turn.started',
  'input.recorded',
  'content.delta',
  'content.completed',
  'turn.completed',
  'turn.failed',
  'activity.updated',
  'interaction.requested',
  'interaction.resolved',
  'plan.updated',
  'diff.updated',
  'usage.updated',
]);

const CAPABILITIES = {
  'input.localFile': 1,
  'input.localImage': 1,
  'session.rename': 1,
  'session.native.list': 1,
  'session.native.delete': 1,
  'session.replay': 1,
  sidechat: 1,
  'session.fork': 1,
  'turn.steer': 1,
  interaction: 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.diff': 1,
  'event.usage': 1,
} as const;

const CONFIG_APPLY_ORDER = ['permission_mode', 'model', 'reasoning_effort'] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
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

function standardError(error: unknown): GrokProtocolError | GrokJsonRpcError {
  if (error instanceof GrokProtocolError || error instanceof GrokJsonRpcError) return error;
  if (error instanceof GrokProxyError) {
    if (error.code === 'INVALID_REQUEST') {
      return new GrokJsonRpcError(-32602, error.message);
    }
    const code: DomainCode = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'APPROVAL_NOT_FOUND': return 'INTERACTION_NOT_FOUND';
        case 'INVALID_APPROVAL_OPTION': return 'INTERACTION_ACTION_NOT_FOUND';
        case 'NATIVE_SESSION_ATTACHED': return 'CONFLICT';
        case 'AUTH_REQUIRED': return 'RUNTIME_AUTH_REQUIRED';
        case 'CAPABILITY_NOT_SUPPORTED': return 'CAPABILITY_NOT_SUPPORTED';
        case 'TURN_NOT_FOUND': return 'TURN_NOT_FOUND';
        case 'CONFLICT': return 'CONFLICT';
        case 'NATIVE_SESSION_NOT_FOUND': return 'NATIVE_SESSION_NOT_FOUND';
        case 'RUNTIME_UNAVAILABLE': return 'RUNTIME_UNAVAILABLE';
        default: return 'RUNTIME_ERROR';
      }
    })();
    return new GrokProtocolError(code, error.message, false);
  }
  return new GrokProtocolError(
    /auth|login/i.test(error instanceof Error ? error.message : String(error))
      ? 'RUNTIME_AUTH_REQUIRED'
      : 'INTERNAL',
    error instanceof Error ? error.message : String(error),
  );
}

function actionStyle(optionId: string): 'primary' | 'secondary' | 'danger' {
  const id = optionId.toLowerCase();
  if (id.includes('reject') || id.includes('deny') || id.includes('cancel')) return 'danger';
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

export class GrokProtocolV2Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly creationFingerprints = new Map<string, string>();
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  /** Maps turn ids minted by GrokProxyService to the Host turn.start id. */
  private readonly hostTurnByServiceTurn = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private readonly interruptedTurns = new Set<string>();
  private readonly interactions = new Map<string, InteractionRef>();
  private readonly openActivitiesByTurn = new Map<string, Set<string>>();
  private readonly openContentByTurn = new Map<string, Map<string, {
    kind: 'text' | 'reasoning' | 'status';
    deltaCount: number;
  }>>();
  private readonly eventOccurrences = new Map<string, number>();
  private readonly emittedFactsByTurn = new Map<string, Map<string, string>>();
  private readonly genericActivityCounts = new Map<string, number>();
  private readonly replayBySession = new Map<string, ReplayState>();
  private readonly replayPager = new ReplayPager();
  private readonly ledger = new TurnLedger();
  private initialized = false;
  private catalogRevision = 'grok-empty';
  private readonly resumeStore = new OpaqueSidechatResumeStore();
  private readonly sidechats = new Map<string, SidechatRecord>();
  private readonly terminalOrderBySession = new Map<string, Array<{ turnId: string; sourceTurnId: string }>>();
  private readonly forkResults = new Map<string, { fingerprint: string; result: unknown }>();
  private holdCount = 0;
  private readonly heldNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(
    private readonly service: GrokProxyService,
    private readonly pluginVersion: string,
    private readonly sink: V2EventSink,
    private readonly identityStore = new NativeTurnIdentityStore(),
  ) {
    service.setEventSink((method, params) => this.translateServiceEvent(method, params));
  }

  beginRequest(): void {
    this.holdCount += 1;
  }

  flushNotifications(): void {
    this.holdCount = Math.max(0, this.holdCount - 1);
    if (this.holdCount > 0) return;
    const pending = this.heldNotifications.splice(0);
    for (const item of pending) this.sink(item.method, item.params);
  }

  private emitEvent(method: string, params: Record<string, unknown>): void {
    if (this.holdCount > 0) this.heldNotifications.push({ method, params });
    else this.sink(method, params);
  }

  async handle(request: WireRequest): Promise<unknown> {
    if (!this.initialized && request.method !== 'initialize' && request.method !== 'shutdown') {
      throw new GrokProtocolError('NOT_INITIALIZED', 'initialize must be the first request.');
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
      case 'turn.start': return this.startTurn(request.params);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'turn.steer': return this.steer(request.params);
      case 'interaction.respond': return this.respondInteraction(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'session.rename': return this.rename(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.native.delete': return this.deleteNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'catalog.resolve':
        throw new GrokProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'catalog.resolve is not advertised by Grok Proxy.',
        );
      case 'shutdown': return { ok: true };
      default:
        throw new GrokJsonRpcError(-32601, `Unknown method "${request.method}".`);
    }
  }

  private initialize(params: Record<string, unknown>) {
    if (this.initialized) {
      throw new GrokProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.');
    }
    const protocol = record(params.protocol);
    const versions = Array.isArray(protocol.versions) ? protocol.versions.map(String) : [];
    if (protocol.name !== PROTOCOL_NAME || !versions.includes(PROTOCOL_V2)) {
      throw new GrokProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.0 is required.');
    }
    this.initialized = true;
    return {
      protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V2 },
      plugin: { id: 'grok', name: 'Grok Build', version: this.pluginVersion },
      process: { scope: 'session' as const },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const raw = this.sessions.size > 0
      ? this.service.currentCatalog()
      : await this.service.listCapabilities();
    const configOptions = toV2ConfigOptions(raw.sessionOptions);
    const slashCommands = [] as Array<{
      name: string;
      description: string;
      source: 'builtin';
      argHints: Array<{ kind: 'free'; placeholder: string }>;
    }>;
    if (this.sessions.size > 0) {
      try {
        const listed = await this.service.listSlashCommands();
        for (const command of filterAdvertisedCommands(listed.commands)) {
          slashCommands.push({
            name: command.name.startsWith('/') ? command.name : `/${command.name}`,
            description: command.description ?? '',
            source: 'builtin',
            argHints: command.input && typeof command.input === 'object' && 'hint' in command.input && command.input.hint
              ? [{ kind: 'free', placeholder: String(command.input.hint) }]
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
      configOptions,
      actions: [
        {
          id: 'sidechat.create',
          supported: this.service.supportsFork(),
          ...(this.service.supportsFork() ? {} : { reason: 'Current Grok ACP runtime does not support session/fork.' }),
        },
        {
          id: 'session.fork',
          supported: this.service.supportsFork(),
          ...(this.service.supportsFork() ? {} : { reason: 'Current Grok ACP runtime does not support session/fork.' }),
        },
        { id: 'session.fork.atTurn', supported: false, reason: 'Grok ACP only forks the current head.' },
      ],
      slashCommands,
    };
    payload.catalogRevision = stableId('catalog', {
      input: payload.input,
      configOptions,
      actions: payload.actions,
    });
    this.catalogRevision = payload.catalogRevision;
    return payload;
  }

  private advertisedOptionIds(): Set<string> {
    return new Set(this.service.currentCatalog().sessionOptions.map((option) => option.id));
  }

  private advertisedOptions() {
    return toV2ConfigOptions(this.service.currentCatalog().sessionOptions);
  }

  private optionConditions(
    option: ReturnType<GrokProtocolV2Adapter['advertisedOptions']>[number],
    field: 'visibleWhen' | 'enabledWhen',
  ): ReadonlyArray<{ optionId: string; oneOf: readonly ConfigValue[] }> | undefined {
    const value = (option as Record<string, unknown>)[field];
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is { optionId: string; oneOf: ConfigValue[] } => (
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as { optionId?: unknown }).optionId === 'string'
      && Array.isArray((item as { oneOf?: unknown }).oneOf)
    ));
  }

  private conditionsMet(
    conditions: ReadonlyArray<{ optionId: string; oneOf: readonly ConfigValue[] }> | undefined,
    values: Record<string, unknown>,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((condition) => (
      condition.oneOf.some((item) => Object.is(item, values[condition.optionId]))
    ));
  }

  private valueMatchesOption(
    option: ReturnType<GrokProtocolV2Adapter['advertisedOptions']>[number],
    value: ConfigValue,
  ): boolean {
    if (value === null) return option.required !== true;
    if (option.control === 'select') {
      return Boolean(option.choices?.some((choice) => Object.is(choice.value, value)));
    }
    const constraints = 'constraints' in option
      ? option.constraints as {
        minimum?: number;
        maximum?: number;
        step?: number;
        minimumLength?: number;
        maximumLength?: number;
      } | undefined
      : undefined;
    if (option.control === 'boolean') return typeof value === 'boolean';
    if (option.control === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (constraints?.minimum !== undefined && value < constraints.minimum) return false;
      if (constraints?.maximum !== undefined && value > constraints.maximum) return false;
      if (
        constraints?.step !== undefined
        && constraints.minimum !== undefined
        && Math.abs(((value - constraints.minimum) / constraints.step)
          - Math.round((value - constraints.minimum) / constraints.step)) > 1e-9
      ) {
        return false;
      }
      return true;
    }
    if (option.control === 'text') {
      if (typeof value !== 'string') return false;
      const length = [...value].length;
      if (constraints?.minimumLength !== undefined && length < constraints.minimumLength) return false;
      if (constraints?.maximumLength !== undefined && length > constraints.maximumLength) return false;
      return true;
    }
    return isConfigValue(value);
  }

  private validateConfig(
    config: Record<string, unknown>,
    expectedBinding: 'session' | 'turn',
    sessionValues: Record<string, ConfigValue> = {},
  ): Record<string, ConfigValue> {
    const advertised = new Map(this.advertisedOptions().map((option) => [option.id, option]));
    const next: Record<string, ConfigValue> = {};
    const visibleValues = { ...sessionValues, ...config };
    for (const [configId, value] of Object.entries(config)) {
      const option = advertised.get(configId);
      if (!option) {
        throw new GrokProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
      }
      if (option.binding !== expectedBinding) {
        throw new GrokProtocolError(
          'CONFIG_BINDING_INVALID',
          `Config option ${configId} is ${option.binding}-bound.`,
        );
      }
      if (!isConfigValue(value) || !this.valueMatchesOption(option, value)) {
        throw new GrokProtocolError(
          'CONFIG_VALUE_INVALID',
          `Grok config ${configId} value was not advertised.`,
        );
      }
      if (!this.conditionsMet(this.optionConditions(option, 'visibleWhen'), visibleValues)
        || !this.conditionsMet(this.optionConditions(option, 'enabledWhen'), visibleValues)) {
        throw new GrokProtocolError(
          'CONFIG_VALUE_INVALID',
          `Grok config ${configId} is not enabled for the current values.`,
        );
      }
      next[configId] = value;
    }
    for (const [configId, option] of advertised) {
      if (option.binding !== expectedBinding || !option.required) continue;
      if (!this.conditionsMet(this.optionConditions(option, 'visibleWhen'), visibleValues)) {
        continue;
      }
      if (!this.conditionsMet(this.optionConditions(option, 'enabledWhen'), visibleValues)) {
        continue;
      }
      if (config[configId] === undefined) {
        throw new GrokProtocolError('CONFIG_REQUIRED', `Config option ${configId} is required.`);
      }
    }
    return next;
  }

  private sessionCreateFingerprint(params: Record<string, unknown>): string {
    const workspace = record(params.workspace);
    const rawCwd = nonEmptyString(workspace.cwd);
    const cwd = rawCwd ? resolve(rawCwd) : '';
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.filter((item): item is string => typeof item === 'string').map((root) => resolve(root))
      : [];
    return JSON.stringify({
      sessionId: params.sessionId ?? null,
      cwd,
      roots,
      nativeSession: record(params.nativeSession),
      config: record(params.config),
      hostServices: params.hostServices ?? null,
    });
  }

  private async applyConfigMap(serviceSessionId: string, config: Record<string, unknown>) {
    const advertised = this.advertisedOptionIds();
    const ordered = [
      ...CONFIG_APPLY_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(config, key)),
      ...Object.keys(config).filter((key) => !CONFIG_APPLY_ORDER.includes(key as typeof CONFIG_APPLY_ORDER[number])),
    ];
    for (const configId of ordered) {
      if (!advertised.has(configId)) {
        throw new GrokProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
      }
      const value = config[configId];
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new GrokProtocolError(
          'CONFIG_VALUE_INVALID',
          `Grok config ${configId} must be string or boolean.`,
        );
      }
      try {
        await this.service.setConfigOption({
          sessionId: serviceSessionId,
          configId,
          value,
        });
      } catch (error) {
        if (error instanceof GrokProxyError && error.code === 'INVALID_REQUEST') {
          throw new GrokProtocolError('CONFIG_VALUE_INVALID', error.message);
        }
        throw standardError(error);
      }
    }
  }

  private sessionConfigFromRequested(requested: Record<string, unknown>): Record<string, ConfigValue> {
    const next: Record<string, ConfigValue> = {};
    for (const option of toV2ConfigOptions(this.service.currentCatalog().sessionOptions)) {
      const value = requested[option.id] !== undefined
        ? requested[option.id]
        : option.defaultValue;
      if (isConfigValue(value)) next[option.id] = value;
    }
    return next;
  }

  private async createSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    if (!sessionId) throw new GrokJsonRpcError(-32602, 'sessionId is required.');
    const fingerprint = this.sessionCreateFingerprint(params);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.sidechats.has(sessionId)) {
        throw new GrokProtocolError('SESSION_NOT_FOUND', 'Session not found.');
      }
      if (this.creationFingerprints.get(sessionId) === fingerprint) {
        return { session: this.serialize(existing) };
      }
      throw new GrokProtocolError('CONFLICT', 'Session is already attached with different parameters.');
    }
    const workspace = record(params.workspace);
    const rawCwd = nonEmptyString(workspace.cwd);
    if (!rawCwd) throw new GrokJsonRpcError(-32602, 'workspace.cwd is required.');
    const cwd = resolve(rawCwd);
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.filter((item): item is string => typeof item === 'string').map((root) => resolve(root))
      : [];
    const uniqueRoots = [...new Set(roots)];
    if (uniqueRoots.length !== 1 || uniqueRoots[0] !== cwd) {
      throw new GrokProtocolError(
        'CONFIG_VALUE_INVALID',
        'Grok workspace sandbox requires workspace.roots to be exactly the session cwd.',
      );
    }
    if (params.hostServices !== undefined) {
      throw new GrokProtocolError(
        'CAPABILITY_NOT_SUPPORTED',
        'Grok Proxy does not advertise integration.mcp.streamableHttp.',
      );
    }
    const config = record(params.config);
    if (Object.keys(config).length > 0 && !this.advertisedOptionIds().has('model')) {
      await this.service.listCapabilities().catch(() => undefined);
    }
    this.validateConfig(config, 'session');
    const native = record(params.nativeSession);
    const nativeSessionId = nonEmptyString(native.id);
    const history = nonEmptyString(native.history);
    if (typeof config.permission_mode === 'string') {
      const permission = parseGrokPermissionMode(config.permission_mode);
      if (!permission) {
        throw new GrokProtocolError('CONFIG_VALUE_INVALID', 'Unknown Grok permission mode.');
      }
      this.service.setPermissionMode(permission);
    }
    const result = await this.service.createSession({
      cwd,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(nativeSessionId
        ? { resumeMode: history === 'none' ? 'resume' as const : 'load' as const }
        : {}),
      mcpServers: [],
    });
    try {
      await this.applyConfigMap(result.session.id, config);
    } catch (error) {
      try {
        await this.service.closeSession({ sessionId: result.session.id });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Grok session configuration failed and cleanup did not complete.',
        );
      }
      throw error;
    }
    const session: AttachedSession = {
      id: sessionId,
      serviceSessionId: result.session.id,
      nativeSessionId: result.session.nativeSessionId,
      streamId: randomUUID(),
      cwd,
      state: result.session.status === 'needs-approval' ? 'waiting_interaction' : 'idle',
      lastError: result.session.lastError,
      createdAt: result.session.createdAt,
      updatedAt: result.session.updatedAt,
      sessionConfig: this.sessionConfigFromRequested(config),
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.creationFingerprints.set(session.id, fingerprint);
    this.ledger.attach(session.id, session.streamId);
    this.replayBySession.set(session.id, {
      streamId: stableId('replay', session.id),
      events: [],
      sequence: 0,
    });
    if (history !== 'none') {
      this.ingestNativeReplay(session, result.replayUpdates as SessionNotification[]);
    }
    void this.publishCatalogIfCommandsArrive();
    return { session: this.serialize(session) };
  }

  private async createSidechat(params: Record<string, unknown>) {
    this.assertForkSupported();
    const parentSessionId = nonEmptyString(params.parentSessionId);
    const parentStreamId = nonEmptyString(params.parentStreamId);
    const sidechatId = nonEmptyString(params.sidechatId);
    if (!parentSessionId || !parentStreamId || !sidechatId) {
      throw new GrokJsonRpcError(-32602, 'parentSessionId, parentStreamId, and sidechatId are required.');
    }
    const parent = this.requireOrdinaryAttached(parentSessionId, parentStreamId);
    const fingerprint = JSON.stringify({ parentSessionId, parentStreamId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw new GrokProtocolError('CONFLICT', 'sidechatId was reused with a different parent.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new GrokProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
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
      throw new GrokJsonRpcError(-32602, 'sidechatId, parentSessionId, and resumeRef are required.');
    }
    if (this.resumeStore.closed(resumeRefId)) {
      throw new GrokProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat was already closed.');
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (!payload) throw new GrokProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat resume reference is unavailable.');
    if (payload.sidechatId !== sidechatId || payload.parentSessionId !== parentSessionId) {
      throw new GrokProtocolError('CONFLICT', 'Side Chat resume identity does not match.');
    }
    const parent = this.requireOrdinarySession(parentSessionId);
    const fingerprint = JSON.stringify({ parentSessionId, resumeRefId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.resumeFingerprint !== fingerprint) {
        throw new GrokProtocolError('CONFLICT', 'Side Chat is already attached with another resume reference.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing, payload.createdAt) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new GrokProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
    }
    const resumed = await this.service.createSession({
      cwd: parent.cwd,
      nativeSessionId: payload.nativeSessionId,
      resumeMode: 'resume',
      mcpServers: [],
      allowAdditional: true,
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
      throw new GrokJsonRpcError(-32602, 'sidechatId and resumeRef are required; streamId must be non-empty.');
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
      throw new GrokProtocolError('CONFLICT', 'resumeRef belongs to another live Side Chat.');
    }
    const live = this.sidechats.get(sidechatId);
    if (live && live.resumeRefId !== resumeRefId) {
      throw new GrokProtocolError('CONFLICT', 'resumeRef belongs to another Side Chat attachment.');
    }
    if (live) {
      const session = this.requireSession(sidechatId);
      if (streamId && session.streamId !== streamId) {
        throw new GrokProtocolError('SESSION_STALE', 'Side Chat stream is stale.');
      }
      await this.detachSession(session);
      this.sidechats.delete(sidechatId);
    }
    // Keep the Provider session intact: Gian invalidates only its encrypted
    // transient reference and reports that native history may remain.
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
      throw new GrokProtocolError(
        anchor.type === 'turn' ? 'CAPABILITY_NOT_SUPPORTED' : 'INVALID_PARAMS',
        anchor.type === 'turn' ? 'Grok ACP does not support exact turn forks.' : 'A head fork anchor is required.',
      );
    }
    const fingerprint = JSON.stringify({ sourceSessionId, sourceStreamId, anchor });
    const previous = this.forkResults.get(sessionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new GrokProtocolError('CONFLICT', 'Fork sessionId was reused with another source boundary.');
      }
      return previous.result;
    }
    if (this.sessions.has(sessionId)) {
      throw new GrokProtocolError('CONFLICT', 'Fork sessionId already belongs to another Session.');
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
      throw new GrokProtocolError('CAPABILITY_NOT_SUPPORTED', 'Current Grok ACP runtime does not support session/fork.');
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
      sessionConfig: { ...sessionConfig },
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.creationFingerprints.set(session.id, `fork:${session.nativeSessionId}`);
    this.ledger.attach(session.id, session.streamId);
    return session;
  }

  private cloneReplay(source: AttachedSession, child: AttachedSession): ReplayState {
    const parent = this.replayBySession.get(source.id) ?? {
      streamId: stableId('replay', source.nativeSessionId),
      events: [],
      sequence: 0,
    };
    const streamId = stableId('replay', child.nativeSessionId);
    return {
      streamId,
      sequence: parent.sequence,
      events: parent.events.map((event) => ({
        ...event,
        sessionId: child.id,
        replayStreamId: streamId,
      })),
    };
  }

  private sidechatAnchor(session: AttachedSession): SidechatAnchor {
    if (this.activeTurnBySession.has(session.id)) {
      throw new GrokProtocolError('SESSION_BUSY', 'Side Chat requires an idle parent Session.');
    }
    const boundary = this.latestTerminalBoundary(session.id);
    if (boundary) return { type: 'turn', ...boundary };
    if ((this.replayBySession.get(session.id)?.events.length ?? 0) === 0) return { type: 'empty' };
    throw new GrokProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'No stable terminal Turn is available in this attach generation.');
  }

  private forkBoundary(session: AttachedSession): { turnId: string; sourceTurnId: string } {
    if (this.activeTurnBySession.has(session.id)) {
      throw new GrokProtocolError('SESSION_BUSY', 'Fork requires an idle source Session.');
    }
    const boundary = this.latestTerminalBoundary(session.id);
    if (!boundary) throw new GrokProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'Fork requires a terminal Turn.');
    return boundary;
  }

  private latestTerminalBoundary(sessionId: string): { turnId: string; sourceTurnId: string } | null {
    return this.terminalOrderBySession.get(sessionId)?.at(-1) ?? null;
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
      lastError: session.lastError,
      createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private async publishCatalogIfCommandsArrive(): Promise<void> {
    try {
      const listed = await this.service.listSlashCommands();
      if (filterAdvertisedCommands(listed.commands).length === 0) return;
      this.emitEvent('catalog.changed', {
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        data: { reason: 'available-commands', revision: this.catalogRevision },
      });
    } catch {
      /* slash discovery is optional */
    }
  }

  private rejectUnsupportedInput(items: unknown[]): void {
    for (const raw of items) {
      if (record(raw).type === 'skill') {
        throw new GrokProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          'Grok Proxy does not advertise input.skill.',
        );
      }
    }
  }

  private async startTurn(params: Record<string, unknown>) {
    const sessionId = String(params.sessionId ?? '');
    const streamId = String(params.streamId ?? '');
    const turnId = nonEmptyString(params.turnId);
    if (!turnId) throw new GrokJsonRpcError(-32602, 'turnId is required.');
    const session = this.requireAttached(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new GrokJsonRpcError(-32602, 'input is required.');
    this.rejectUnsupportedInput(input);
    const config = record(params.config);
    const accepted = this.ledger.accept({ sessionId, streamId, turnId, input, config });
    if (accepted === 'duplicate') return { accepted: true as const, turnId };
    if (this.activeTurnBySession.has(session.id)) {
      this.ledger.forget({ sessionId, streamId, turnId });
      throw new GrokProtocolError('SESSION_BUSY', 'This session already has an active turn.');
    }
    this.activeTurnBySession.set(session.id, turnId);
    this.turnsByRequest.set(turnId, { sessionId: session.id, turnId });
    this.requestByTurn.set(this.turnKey(session.id, turnId), turnId);
    this.openActivitiesByTurn.set(this.turnKey(session.id, turnId), new Set());
    this.openContentByTurn.set(this.turnKey(session.id, turnId), new Map());
    try {
      this.validateConfig(config, 'turn', session.sessionConfig);
      const normalized = normalizeInputItems(input, session.cwd);
      this.identityStore.recordLive(session.nativeSessionId, turnId, normalized);
      await this.service.beginTurn({
        sessionId: session.serviceSessionId,
        input: normalized,
      });
      return { accepted: true as const, turnId };
    } catch (error) {
      this.ledger.forget({ sessionId, streamId, turnId });
      this.clearTurn(session.id, turnId);
      throw standardError(error);
    }
  }

  private async steer(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new GrokJsonRpcError(-32602, 'input is required.');
    this.rejectUnsupportedInput(input);
    await this.service.steerTurn({
      sessionId: session.serviceSessionId,
      input: normalizeInputItems(input, session.cwd),
    });
    return { accepted: true as const, turnId };
  }

  private async interruptTurn(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    this.interruptedTurns.add(this.turnKey(session.id, turnId));
    this.resolveInteractionsForTurn(session, turnId, 'cancelled');
    await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    return { accepted: true as const, turnId };
  }

  private async respondInteraction(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    const interactionId = nonEmptyString(params.interactionId);
    const responseId = nonEmptyString(params.responseId);
    const actionId = nonEmptyString(params.actionId);
    if (!interactionId || !responseId || !actionId) {
      throw new GrokJsonRpcError(-32602, 'interactionId, responseId, and actionId are required.');
    }
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.sessionId !== session.id || interaction.turnId !== turnId) {
      throw new GrokProtocolError('INTERACTION_NOT_FOUND', 'Interaction not found.');
    }
    if (!interaction.actionIds.includes(actionId)) {
      throw new GrokProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Interaction action is not available.');
    }
    const values = record(params.values);
    const previous = interaction.responses.get(responseId);
    if (previous) {
      if (previous.actionId !== actionId || JSON.stringify(previous.values) !== JSON.stringify(values)) {
        throw new GrokProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return { accepted: true as const, interactionId, responseId };
    }
    interaction.responses.set(responseId, { actionId, values });
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: interaction.serviceApprovalId,
        nativeOptionId: actionId,
      });
    } catch (error) {
      interaction.responses.delete(responseId);
      throw standardError(error);
    }
    return { accepted: true as const, interactionId, responseId };
  }

  private async rename(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const name = typeof params.name === 'string' ? params.name : '';
    if ([...name].length > 200) {
      throw new GrokJsonRpcError(-32602, 'Session name must not exceed 200 Unicode code points.');
    }
    await this.service.renameSession({ sessionId: session.serviceSessionId, name });
    return { ok: true as const };
  }

  private async closeSession(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    return this.detachSession(session);
  }

  private async detachSession(session: AttachedSession) {
    const activeTurn = this.activeTurnBySession.get(session.id);
    if (activeTurn) {
      this.resolveInteractionsForTurn(session, activeTurn, 'turn_ended');
      this.closeOpenWork(session, activeTurn, 'cancelled');
      this.emitTurnEvent('turn.completed', session, activeTurn, { stopReason: 'cancelled' });
      this.clearTurn(session.id, activeTurn);
    }
    await this.service.closeSession({ sessionId: session.serviceSessionId });
    this.ledger.close(session.id);
    this.replayPager.close(session.id);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    this.creationFingerprints.delete(session.id);
    this.replayBySession.delete(session.id);
    this.terminalOrderBySession.delete(session.id);
    return { ok: true as const };
  }

  private async listNative(params: Record<string, unknown>) {
    try {
      const result = await this.service.listNativeSessions({
        ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
        ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
      }) as {
        sessions?: Array<{ sessionId?: string; title?: string; cwd?: string; updatedAt?: string }>;
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
    } catch (error) {
      throw standardError(error);
    }
  }

  private async deleteNative(params: Record<string, unknown>) {
    const nativeSessionId = nonEmptyString(params.nativeSessionId);
    if (!nativeSessionId) {
      throw new GrokJsonRpcError(-32602, 'nativeSessionId is required.');
    }
    try {
      await this.service.deleteNativeSession(nativeSessionId);
      return { ok: true as const };
    } catch (error) {
      throw standardError(error);
    }
  }

  private replay(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const limit = typeof params.limit === 'number' ? params.limit : 100;
    const replay = this.replayBySession.get(session.id) ?? {
      streamId: stableId('replay', session.nativeSessionId),
      events: [],
      sequence: 0,
    };
    return this.replayPager.page(
      session.id,
      replay,
      params.cursor === null || typeof params.cursor === 'string' ? params.cursor : null,
      limit,
    );
  }

  private translateServiceEvent(method: string, params: Record<string, unknown>) {
    const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
    if (!session) return;
    const data = record(params.data);
    const interactionRef = method === 'approval.resolved'
      ? this.interactions.get(String(data.approvalId ?? ''))
      : undefined;
    const turnId = this.resolveTurnId(session, params.turnId)
      ?? interactionRef?.turnId
      ?? this.activeTurnBySession.get(session.id);

    if (method === 'turn.started') {
      if (!turnId || this.startedTurns.has(this.turnKey(session.id, turnId))) return;
      this.startedTurns.add(this.turnKey(session.id, turnId));
      this.updateSession(session, { state: 'running', lastError: null });
      this.emitTurnEvent('turn.started', session, turnId, {});
      return;
    }
    if (method === 'turn.completed') {
      if (turnId) this.completeTurn(session, turnId, false, data);
      return;
    }
    if (method === 'turn.failed') {
      if (turnId) this.completeTurn(session, turnId, true, data);
      return;
    }
    if (method === 'usage.updated') {
      const usage = sanitizeUsage(data);
      if (!usage) return;
      if (turnId) this.emitTurnEvent('usage.updated', session, turnId, usage);
      else this.emitSessionEvent('usage.updated', session, usage);
      return;
    }
    if (method === 'approval.requested') {
      if (!turnId) return;
      const interactionId = nonEmptyString(data.approvalId);
      if (!interactionId) return;
      const nativeOptions = Array.isArray(data.options) ? data.options : [];
      const actions = nativeOptions.flatMap((raw) => {
        const option = record(raw);
        const id = nonEmptyString(option.optionId) ?? nonEmptyString(option.id);
        if (!id) return [];
        return [{
          id,
          label: String(option.name ?? option.label ?? id),
          style: actionStyle(id),
        }];
      });
      if (actions.length === 0) return;
      this.interactions.set(interactionId, {
        sessionId: session.id,
        turnId,
        serviceApprovalId: interactionId,
        actionIds: actions.map((action) => action.id),
        responses: new Map(),
      });
      this.updateSession(session, { state: 'waiting_interaction' });
      this.emitTurnEvent('interaction.requested', session, turnId, {
        interactionId,
        title: String(data.title ?? 'Permission'),
        description: String(data.reason ?? ''),
        presentation: { kind: 'permission', tone: 'warning' },
        inputs: [],
        actions,
        ...(data.payload !== undefined ? { context: { subject: jsonValue(data.payload) } } : {}),
      });
      return;
    }
    if (method === 'approval.resolved') {
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
    if (method === 'session.updated') {
      if (typeof data.model === 'string') session.sessionConfig.model = data.model;
      if (typeof data.mode === 'string') session.sessionConfig.permission_mode = data.mode;
      if (data.status === 'stale') {
        this.updateSession(session, {
          state: 'stale',
          lastError: session.lastError ?? 'Grok runtime stopped.',
        });
        this.emitSessionEvent('session.updated', session, {
          state: 'stale',
          lastError: session.lastError,
          updatedAt: session.updatedAt,
        });
        return;
      }
      this.emitSessionEvent('session.updated', session, sessionUpdatedData({
        updatedAt: new Date().toISOString(),
      }));
      return;
    }
    if (method === 'slash.updated') {
      this.emitEvent('catalog.changed', {
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        data: { reason: 'available-commands', revision: this.catalogRevision },
      });
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

  private resolveTurnId(session: AttachedSession, serviceTurnId: unknown): string | undefined {
    const hostTurnId = this.activeTurnBySession.get(session.id);
    if (typeof serviceTurnId !== 'string') return hostTurnId;
    const mapped = this.hostTurnByServiceTurn.get(serviceTurnId);
    if (mapped !== undefined) return mapped;
    if (hostTurnId !== undefined) {
      this.hostTurnByServiceTurn.set(serviceTurnId, hostTurnId);
      return hostTurnId;
    }
    return undefined;
  }

  private forgetServiceTurns(hostTurnId: string): void {
    for (const [serviceTurnId, mapped] of this.hostTurnByServiceTurn) {
      if (mapped === hostTurnId) this.hostTurnByServiceTurn.delete(serviceTurnId);
    }
  }

  private emitTranslated(
    session: AttachedSession,
    turnId: string | undefined,
    event: { method: string; data: Record<string, unknown>; terminal?: 'completed' | 'failed' },
  ) {
    if (event.terminal && !turnId) return;
    if (event.method === 'content.delta') {
      if (!turnId) return;
      const kindRaw = String(event.data.kind ?? 'text');
      const kind = kindRaw === 'reasoning' || kindRaw === 'status' ? kindRaw : 'text';
      const contentId = `${kind}:${turnId}`;
      const contents = this.openContentByTurn.get(this.turnKey(session.id, turnId));
      const open = contents?.get(contentId) ?? { kind, deltaCount: 0 };
      open.deltaCount += 1;
      contents?.set(contentId, open);
      this.emitTurnEvent('content.delta', session, turnId, {
        contentId,
        kind,
        ...(kind === 'text' ? { format: 'plain' } : {}),
        delta: String(event.data.delta ?? ''),
      }, `${contentId}:delta:${open.deltaCount}`);
      return;
    }
    if (event.method === 'diff.updated') {
      if (!turnId) return;
      this.emitTurnEvent('diff.updated', session, turnId, {
        diffId: typeof event.data.diffId === 'string'
          ? event.data.diffId
          : stableId('diff', [turnId, event.data.diff]),
        diff: String(event.data.diff ?? ''),
        truncated: event.data.truncated === true,
        ...(Array.isArray(event.data.files) ? { files: event.data.files } : {}),
      });
      return;
    }
    if (event.method === 'usage.updated') {
      const usage = sanitizeUsage(event.data);
      if (!usage) return;
      if (turnId) this.emitTurnEvent('usage.updated', session, turnId, usage);
      else this.emitSessionEvent('usage.updated', session, usage);
      return;
    }
    if (event.method === 'session.updated') {
      this.emitSessionEvent('session.updated', session, sessionUpdatedData(event.data));
      return;
    }
    if (event.method === 'activity.updated') {
      if (!turnId) return;
      let activityId = nonEmptyString(event.data.activityId);
      if (!activityId) return;
      const presentation = record(event.data.presentation);
      if (presentation.type === 'generic') {
        const countKey = `${this.turnKey(session.id, turnId)}\u0000${activityId}`;
        const count = (this.genericActivityCounts.get(countKey) ?? 0) + 1;
        this.genericActivityCounts.set(countKey, count);
        if (count > 1) activityId = `${activityId}:${count}`;
        event.data = { ...event.data, activityId };
      }
      const open = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
      const status = String(event.data.status ?? 'running');
      if (open && status === 'running') open.add(activityId);
      if (open && status !== 'running') open.delete(activityId);
      this.emitTurnEvent('activity.updated', session, turnId, event.data, activityId);
      return;
    }
    if (event.method === 'plan.updated') {
      if (!turnId) return;
      this.emitTurnEvent('plan.updated', session, turnId, event.data);
      return;
    }
    if (event.terminal === 'completed') {
      if (turnId) this.completeTurn(session, turnId, false, event.data);
      return;
    }
    if (event.terminal === 'failed') {
      if (turnId) this.completeTurn(session, turnId, true, record(event.data.error));
      return;
    }
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    data: Record<string, unknown>,
  ): void {
    if (!this.activeTurnBySession.has(session.id)) return;
    const terminalOrder = this.terminalOrderBySession.get(session.id) ?? [];
    if (!terminalOrder.some((entry) => entry.turnId === turnId)) {
      terminalOrder.push({ turnId, sourceTurnId: turnId });
    }
    this.terminalOrderBySession.set(session.id, terminalOrder);
    this.resolveInteractionsForTurn(session, turnId, failed ? 'runtime_ended' : 'turn_ended');
    this.closeOpenWork(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      const message = String(data.message ?? record(data.error).message ?? 'Grok turn failed.');
      const domainCode = data.code === 'RUNTIME_AUTH_REQUIRED'
        || record(data.error).domainCode === 'RUNTIME_AUTH_REQUIRED'
        ? 'RUNTIME_AUTH_REQUIRED'
        : 'RUNTIME_ERROR';
      this.updateSession(session, { state: 'error', lastError: message });
      this.emitTurnEvent('turn.failed', session, turnId, {
        error: {
          domainCode,
          message,
          retryable: false,
          details: {},
        },
      });
    } else {
      const interrupted = this.interruptedTurns.has(this.turnKey(session.id, turnId));
      const nativeReason = String(data.stopReason ?? data.status ?? '');
      this.updateSession(session, { state: 'idle', lastError: null });
      this.emitTurnEvent('turn.completed', session, turnId, {
        stopReason: this.mapStopReason(nativeReason, interrupted),
      });
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
      for (const [contentId, open] of contents) {
        this.emitTurnEvent('content.completed', session, turnId, {
          contentId,
          kind: open.kind,
          ...(open.kind === 'text' ? { format: 'plain' as const } : {}),
        }, `${contentId}:completed`);
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
        });
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

  private mapStopReason(
    nativeReason: string,
    interrupted: boolean,
  ): 'completed' | 'interrupted' | 'cancelled' | 'limit_reached' | 'refused' | 'other' {
    if (interrupted) return 'interrupted';
    if (nativeReason === 'cancelled' || nativeReason === 'interrupted') return 'cancelled';
    if (nativeReason === 'end_turn' || nativeReason === 'completed' || nativeReason === '') {
      return 'completed';
    }
    if (
      nativeReason === 'limit_reached'
      || nativeReason === 'max_tokens'
      || nativeReason === 'max_tokens_reached'
    ) {
      return 'limit_reached';
    }
    if (nativeReason === 'refused' || nativeReason === 'rejected') return 'refused';
    return 'other';
  }

  private ingestNativeReplay(session: AttachedSession, updates: SessionNotification[]): void {
    const meaningful = updates.filter((notification) => {
      const kind = String(record(notification.update).sessionUpdate ?? '');
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
      updates: meaningful.map((notification) => notification.update),
    });
    if (meaningful.length === 0) {
      this.replayBySession.set(session.id, { streamId, events: [], sequence: 0 });
      return;
    }
    const turns: Array<{ userText: string; updates: SessionNotification[] }> = [];
    let current: { userText: string; updates: SessionNotification[] } | null = null;
    let lastWasUser = false;
    for (const notification of meaningful) {
      const kind = String(record(notification.update).sessionUpdate ?? '');
      if (kind === 'user_message_chunk') {
        if (!current || !lastWasUser) {
          current = { userText: '', updates: [] };
          turns.push(current);
        }
        current.userText += sessionUpdateText(notification.update);
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

    const events: ReplayEvent[] = [];
    const append = (
      sourceTurnId: string,
      method: string,
      data: Record<string, unknown>,
      identity: string,
    ) => {
      events.push({
        method,
        eventId: this.providerEventId(
          session.nativeSessionId,
          sourceTurnId,
          method,
          this.eventFactIdentity(method, data, identity, events.length + 1),
        ),
        sessionId: session.id,
        replayStreamId: streamId,
        sequence: events.length + 1,
        sourceTurnId,
        emittedAt: session.updatedAt,
        data,
      });
    };
    for (const [turnIndex, turn] of turns.entries()) {
      const fallback = stableId('replay-turn', {
        nativeSessionId: session.nativeSessionId,
        turnIndex,
        inputHash: createHash('sha256').update(turn.userText).digest('hex').slice(0, 32),
      });
      const sourceTurnId = this.identityStore.resolveReplay(
        session.nativeSessionId,
        turnIndex,
        [{ type: 'text', text: turn.userText }],
        fallback,
      );
      append(sourceTurnId, 'turn.started', {}, 'lifecycle');
      if (turn.userText) {
        append(sourceTurnId, 'input.recorded', {
          input: [{ type: 'text', text: turn.userText }],
        }, 'input');
      }
      const openContent = new Map<string, { kind: 'text' | 'reasoning'; deltaCount: number }>();
      const openTools = new Set<string>();
      const genericCounts = new Map<string, number>();
      for (const notification of turn.updates) {
        for (const event of translateSessionUpdate(notification.update)) {
          if (event.method === 'content.delta') {
            const kind = event.data.kind === 'reasoning' ? 'reasoning' as const : 'text' as const;
            const contentId = `${kind}:${sourceTurnId}`;
            const open = openContent.get(contentId) ?? { kind, deltaCount: 0 };
            open.deltaCount += 1;
            openContent.set(contentId, open);
            append(sourceTurnId, 'content.delta', {
              contentId,
              kind,
              ...(kind === 'text' ? { format: 'plain' } : {}),
              delta: String(event.data.delta ?? ''),
            }, `${contentId}:delta:${open.deltaCount}`);
            continue;
          }
          if (event.method === 'activity.updated') {
            let activityId = String(event.data.activityId ?? '');
            if (!activityId) continue;
            const presentation = record(event.data.presentation);
            if (presentation.type === 'generic') {
              const count = (genericCounts.get(activityId) ?? 0) + 1;
              genericCounts.set(activityId, count);
              if (count > 1) activityId = `${activityId}:${count}`;
              event.data = { ...event.data, activityId };
            }
            const status = String(event.data.status ?? 'running');
            if (status === 'running') openTools.add(activityId);
            else openTools.delete(activityId);
            append(sourceTurnId, 'activity.updated', event.data, activityId);
            continue;
          }
          if (event.method === 'diff.updated' || event.method === 'plan.updated') {
            const identity = nonEmptyString(event.data.diffId)
              ?? nonEmptyString(event.data.planId)
              ?? event.method;
            append(sourceTurnId, event.method, event.data, identity);
          }
        }
      }
      for (const [contentId, open] of openContent) {
        append(sourceTurnId, 'content.completed', {
          contentId,
          kind: open.kind,
          ...(open.kind === 'text' ? { format: 'plain' as const } : {}),
        }, `${contentId}:completed`);
      }
      for (const activityId of openTools) {
        append(sourceTurnId, 'activity.updated', {
          activityId,
          kind: 'tool',
          title: 'Tool',
          status: 'succeeded',
          presentation: { type: 'tool', data: { name: 'tool' } },
        }, activityId);
      }
      append(sourceTurnId, 'turn.completed', { stopReason: 'completed' }, 'lifecycle');
    }
    this.replayBySession.set(session.id, { streamId, events, sequence: events.length });
  }

  private emitSessionEvent(
    method: string,
    session: AttachedSession,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    this.emitEvent(method, {
      eventId: stableId('session-event', { method, sessionId: session.id, data }),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private providerEventId(
    nativeSessionId: string,
    sourceTurnId: string,
    method: string,
    identity: string,
  ): string {
    return stableId('provider-event', {
      nativeSessionId,
      sourceTurnId,
      method,
      identity,
    });
  }

  private eventFactIdentity(
    method: string,
    data: Record<string, unknown>,
    identity: string | undefined,
    occurrence: number,
  ): string {
    if (method === 'turn.started' || method === 'turn.completed' || method === 'turn.failed') {
      return 'lifecycle';
    }
    const entityIdentity = identity
      ?? nonEmptyString(data.contentId)
      ?? nonEmptyString(data.activityId)
      ?? nonEmptyString(data.interactionId)
      ?? nonEmptyString(data.diffId)
      ?? nonEmptyString(data.planId);
    return entityIdentity
      && (method === 'activity.updated' || method === 'plan.updated' || method === 'diff.updated')
      ? stableId('snapshot', { identity: entityIdentity, data })
      : entityIdentity ?? `occurrence:${occurrence}`;
  }

  private emitTurnEvent(
    method: string,
    session: AttachedSession,
    turnId: string,
    data: Record<string, unknown>,
    identity?: string,
  ): void {
    const turnKey = this.turnKey(session.id, turnId);
    const occurrenceKey = `${turnKey}\u0000${method}`;
    const occurrence = (this.eventOccurrences.get(occurrenceKey) ?? 0) + 1;
    this.eventOccurrences.set(occurrenceKey, occurrence);
    const factIdentity = this.eventFactIdentity(method, data, identity, occurrence);
    const eventId = this.providerEventId(session.nativeSessionId, turnId, method, factIdentity);
    const fingerprint = stableId('event-fingerprint', { method, data });
    const emitted = this.emittedFactsByTurn.get(turnKey) ?? new Map<string, string>();
    const existing = emitted.get(eventId);
    if (existing === fingerprint) return;
    if (existing !== undefined) {
      throw new GrokProtocolError('INTERNAL', `Event ${eventId} changed canonical content.`);
    }
    emitted.set(eventId, fingerprint);
    this.emittedFactsByTurn.set(turnKey, emitted);
    session.sequence += 1;
    const emittedAt = new Date().toISOString();
    this.emitEvent(method, {
      eventId,
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      turnId,
      sourceTurnId: turnId,
      emittedAt,
      data,
    });
    this.recordReplay(method, session, turnId, eventId, emittedAt, data);
  }

  private recordReplay(
    method: string,
    session: AttachedSession,
    turnId: string,
    eventId: string,
    emittedAt: string,
    data: Record<string, unknown>,
  ): void {
    if (!REPLAYABLE.has(method) || this.sidechats.has(session.id)) return;
    const replay = this.replayBySession.get(session.id);
    if (!replay) return;
    replay.sequence += 1;
    replay.events.push({
      method,
      eventId,
      sessionId: session.id,
      replayStreamId: replay.streamId,
      sequence: replay.sequence,
      sourceTurnId: turnId,
      emittedAt,
      data,
    });
  }

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.interruptedTurns.delete(key);
    this.openActivitiesByTurn.delete(key);
    this.openContentByTurn.delete(key);
    this.emittedFactsByTurn.delete(key);
    for (const occurrenceKey of this.eventOccurrences.keys()) {
      if (occurrenceKey.startsWith(`${key}\u0000`)) this.eventOccurrences.delete(occurrenceKey);
    }
    for (const genericKey of this.genericActivityCounts.keys()) {
      if (genericKey.startsWith(`${key}\u0000`)) this.genericActivityCounts.delete(genericKey);
    }
    const requestKey = this.requestByTurn.get(key);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(key);
    this.forgetServiceTurns(turnId);
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
      lastError: session.lastError,
      ...(this.service.supportsFork() ? { availableActions: this.availableActions(session) } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new GrokProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    return session;
  }

  private requireOrdinarySession(sessionId: string): AttachedSession {
    if (this.sidechats.has(sessionId)) {
      throw new GrokProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    }
    return this.requireSession(sessionId);
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new GrokProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireOrdinaryAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireOrdinarySession(sessionId);
    if (session.streamId !== streamId) {
      throw new GrokProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): void {
    if (this.activeTurnBySession.get(sessionId) !== turnId) {
      throw new GrokProtocolError('TURN_NOT_FOUND', 'Turn is not active.');
    }
  }
}
