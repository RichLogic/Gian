import { Buffer } from 'node:buffer';

import {
  ACTION_REQUIRED_CAPABILITIES,
  CAPABILITY_DEPENDENCIES,
  CATALOG_ACTION_IDS,
  JSONRPC_VERSION,
  MAX_NDJSON_LINE_BYTES,
  OPTIONAL_METHOD_CAPABILITIES,
  isCatalogActionId,
  isSidechatRejectedSessionMethod,
  type CapabilityName,
  type CatalogActionId,
  type ProxyMethod,
} from './constants.js';
import {
  jsonRpcRequestViolation,
  protocolViolation,
  ProxyProtocolError,
  requestViolation,
  sessionViolation,
} from './errors.js';
import {
  initializeResultSchema,
  proxyErrorResponseSchema,
  proxyNotificationSchema,
  proxyRequestSchema,
  proxySuccessResponseEnvelopeSchema,
  resultSchemas,
  type AvailableActions,
  type CatalogActionDescriptor,
  type CatalogResult,
  type ConfigOption,
  type ConfigValue,
  type ForkAnchor,
  type InitializeResult,
  type ProxyNotification,
  type ProxyRequest,
  type ReplayEvent,
  type SideChatSnapshot,
  type TurnStartParams,
} from './schemas.js';

type WireId = string;

interface PendingRequest {
  method: ProxyMethod;
  params: unknown;
}

interface AdvertisedConfigOption {
  binding: 'session' | 'turn';
  control: 'select' | 'boolean' | 'number' | 'text';
  required: boolean;
  choices?: Array<{ value: ConfigValue }>;
  visibleWhen?: ReadonlyArray<{ optionId: string; oneOf: ConfigValue[] }>;
  enabledWhen?: ReadonlyArray<{ optionId: string; oneOf: ConfigValue[] }>;
}

interface InteractionState {
  actions: Set<string>;
  inputs: ReadonlyArray<{
    id: string;
    type: string;
    required: boolean;
    choices?: ReadonlyArray<{ value: string }>;
  }>;
  resolved: boolean;
  respondAccepted: boolean;
}

interface ContentStreamState {
  kind: string;
  format?: string;
  stepId?: string;
  open: boolean;
}

interface ActivityState {
  enteredRunning: boolean;
  status: string;
}

interface StepState {
  enteredRunning: boolean;
  status: string;
}

interface TurnState {
  interactions: Map<string, InteractionState>;
  activities: Map<string, ActivityState>;
  steps: Map<string, StepState>;
  content: Map<string, ContentStreamState>;
  conversationDeltaSeen: Set<string>;
}

interface SessionState {
  kind: 'session' | 'sidechat';
  streamId: string;
  sequence: number;
  sessionConfig: Record<string, ConfigValue>;
  acceptedTurns: Set<string>;
  activeTurns: Map<string, TurnState>;
  configOptions: Map<string, AdvertisedConfigOption>;
  liveEvents: Map<string, string>;
  respondFingerprints: Map<string, string>;
  parentSessionId?: string;
  resumeRefId?: string;
  createFingerprint?: string;
  resumeFingerprint?: string;
  closeResult?: { ok: true; sidechatId: string; providerDataDeleted: boolean };
  closing?: boolean;
}

export interface NormalizedCatalogAction {
  supported: boolean;
  reason?: string;
}

export function normalizeCatalogActions(
  actions: ReadonlyArray<CatalogActionDescriptor> | undefined,
): Map<CatalogActionId, NormalizedCatalogAction> {
  const out = new Map<CatalogActionId, NormalizedCatalogAction>(
    CATALOG_ACTION_IDS.map((id) => [id, { supported: false }]),
  );
  for (const action of actions ?? []) {
    if (!isCatalogActionId(action.id)) continue;
    out.set(action.id, {
      supported: action.supported,
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
    });
  }
  return out;
}

const inputCapabilities = {
  localFile: 'input.localFile',
  localImage: 'input.localImage',
  skill: 'input.skill',
} as const satisfies Partial<Record<TurnStartParams['input'][number]['type'], CapabilityName>>;

const TERMINAL_ACTIVITY = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_STEP = new Set(['completed', 'failed']);

function formatIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseNdjsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_NDJSON_LINE_BYTES) {
    throw protocolViolation(
      `NDJSON line is ${bytes} bytes; maximum is ${MAX_NDJSON_LINE_BYTES}.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw protocolViolation(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(value)) {
    throw protocolViolation('JSON-RPC batch arrays are not allowed.');
  }
  if (!value || typeof value !== 'object') {
    throw protocolViolation('NDJSON top-level value must be an object.');
  }
  return value as Record<string, unknown>;
}

export function parseProxyRequest(value: unknown): ProxyRequest {
  if (Array.isArray(value)) {
    throw protocolViolation('JSON-RPC batch arrays are not allowed.');
  }
  if (!value || typeof value !== 'object') {
    throw jsonRpcRequestViolation('INVALID_REQUEST', 'Request must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC_VERSION) {
    throw jsonRpcRequestViolation(
      'INVALID_REQUEST',
      'Request must include jsonrpc "2.0".',
    );
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw jsonRpcRequestViolation(
      'INVALID_REQUEST',
      'Request id must be a non-empty string.',
    );
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    throw jsonRpcRequestViolation(
      'INVALID_REQUEST',
      'Request method must be a non-empty string.',
    );
  }
  const parsed = proxyRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!(record.method in resultSchemas)) {
    throw jsonRpcRequestViolation('METHOD_NOT_FOUND', `Unknown method ${record.method}.`);
  }
  throw jsonRpcRequestViolation('INVALID_PARAMS', formatIssues(parsed.error));
}

export function parseProxyNotification(value: unknown): ProxyNotification {
  const parsed = proxyNotificationSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolViolation(`Invalid Proxy notification: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) target[key] = canonicalize(source[key]);
  }
  return target;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalFingerprint(event: {
  method: string;
  sourceTurnId?: string;
  data?: unknown;
  extensions?: unknown;
  params?: {
    sourceTurnId?: string;
    data?: unknown;
  };
}): string {
  const sourceTurnId = event.sourceTurnId ?? event.params?.sourceTurnId;
  const data = event.data ?? event.params?.data;
  return canonicalJson({
    method: event.method,
    ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
    data,
    ...(event.extensions !== undefined ? { extensions: event.extensions } : {}),
  });
}

export class AttachmentTurnLedger {
  private readonly streams = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();

  attach(sessionId: string, streamId: string): void {
    const previous = this.streams.get(sessionId);
    if (previous === streamId) return;
    this.streams.set(sessionId, streamId);
    for (const key of this.fingerprints.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  close(sessionId: string, streamId: string): void {
    this.assertStream(sessionId, streamId);
    this.streams.delete(sessionId);
    for (const key of this.fingerprints.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  accept(params: TurnStartParams): 'new' | 'duplicate' {
    this.assertStream(params.sessionId, params.streamId);
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    const fingerprint = canonicalJson(params);
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return 'new';
    }
    if (existing !== fingerprint) {
      throw requestViolation(
        'CONFLICT',
        `Turn ${params.turnId} was reused with different input.`,
      );
    }
    return 'duplicate';
  }

  forget(params: Pick<TurnStartParams, 'sessionId' | 'streamId' | 'turnId'>): void {
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    this.fingerprints.delete(key);
  }

  private assertStream(sessionId: string, streamId: string): void {
    const active = this.streams.get(sessionId);
    if (active === undefined) {
      throw requestViolation('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    if (active !== streamId) {
      throw requestViolation('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
  }
}

export class ReplayPageValidator {
  private replayStreamId: string | null = null;
  private nextSequence = 1;
  private readonly events = new Map<string, string>();

  constructor(private readonly sessionId: string) {}

  acceptPage(value: unknown): void {
    const parsed = resultSchemas['session.replay'].safeParse(value);
    if (!parsed.success) {
      throw protocolViolation(`Invalid replay page: ${formatIssues(parsed.error)}`);
    }
    if (this.replayStreamId === null) {
      this.replayStreamId = parsed.data.replayStreamId;
    } else if (this.replayStreamId !== parsed.data.replayStreamId) {
      throw protocolViolation('replayStreamId changed between pages.');
    }

    for (const event of parsed.data.events) {
      if (event.sessionId !== this.sessionId) {
        throw protocolViolation(
          `Replay event session ${event.sessionId} does not match ${this.sessionId}.`,
        );
      }
      if (event.replayStreamId !== this.replayStreamId) {
        throw protocolViolation('Replay event replayStreamId does not match page replayStreamId.');
      }
      if (event.sequence !== this.nextSequence) {
        throw protocolViolation(
          `Replay sequence ${event.sequence} does not match expected ${this.nextSequence}.`,
        );
      }

      const fingerprint = canonicalFingerprint(event);
      const existing = this.events.get(event.eventId);
      if (existing !== undefined && existing !== fingerprint) {
        throw protocolViolation(
          `Replay event ${event.eventId} changed canonical content.`,
        );
      }
      if (existing !== undefined) {
        throw protocolViolation(`Replay event ${event.eventId} was duplicated.`);
      }
      this.events.set(event.eventId, fingerprint);
      this.nextSequence += 1;
    }
  }
}

const notificationCapabilities: Partial<Record<ProxyNotification['method'], CapabilityName>> = {
  'interaction.requested': 'interaction',
  'interaction.resolved': 'interaction',
  'plan.updated': 'event.plan',
  'diff.updated': 'event.diff',
  'usage.updated': 'event.usage',
  'step.updated': 'event.step',
  'request.updated': 'event.request',
  'history.changed': 'session.replay',
};

function capabilityForNotification(
  notification: ProxyNotification,
): CapabilityName | undefined {
  if (
    notification.method === 'content.delta'
    || notification.method === 'content.completed'
  ) {
    switch (notification.params.data.kind) {
      case 'text':
      case 'status':
        return undefined;
      case 'reasoning':
        return 'event.reasoning';
    }
  }
  return notificationCapabilities[notification.method];
}

function extractSessionIdentity(
  value: Record<string, unknown>,
): { sessionId: string; streamId: string } | null {
  const params = value.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && typeof record.streamId === 'string'
    && record.streamId.length > 0
  ) {
    return { sessionId: record.sessionId, streamId: record.streamId };
  }
  return null;
}

function conditionsMet(
  conditions: ReadonlyArray<{ optionId: string; oneOf: ConfigValue[] }> | undefined,
  values: Record<string, ConfigValue>,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => (
    condition.oneOf.some((candidate) => Object.is(candidate, values[condition.optionId]))
  ));
}

export interface HostProtocolValidatorOptions {
  pluginId: string;
  pluginVersion?: string;
  processScope?: 'shared' | 'session';
}

export class HostProtocolValidator {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();
  private initializePending = false;
  private initialized = false;
  private negotiated: InitializeResult | null = null;
  private readonly catalogConfigOptions = new Map<string, AdvertisedConfigOption>();
  private readonly catalogActions = new Map<CatalogActionId, NormalizedCatalogAction>();
  private readonly resumeRefOwners = new Map<string, string>();
  private readonly processLiveEvents = new Map<string, string>();

  constructor(private readonly options: HostProtocolValidatorOptions) {}

  get initializeResult(): InitializeResult | null {
    return this.negotiated;
  }

  registerRequest(value: unknown): ProxyRequest {
    const request = parseProxyRequest(value);
    if (
      !this.initialized
      && request.method !== 'initialize'
      && request.method !== 'shutdown'
    ) {
      throw requestViolation('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    if (request.method === 'initialize') {
      if (this.initialized || this.initializePending) {
        throw requestViolation('ALREADY_INITIALIZED', 'initialize can only be sent once.');
      }
      this.initializePending = true;
    }

    const requiredCapability = OPTIONAL_METHOD_CAPABILITIES[
      request.method as keyof typeof OPTIONAL_METHOD_CAPABILITIES
    ];
    if (
      requiredCapability !== undefined
      && this.negotiated?.capabilities[requiredCapability] === undefined
    ) {
      throw requestViolation(
        'CAPABILITY_NOT_SUPPORTED',
        `Proxy does not advertise ${requiredCapability}.`,
      );
    }
    if (request.method === 'turn.start' || request.method === 'turn.steer') {
      for (const item of request.params.input) {
        const capability = inputCapabilities[item.type as keyof typeof inputCapabilities];
        if (capability && this.negotiated?.capabilities[capability] === undefined) {
          throw requestViolation(
            'CAPABILITY_NOT_SUPPORTED',
            `Proxy does not advertise ${capability}.`,
          );
        }
      }
    }
    if (request.method === 'session.create') {
      if (
        request.params.nativeSession?.history === 'replay'
        && this.negotiated?.capabilities['session.replay'] === undefined
      ) {
        throw requestViolation(
          'CAPABILITY_NOT_SUPPORTED',
          'nativeSession.history "replay" requires session.replay.',
        );
      }
      if (
        request.params.forkBoundaries !== undefined
        && this.negotiated?.capabilities['session.create.forkBoundaries'] === undefined
      ) {
        throw requestViolation(
          'CAPABILITY_NOT_SUPPORTED',
          'session.create forkBoundaries require session.create.forkBoundaries.',
        );
      }
      if (
        request.params.hostServices !== undefined
        && request.params.hostServices.length > 0
        && this.negotiated?.capabilities['integration.mcp.streamableHttp'] === undefined
      ) {
        throw requestViolation(
          'CAPABILITY_NOT_SUPPORTED',
          'hostServices require integration.mcp.streamableHttp.',
        );
      }
      this.assertConfigSnapshot(this.catalogConfigOptions, request.params.config, 'session');
    } else if (request.method === 'session.fork') {
      if (
        request.params.hostServices !== undefined
        && request.params.hostServices.length > 0
        && this.negotiated?.capabilities['integration.mcp.streamableHttp'] === undefined
      ) {
        throw requestViolation(
          'CAPABILITY_NOT_SUPPORTED',
          'hostServices require integration.mcp.streamableHttp.',
        );
      }
      this.assertSessionForkRequest(request.params);
    } else if (
      request.method === 'sidechat.create'
      || request.method === 'sidechat.resume'
      || request.method === 'sidechat.close'
    ) {
      this.assertSidechatRequest(request);
    } else if (isSidechatRejectedSessionMethod(request.method)) {
      const sessionId = 'sessionId' in request.params
        ? request.params.sessionId
        : undefined;
      const streamId = 'streamId' in request.params
        ? request.params.streamId
        : undefined;
      if (typeof sessionId === 'string' && this.sessions.get(sessionId)?.kind === 'sidechat') {
        throw requestViolation(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} is not an ordinary Session.`,
        );
      }
      if (
        request.method === 'catalog.resolve'
        && typeof sessionId === 'string'
        && typeof streamId === 'string'
      ) {
        this.sessionState(sessionId, streamId);
      }
    } else if (request.method === 'turn.start') {
      this.assertConfigSnapshot(
        this.sessionConfigOptions(request.params.sessionId, request.params.streamId),
        request.params.config,
        'turn',
        this.sessions.get(request.params.sessionId)?.sessionConfig ?? {},
      );
    } else if (request.method === 'interaction.respond') {
      this.assertInteractionRespond(request.params);
    }

    if (this.pending.has(request.id)) {
      throw requestViolation('CONFLICT', `Request id ${request.id} is already pending.`);
    }
    this.pending.set(request.id, {
      method: request.method,
      params: request.params,
    });
    return request;
  }

  acceptLine(line: string): ProxyNotification | { id: WireId; result?: unknown; error?: unknown } | null {
    const value = parseNdjsonObject(line);
    if (value === null) return null;
    if ('method' in value) return this.acceptNotification(value);
    return this.acceptResponse(value);
  }

  private acceptResponse(value: unknown): { id: WireId; result?: unknown; error?: unknown } {
    const envelope = zodResponseEnvelope(value);
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      throw protocolViolation(`Response id ${envelope.id} has no pending request.`);
    }
    this.pending.delete(envelope.id);

    if ('error' in envelope) {
      if (pending.method === 'initialize') this.initializePending = false;
      return envelope;
    }

    const resultSchema = resultSchemas[pending.method];
    const result = resultSchema.safeParse(envelope.result);
    if (!result.success) {
      throw protocolViolation(
        `Invalid ${pending.method} result: ${formatIssues(result.error)}`,
      );
    }

    if (pending.method === 'initialize') {
      const initialized = initializeResultSchema.parse(result.data);
      const offered = (pending.params as { protocol: { versions: string[] } }).protocol.versions;
      if (!offered.includes(initialized.protocol.version)) {
        throw protocolViolation(
          `Proxy selected protocol ${initialized.protocol.version}, which Host did not offer.`,
        );
      }
      if (initialized.plugin.id !== this.options.pluginId) {
        throw protocolViolation(
          `Handshake plugin id ${initialized.plugin.id} does not match ${this.options.pluginId}.`,
        );
      }
      if (
        this.options.pluginVersion !== undefined
        && initialized.plugin.version !== this.options.pluginVersion
      ) {
        throw protocolViolation(
          `Handshake plugin version ${initialized.plugin.version} does not match manifest.`,
        );
      }
      if (
        this.options.processScope !== undefined
        && initialized.process.scope !== this.options.processScope
      ) {
        throw protocolViolation(
          `Handshake process scope ${initialized.process.scope} does not match manifest.`,
        );
      }
      this.negotiated = initialized;
      this.initialized = true;
      this.initializePending = false;
      this.assertCapabilityDependencies(initialized.capabilities);
      this.replaceCatalogActions(undefined);
    } else if (pending.method === 'session.create') {
      const session = (result.data as { session: {
        id: string;
        streamId: string;
        sessionConfig: Record<string, ConfigValue>;
        turnConfigOptions?: Array<ConfigOption>;
        availableActions?: AvailableActions;
      } }).session;
      const params = pending.params as { sessionId: string };
      if (session.id !== params.sessionId) {
        throw protocolViolation(
          `session.create returned ${session.id}; expected Host session ${params.sessionId}.`,
        );
      }
      this.assertAvailableActions(session.availableActions);
      this.sessions.set(session.id, {
        kind: 'session',
        streamId: session.streamId,
        sequence: 0,
        sessionConfig: session.sessionConfig,
        acceptedTurns: new Set(),
        activeTurns: new Map(),
        liveEvents: new Map(),
        respondFingerprints: new Map(),
        configOptions: this.mergeCatalogWithTurnOptions(session.turnConfigOptions),
      });
    } else if (pending.method === 'catalog.list') {
      this.catalogConfigOptions.clear();
      const catalog = result.data as CatalogResult;
      this.assertCatalogShape(catalog);
      for (const option of catalog.configOptions) {
        this.catalogConfigOptions.set(option.id, advertisedOption(option));
      }
      this.replaceCatalogActions(catalog.actions);
    } else if (pending.method === 'catalog.resolve') {
      const catalog = result.data as CatalogResult;
      this.assertCatalogShape(catalog);
      this.assertCatalogActions(normalizeCatalogActions(catalog.actions));
    } else if (pending.method === 'sidechat.create') {
      this.acceptSidechatCreate(pending.params, result.data);
    } else if (pending.method === 'sidechat.resume') {
      this.acceptSidechatResume(pending.params, result.data);
    } else if (pending.method === 'sidechat.close') {
      this.acceptSidechatClose(pending.params, result.data);
    } else if (pending.method === 'session.fork') {
      this.acceptSessionFork(pending.params, result.data);
    } else if (pending.method === 'session.get') {
      const params = pending.params as { sessionId: string };
      const session = (result.data as { session: {
        id: string;
        streamId: string;
        sessionConfig: Record<string, ConfigValue>;
        turnConfigOptions?: ConfigOption[];
      } }).session;
      const state = this.sessions.get(params.sessionId);
      if (state === undefined) {
        throw protocolViolation(`session.get returned an unattached session ${params.sessionId}.`);
      }
      if (session.id !== params.sessionId || session.streamId !== state.streamId) {
        throw protocolViolation('session.get returned a different session attachment.');
      }
      state.sessionConfig = session.sessionConfig;
      if (session.turnConfigOptions !== undefined) {
        state.configOptions = this.mergeCatalogWithTurnOptions(session.turnConfigOptions);
      }
      this.assertAvailableActions((result.data as { session: { availableActions?: AvailableActions } }).session.availableActions);
    } else if (pending.method === 'session.close') {
      const params = pending.params as { sessionId: string };
      this.sessions.delete(params.sessionId);
    } else if (pending.method === 'turn.start') {
      const params = pending.params as { sessionId: string; streamId: string; turnId: string };
      this.sessionState(params.sessionId, params.streamId).acceptedTurns.add(params.turnId);
    } else if (pending.method === 'interaction.respond') {
      const params = pending.params as {
        sessionId: string;
        streamId: string;
        turnId: string;
        interactionId: string;
        responseId: string;
      };
      const interaction = this.sessionState(params.sessionId, params.streamId)
        .activeTurns.get(params.turnId)
        ?.interactions.get(params.interactionId);
      if (interaction) interaction.respondAccepted = true;
    }

    return { id: envelope.id, result: result.data };
  }

  private mergeCatalogWithTurnOptions(
    turnConfigOptions: ConfigOption[] | undefined,
  ): Map<string, AdvertisedConfigOption> {
    const merged = new Map<string, AdvertisedConfigOption>();
    for (const [id, option] of this.catalogConfigOptions) {
      if (turnConfigOptions === undefined || option.binding === 'session') {
        merged.set(id, option);
      }
    }
    if (turnConfigOptions !== undefined) {
      for (const option of turnConfigOptions) {
        if (this.negotiated?.protocol.version === '2.1' && option.role !== undefined) {
          throw protocolViolation(
            `gian.proxy/2.1 turn config option ${option.id} must not use the legacy role field.`,
          );
        }
        merged.set(option.id, advertisedOption(option));
      }
    }
    return merged;
  }

  private assertConfigSnapshot(
    advertised: ReadonlyMap<string, AdvertisedConfigOption>,
    values: Record<string, ConfigValue>,
    expectedBinding: 'session' | 'turn',
    sessionValues: Record<string, ConfigValue> = {},
  ): void {
    const visibleValues = { ...sessionValues, ...values };
    for (const [optionId, value] of Object.entries(values)) {
      const option = advertised.get(optionId);
      if (option === undefined) {
        throw requestViolation('CONFIG_VALUE_INVALID', `Config option ${optionId} is unknown.`);
      }
      if (option.binding !== expectedBinding) {
        throw requestViolation(
          'CONFIG_BINDING_INVALID',
          `Config option ${optionId} is ${option.binding}-bound.`,
        );
      }
      if (!valueMatchesOption(option, value)) {
        throw requestViolation(
          'CONFIG_VALUE_INVALID',
          `Config option ${optionId} value was not advertised by the Proxy.`,
        );
      }
    }
    for (const [optionId, option] of advertised) {
      if (option.binding !== expectedBinding || !option.required) continue;
      if (!conditionsMet(option.visibleWhen, visibleValues)) continue;
      if (!conditionsMet(option.enabledWhen, visibleValues)) continue;
      if (values[optionId] === undefined) {
        throw requestViolation('CONFIG_REQUIRED', `Config option ${optionId} is required.`);
      }
    }
  }

  private assertCapabilityDependencies(capabilities: Record<string, number>): void {
    for (const [capability, dependencies] of Object.entries(CAPABILITY_DEPENDENCIES)) {
      if (capabilities[capability] === undefined) continue;
      for (const dependency of dependencies) {
        if (capabilities[dependency] === undefined) {
          throw protocolViolation(
            `Capability ${capability} requires ${dependency}.`,
          );
        }
      }
    }
  }

  private replaceCatalogActions(actions: CatalogActionDescriptor[] | undefined): void {
    const normalized = normalizeCatalogActions(actions);
    this.assertCatalogActions(normalized);
    this.catalogActions.clear();
    for (const [id, action] of normalized) this.catalogActions.set(id, action);
  }

  private assertCatalogShape(catalog: CatalogResult): void {
    const version = this.negotiated?.protocol.version;
    if (version === '2.0') {
      if (catalog.specialCatalogs !== undefined) {
        throw protocolViolation('gian.proxy/2.0 Catalog cannot declare specialCatalogs.');
      }
      return;
    }
    if (catalog.specialCatalogs === undefined) {
      throw protocolViolation('gian.proxy/2.1 Catalog must declare specialCatalogs.');
    }
    const byId = new Map(catalog.configOptions.map((option) => [option.id, option]));
    for (const option of catalog.configOptions) {
      if (option.role !== undefined) {
        throw protocolViolation(
          `gian.proxy/2.1 config option ${option.id} must not use the legacy role field.`,
        );
      }
    }
    const expectedControls = {
      model: 'select',
      thinking: 'select',
      fast: 'boolean',
      approvalMode: 'select',
    } as const;
    for (const [slot, optionId] of Object.entries(catalog.specialCatalogs)) {
      if (optionId === undefined) continue;
      const option = byId.get(optionId);
      if (!option) {
        throw protocolViolation(`Special Catalog ${slot} references unknown option ${optionId}.`);
      }
      const expected = expectedControls[slot as keyof typeof expectedControls];
      if (option.control !== expected) {
        throw protocolViolation(
          `Special Catalog ${slot} must reference a ${expected} option; got ${option.control}.`,
        );
      }
    }
  }

  private assertCatalogActions(
    actions: ReadonlyMap<CatalogActionId, NormalizedCatalogAction>,
  ): void {
    const forkSupported = actions.get('session.fork')?.supported === true;
    const atTurnSupported = actions.get('session.fork.atTurn')?.supported === true;
    if (atTurnSupported && !forkSupported) {
      throw protocolViolation('session.fork.atTurn.supported requires session.fork.supported.');
    }
    for (const [id, action] of actions) {
      if (!action.supported) continue;
      const required = ACTION_REQUIRED_CAPABILITIES[id];
      if (this.negotiated?.capabilities[required] === undefined) {
        throw protocolViolation(
          `Catalog action ${id} is supported without capability ${required}.`,
        );
      }
    }
  }

  private assertAvailableActions(actions: AvailableActions | undefined): void {
    if (actions === undefined) return;
    let forkEnabled = false;
    let atTurnEnabled = false;
    for (const [id, action] of Object.entries(actions)) {
      if (!isCatalogActionId(id)) continue;
      const catalog = this.catalogActions.get(id);
      const required = ACTION_REQUIRED_CAPABILITIES[id];
      if (catalog?.supported !== true || this.negotiated?.capabilities[required] === undefined) {
        throw protocolViolation(
          `availableActions includes ${id} that is not catalog-supported and capability-gated.`,
        );
      }
      if (id === 'session.fork' && action.enabled) forkEnabled = true;
      if (id === 'session.fork.atTurn' && action.enabled) atTurnEnabled = true;
    }
    if (atTurnEnabled && !forkEnabled) {
      throw protocolViolation('session.fork.atTurn.enabled requires session.fork.enabled.');
    }
  }

  private assertSessionForkRequest(params: {
    sourceSessionId: string;
    sourceStreamId: string;
    sessionId: string;
    anchor: ForkAnchor;
  }): void {
    if (this.sessions.get(params.sourceSessionId)?.kind === 'sidechat') {
      throw requestViolation(
        'SESSION_NOT_FOUND',
        `Session ${params.sourceSessionId} is not an ordinary Session.`,
      );
    }
    if (
      params.anchor.type === 'turn'
      && this.negotiated?.capabilities['session.fork.atTurn'] === undefined
    ) {
      throw requestViolation(
        'CAPABILITY_NOT_SUPPORTED',
        'session.fork turn anchors require session.fork.atTurn.',
      );
    }
    const source = this.sessionState(params.sourceSessionId, params.sourceStreamId);
    this.assertConfigSnapshot(this.catalogConfigOptions, source.sessionConfig, 'session');
  }

  private assertSidechatRequest(request: ProxyRequest): void {
    if (request.method === 'sidechat.create') {
      const parent = this.sessions.get(request.params.parentSessionId);
      if (parent?.kind === 'sidechat') {
        throw requestViolation(
          'SESSION_NOT_FOUND',
          `Session ${request.params.parentSessionId} is not an ordinary Session.`,
        );
      }
      this.sessionState(request.params.parentSessionId, request.params.parentStreamId);
      return;
    }
    if (request.method === 'sidechat.resume') {
      const parent = this.sessions.get(request.params.parentSessionId);
      if (parent?.kind === 'sidechat') {
        throw requestViolation(
          'SESSION_NOT_FOUND',
          `Session ${request.params.parentSessionId} is not an ordinary Session.`,
        );
      }
      const existing = this.sessions.get(request.params.sidechatId);
      if (existing?.kind === 'sidechat' && existing.parentSessionId !== request.params.parentSessionId) {
        throw requestViolation('CONFLICT', 'sidechat.resume parent does not match the live Side Chat.');
      }
      return;
    }
    if (request.method === 'sidechat.close') {
      const owner = this.resumeRefOwners.get(request.params.resumeRef.id);
      if (owner !== undefined && owner !== request.params.sidechatId) {
        throw requestViolation(
          'CONFLICT',
          'resumeRef belongs to another live Side Chat.',
        );
      }
      const existing = this.sessions.get(request.params.sidechatId);
      if (existing?.kind === 'sidechat') {
        existing.closing = true;
        if (request.params.streamId !== undefined) {
          this.sessionState(request.params.sidechatId, request.params.streamId);
        }
      }
    }
  }

  private emptySessionState(streamId: string, sessionConfig: Record<string, ConfigValue>): SessionState {
    return {
      kind: 'session',
      streamId,
      sequence: 0,
      sessionConfig,
      acceptedTurns: new Set(),
      activeTurns: new Map(),
      liveEvents: new Map(),
      respondFingerprints: new Map(),
      configOptions: this.mergeCatalogWithTurnOptions(undefined),
    };
  }

  private acceptSidechatCreate(params: unknown, data: unknown): void {
    const request = params as {
      parentSessionId: string;
      parentStreamId: string;
      sidechatId: string;
    };
    const snapshot = (data as { sidechat: SideChatSnapshot }).sidechat;
    const parent = this.sessionState(request.parentSessionId, request.parentStreamId);
    if (snapshot.id !== request.sidechatId) {
      throw protocolViolation('sidechat.create returned a different sidechatId.');
    }
    if (snapshot.parentSessionId !== request.parentSessionId) {
      throw protocolViolation('sidechat.create returned a different parentSessionId.');
    }
    if (canonicalJson(snapshot.sessionConfig) !== canonicalJson(parent.sessionConfig)) {
      throw protocolViolation('sidechat.create must inherit parent sessionConfig unchanged.');
    }
    const fingerprint = canonicalJson({
      parentSessionId: request.parentSessionId,
      parentStreamId: request.parentStreamId,
    });
    const existing = this.sessions.get(request.sidechatId);
    if (existing?.kind === 'sidechat') {
      if (existing.createFingerprint !== fingerprint) {
        throw requestViolation('CONFLICT', 'sidechatId was reused with different parent identity.');
      }
      return;
    }
    this.rememberResumeRef(request.sidechatId, snapshot.resumeRef.id);
    this.sessions.set(request.sidechatId, {
      ...this.emptySessionState(snapshot.streamId, snapshot.sessionConfig),
      kind: 'sidechat',
      parentSessionId: snapshot.parentSessionId,
      resumeRefId: snapshot.resumeRef.id,
      createFingerprint: fingerprint,
      configOptions: this.mergeCatalogWithTurnOptions(snapshot.turnConfigOptions),
    });
  }

  private acceptSidechatResume(params: unknown, data: unknown): void {
    const request = params as {
      sidechatId: string;
      parentSessionId: string;
      resumeRef: { id: string };
    };
    const snapshot = (data as { sidechat: SideChatSnapshot }).sidechat;
    if (snapshot.id !== request.sidechatId || snapshot.parentSessionId !== request.parentSessionId) {
      throw protocolViolation('sidechat.resume returned a different Side Chat identity.');
    }
    const fingerprint = canonicalJson({
      parentSessionId: request.parentSessionId,
      resumeRef: request.resumeRef.id,
    });
    const existing = this.sessions.get(request.sidechatId);
    if (existing?.kind === 'sidechat' && existing.resumeFingerprint === fingerprint) {
      if (existing.streamId !== snapshot.streamId) {
        throw protocolViolation('Idempotent sidechat.resume changed streamId.');
      }
      return;
    }
    if (existing?.kind === 'sidechat' && existing.resumeFingerprint && existing.resumeFingerprint !== fingerprint) {
      throw requestViolation('CONFLICT', 'sidechat.resume reused an id with different parent or resumeRef.');
    }
    this.rememberResumeRef(request.sidechatId, snapshot.resumeRef.id);
    this.sessions.set(request.sidechatId, {
      ...this.emptySessionState(snapshot.streamId, snapshot.sessionConfig),
      kind: 'sidechat',
      parentSessionId: snapshot.parentSessionId,
      resumeRefId: snapshot.resumeRef.id,
      createFingerprint: existing?.createFingerprint,
      resumeFingerprint: fingerprint,
      configOptions: this.mergeCatalogWithTurnOptions(snapshot.turnConfigOptions),
    });
  }

  private acceptSidechatClose(params: unknown, data: unknown): void {
    const request = params as { sidechatId: string; resumeRef: { id: string } };
    const result = data as { ok: true; sidechatId: string; providerDataDeleted: boolean };
    if (result.sidechatId !== request.sidechatId) {
      throw protocolViolation('sidechat.close returned a different sidechatId.');
    }
    const owner = this.resumeRefOwners.get(request.resumeRef.id);
    if (owner !== undefined && owner !== request.sidechatId) {
      throw protocolViolation('sidechat.close succeeded for a resumeRef owned by another live Side Chat.');
    }
    const existing = this.sessions.get(request.sidechatId);
    if (existing?.kind === 'sidechat' && existing.closeResult) {
      if (canonicalJson(existing.closeResult) !== canonicalJson(result)) {
        throw protocolViolation('Idempotent sidechat.close changed result.');
      }
      return;
    }
    if (existing?.kind === 'sidechat') existing.closeResult = result;
    this.forgetResumeRef(request.sidechatId, existing?.resumeRefId ?? request.resumeRef.id);
    this.sessions.delete(request.sidechatId);
  }

  private acceptSessionFork(params: unknown, data: unknown): void {
    const request = params as {
      sourceSessionId: string;
      sourceStreamId: string;
      sessionId: string;
      anchor: ForkAnchor;
    };
    const result = data as {
      session: {
        id: string;
        streamId: string;
        nativeSession?: { id: string };
        sessionConfig: Record<string, ConfigValue>;
        turnConfigOptions?: ConfigOption[];
        availableActions?: AvailableActions;
      };
      origin: { kind: 'fork'; sessionId: string; turnId: string; sourceTurnId: string };
    };
    if (result.session.id !== request.sessionId) {
      throw protocolViolation('session.fork returned a different sessionId.');
    }
    if (!result.session.nativeSession?.id) {
      throw protocolViolation('session.fork Result requires durable nativeSession.id');
    }
    if (result.origin.sessionId !== request.sourceSessionId) {
      throw protocolViolation('session.fork origin must name the source Session.');
    }
    if (request.anchor.type === 'turn') {
      if (
        result.origin.turnId !== request.anchor.turnId
        || result.origin.sourceTurnId !== request.anchor.sourceTurnId
      ) {
        throw protocolViolation('session.fork origin must match the requested turn anchor.');
      }
    }
    this.assertAvailableActions(result.session.availableActions);
    this.sessions.set(result.session.id, {
      ...this.emptySessionState(result.session.streamId, result.session.sessionConfig),
      configOptions: this.mergeCatalogWithTurnOptions(result.session.turnConfigOptions),
    });
  }

  private rememberResumeRef(sidechatId: string, resumeRefId: string): void {
    const owner = this.resumeRefOwners.get(resumeRefId);
    if (owner !== undefined && owner !== sidechatId) {
      throw protocolViolation('resumeRef is already owned by another live Side Chat.');
    }
    const previous = this.sessions.get(sidechatId)?.resumeRefId;
    if (previous && previous !== resumeRefId) this.resumeRefOwners.delete(previous);
    this.resumeRefOwners.set(resumeRefId, sidechatId);
  }

  private forgetResumeRef(sidechatId: string, resumeRefId: string): void {
    if (this.resumeRefOwners.get(resumeRefId) === sidechatId) {
      this.resumeRefOwners.delete(resumeRefId);
    }
  }

  private assertInteractionRespond(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    interactionId: string;
    responseId: string;
    actionId: string;
    values: Record<string, string | boolean | string[]>;
  }): void {
    const session = this.sessionState(params.sessionId, params.streamId);
    const fingerprint = canonicalJson({
      interactionId: params.interactionId,
      actionId: params.actionId,
      values: params.values,
    });
    const existing = session.respondFingerprints.get(params.responseId);
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        throw requestViolation(
          'CONFLICT',
          `responseId ${params.responseId} was reused with different content.`,
        );
      }
      return;
    }

    const turn = session.activeTurns.get(params.turnId);
    const interaction = turn?.interactions.get(params.interactionId);
    if (!interaction || interaction.resolved) {
      throw requestViolation(
        'INTERACTION_NOT_FOUND',
        `Interaction ${params.interactionId} is not pending.`,
      );
    }
    if (!interaction.actions.has(params.actionId)) {
      throw requestViolation(
        'INTERACTION_ACTION_NOT_FOUND',
        `Action ${params.actionId} was not advertised.`,
      );
    }
    const declared = new Map(interaction.inputs.map((input) => [input.id, input]));
    for (const [inputId, value] of Object.entries(params.values)) {
      const input = declared.get(inputId);
      if (input === undefined) {
        throw jsonRpcRequestViolation(
          'INVALID_PARAMS',
          `Interaction value ${inputId} was not advertised.`,
        );
      }
      const valid = input.type === 'boolean'
        ? typeof value === 'boolean'
        : input.type === 'multi_select'
          ? Array.isArray(value)
            && value.every((entry) => input.choices?.some((choice) => choice.value === entry))
          : typeof value === 'string'
            && (
              input.type !== 'single_select'
              || input.choices?.some((choice) => choice.value === value) === true
            );
      if (!valid) {
        throw jsonRpcRequestViolation(
          'INVALID_PARAMS',
          `Interaction value ${inputId} does not match the advertised input.`,
        );
      }
    }
    for (const input of interaction.inputs) {
      if (input.required && params.values[input.id] === undefined) {
        throw jsonRpcRequestViolation(
          'INVALID_PARAMS',
          `Interaction input ${input.id} is required.`,
        );
      }
    }
    session.respondFingerprints.set(params.responseId, fingerprint);
  }

  private sessionConfigOptions(
    sessionId: string,
    streamId: string,
  ): ReadonlyMap<string, AdvertisedConfigOption> {
    return this.sessionState(sessionId, streamId).configOptions;
  }

  private sessionState(sessionId: string, streamId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw requestViolation('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    if (session.streamId !== streamId) {
      throw requestViolation('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return session;
  }

  private acceptNotification(value: Record<string, unknown>): ProxyNotification {
    if (!this.initialized || this.negotiated === null) {
      throw protocolViolation('Proxy emitted a notification before initialize completed.');
    }
    if (value.jsonrpc !== JSONRPC_VERSION) {
      throw protocolViolation('Notification must include jsonrpc "2.0".');
    }
    if ('id' in value && value.id !== undefined) {
      throw protocolViolation('Notification must omit id.');
    }

    const identity = extractSessionIdentity(value);
    const parsed = proxyNotificationSchema.safeParse(value);
    if (!parsed.success) {
      const message = `Invalid Proxy notification: ${formatIssues(parsed.error)}`;
      if (identity) throw sessionViolation(message, identity.sessionId, identity.streamId);
      throw protocolViolation(message);
    }
    const notification = parsed.data;
    const fault = (message: string): never => {
      if (identity) throw sessionViolation(message, identity.sessionId, identity.streamId);
      throw protocolViolation(message);
    };

    if (notification.method === 'input.recorded') {
      fault('input.recorded is valid only inside session.replay.');
    }
    const capability = capabilityForNotification(notification);
    if (capability !== undefined && this.negotiated.capabilities[capability] === undefined) {
      fault(`Proxy emitted ${notification.method} without capability ${capability}.`);
    }
    if (
      (
        notification.method === 'content.delta'
        || notification.method === 'content.completed'
        || notification.method === 'activity.updated'
        || notification.method === 'usage.updated'
      )
      && notification.params.data.stepId !== undefined
      && this.negotiated.capabilities['event.step'] === undefined
    ) {
      fault(`Proxy emitted ${notification.method} with stepId without capability event.step.`);
    }

    if (notification.extensions) {
      for (const namespace of Object.keys(notification.extensions)) {
        if (namespace !== this.options.pluginId) {
          fault(
            `Extension namespace ${namespace} does not match plugin ${this.options.pluginId}.`,
          );
        }
      }
    }

    if (!('sessionId' in notification.params)) {
      this.rememberLiveEvent(notification, this.processLiveEvents, null);
      return notification;
    }

    const params = notification.params;
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw sessionViolation(
        `Notification references unattached session ${params.sessionId}.`,
        params.sessionId,
        params.streamId,
      );
    }
    if (session.kind === 'sidechat' && session.closing && session.streamId !== params.streamId) {
      return notification;
    }
    if (params.streamId !== session.streamId) {
      throw sessionViolation(
        `Notification stream ${params.streamId} does not match active stream ${session.streamId}.`,
        params.sessionId,
        params.streamId,
      );
    }

    const fingerprint = canonicalFingerprint(notification);
    const existing = session.liveEvents.get(params.eventId);
    if (existing === fingerprint) return notification;
    if (existing !== undefined) {
      throw sessionViolation(
        `Live event ${params.eventId} changed canonical content.`,
        params.sessionId,
        params.streamId,
      );
    }

    const expected = session.sequence + 1;
    if (params.sequence !== expected) {
      throw sessionViolation(
        `Notification sequence ${params.sequence} does not match expected ${expected}.`,
        params.sessionId,
        params.streamId,
      );
    }
    this.validateLifecycle(notification, session);
    session.sequence = params.sequence;
    session.liveEvents.set(params.eventId, fingerprint);
    if (notification.method === 'session.updated') {
      if (notification.params.data.turnConfigOptions !== undefined) {
        session.configOptions = this.mergeCatalogWithTurnOptions(
          notification.params.data.turnConfigOptions,
        );
      }
      this.assertAvailableActions(notification.params.data.availableActions);
    }
    return notification;
  }

  private validateLifecycle(
    notification: ProxyNotification,
    session: SessionState,
  ): void {
    if (!('turnId' in notification.params)) return;
    const params = notification.params;
    const { turnId } = params;
    const fault = (message: string): never => {
      throw sessionViolation(message, params.sessionId, params.streamId);
    };

    if (notification.method === 'turn.started') {
      if (!session.acceptedTurns.has(turnId)) {
        fault(`Turn ${turnId} started before turn.start was accepted.`);
      }
      if (session.activeTurns.has(turnId)) {
        fault(`Turn ${turnId} started more than once.`);
      }
      session.activeTurns.set(turnId, {
        interactions: new Map(),
        activities: new Map(),
        steps: new Map(),
        content: new Map(),
        conversationDeltaSeen: new Set(),
      });
      return;
    }

    const turn = session.activeTurns.get(turnId);
    if (turn === undefined) {
      throw sessionViolation(
        `${notification.method} references inactive turn ${turnId}.`,
        params.sessionId,
        params.streamId,
      );
    }

    if (notification.method === 'step.updated') {
      const { stepId, status } = notification.params.data;
      const previous = turn.steps.get(stepId);
      turn.steps.set(stepId, {
        enteredRunning: previous?.enteredRunning === true || status === 'running',
        status,
      });
    } else if (notification.method === 'activity.updated') {
      const { activityId, status } = notification.params.data;
      const previous = turn.activities.get(activityId);
      turn.activities.set(activityId, {
        enteredRunning: previous?.enteredRunning === true || status === 'running',
        status,
      });
    } else if (notification.method === 'interaction.requested') {
      const id = notification.params.data.interactionId;
      if (turn.interactions.has(id)) {
        fault(`Interaction ${id} was requested more than once.`);
      }
      turn.interactions.set(id, {
        actions: new Set(notification.params.data.actions.map((action) => action.id)),
        inputs: notification.params.data.inputs.map((input) => ({
          id: input.id,
          type: input.type,
          required: input.required,
          ...(input.choices ? { choices: input.choices } : {}),
        })),
        resolved: false,
        respondAccepted: false,
      });
    } else if (notification.method === 'interaction.resolved') {
      const id = notification.params.data.interactionId;
      const interaction = turn.interactions.get(id);
      if (interaction === undefined || interaction.resolved) {
        throw sessionViolation(
          'interaction.resolved arrived without a pending interaction.',
          params.sessionId,
          params.streamId,
        );
      }
      if (
        notification.params.data.outcome === 'submitted'
        && (
          notification.params.data.actionId === undefined
          || !interaction.actions.has(notification.params.data.actionId)
        )
      ) {
        fault(`Interaction ${id} selected an action that was not advertised.`);
      }
      if (notification.params.data.outcome === 'submitted' && !interaction.respondAccepted) {
        fault('interaction.resolved arrived before interaction.respond succeeded.');
      }
      interaction.resolved = true;
    } else if (
      notification.method === 'content.delta'
      || notification.method === 'content.completed'
    ) {
      const { contentId, kind, format, stepId } = notification.params.data;
      const previous = turn.content.get(contentId);
      if (
        previous
        && (
          previous.kind !== kind
          || previous.format !== format
          || previous.stepId !== stepId
        )
      ) {
        fault(`Content ${contentId} changed kind, format, or stepId.`);
      }
      if (previous && !previous.open && notification.method === 'content.delta') {
        fault(`Content ${contentId} received a delta after content.completed.`);
      }
      turn.content.set(contentId, {
        kind,
        ...(format !== undefined ? { format } : {}),
        ...(stepId !== undefined ? { stepId } : {}),
        open: notification.method === 'content.delta',
      });
    } else if (
      notification.method === 'usage.updated'
      && notification.params.data.conversation?.mode === 'delta'
    ) {
      const stepKey = notification.params.data.stepId ?? '';
      if (turn.conversationDeltaSeen.has(stepKey)) {
        fault(
          `Turn ${turnId} emitted conversation delta usage more than once for step ${stepKey || '<none>'}.`,
        );
      }
      turn.conversationDeltaSeen.add(stepKey);
    } else if (
      notification.method === 'turn.completed'
      || notification.method === 'turn.failed'
    ) {
      const openInteractions = [...turn.interactions.values()].some((item) => !item.resolved);
      const openActivities = [...turn.activities.values()].some((item) => (
        item.enteredRunning && !TERMINAL_ACTIVITY.has(item.status)
      ));
      const openSteps = [...turn.steps.values()].some((item) => (
        item.enteredRunning && !TERMINAL_STEP.has(item.status)
      ));
      const openContent = [...turn.content.values()].some((item) => item.open);
      if (openInteractions || openActivities || openSteps || openContent) {
        fault(
          `Turn ${turnId} terminated with open interactions, activities, steps, or content streams.`,
        );
      }
      session.activeTurns.delete(turnId);
    }
  }

  private rememberLiveEvent(
    notification: ProxyNotification,
    liveEvents: Map<string, string>,
    identity: { sessionId: string; streamId: string } | null,
  ): boolean {
    const eventId = notification.params.eventId;
    const fingerprint = canonicalFingerprint(notification);
    const existing = liveEvents.get(eventId);
    if (existing === fingerprint) return true;
    if (existing !== undefined) {
      const message = `Live event ${eventId} changed canonical content.`;
      if (identity) throw sessionViolation(message, identity.sessionId, identity.streamId);
      throw protocolViolation(message);
    }
    liveEvents.set(eventId, fingerprint);
    return false;
  }
}

function advertisedOption(option: ConfigOption): AdvertisedConfigOption {
  return {
    binding: option.binding,
    control: option.control,
    required: option.required,
    ...(option.choices ? { choices: option.choices } : {}),
    ...(option.visibleWhen ? { visibleWhen: option.visibleWhen } : {}),
    ...(option.enabledWhen ? { enabledWhen: option.enabledWhen } : {}),
  };
}

function valueMatchesOption(option: AdvertisedConfigOption, value: ConfigValue): boolean {
  if (value === null) return !option.required;
  const validType = (option.control === 'boolean' && typeof value === 'boolean')
    || (option.control === 'number' && typeof value === 'number')
    || (option.control === 'text' && typeof value === 'string')
    || option.control === 'select';
  const validChoice = option.control !== 'select'
    || option.choices?.some((choice) => Object.is(choice.value, value)) === true;
  return validType && validChoice;
}

function zodResponseEnvelope(
  value: unknown,
):
  | { id: WireId; result: unknown }
  | { id: WireId; error: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolViolation('Invalid Proxy response: top-level value must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC_VERSION) {
    throw protocolViolation('Response must include jsonrpc "2.0".');
  }
  const success = proxySuccessResponseEnvelopeSchema.safeParse(value);
  if (success.success) return success.data;
  const failure = proxyErrorResponseSchema.safeParse(value);
  if (failure.success) {
    if (failure.data.id === null) {
      throw protocolViolation('Successful or domain responses cannot use id null.');
    }
    return { id: failure.data.id, error: failure.data.error };
  }
  throw protocolViolation(
    `Invalid Proxy response: ${formatIssues(success.error)}; ${formatIssues(failure.error)}`,
  );
}

export function validateBindingConfig(
  options: readonly ConfigOption[],
  values: Record<string, ConfigValue>,
  binding: 'session' | 'turn',
  sessionValues: Record<string, ConfigValue> = {},
): void {
  const advertised = new Map(options.map((option) => [option.id, advertisedOption(option)]));
  const visibleValues = { ...sessionValues, ...values };
  for (const [optionId, value] of Object.entries(values)) {
    const option = advertised.get(optionId);
    if (option === undefined) {
      throw requestViolation('CONFIG_VALUE_INVALID', `Config option ${optionId} is unknown.`);
    }
    if (option.binding !== binding) {
      throw requestViolation(
        'CONFIG_BINDING_INVALID',
        `Config option ${optionId} is ${option.binding}-bound.`,
      );
    }
    if (!valueMatchesOption(option, value)) {
      throw requestViolation(
        'CONFIG_VALUE_INVALID',
        `Config option ${optionId} value was not advertised by the Proxy.`,
      );
    }
  }
  for (const [optionId, option] of advertised) {
    if (option.binding !== binding || !option.required) continue;
    if (!conditionsMet(option.visibleWhen, visibleValues)) continue;
    if (!conditionsMet(option.enabledWhen, visibleValues)) continue;
    if (values[optionId] === undefined) {
      throw requestViolation('CONFIG_REQUIRED', `Config option ${optionId} is required.`);
    }
  }
}

export { ProxyProtocolError };
export type { ReplayEvent };
