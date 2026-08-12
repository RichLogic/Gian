import { Buffer } from 'node:buffer';

import {
  MAX_NDJSON_LINE_BYTES,
  OPTIONAL_METHOD_CAPABILITIES,
  type CapabilityName,
  type ProxyMethod,
} from './constants.js';
import {
  protocolViolation,
  ProxyProtocolError,
  requestViolation,
} from './errors.js';
import {
  initializeResultSchema,
  proxyErrorResponseSchema,
  proxyNotificationSchema,
  proxyRequestSchema,
  proxySuccessResponseEnvelopeSchema,
  resultSchemas,
  type InitializeResult,
  type ProxyNotification,
  type ProxyRequest,
  type TurnStartParams,
} from './schemas.js';

type WireId = string | number;

interface PendingRequest {
  method: ProxyMethod;
  params: unknown;
}

interface TurnState {
  tools: Set<string>;
  approvals: Map<string, Set<string>>;
  conversationDeltaSeen: boolean;
}

interface SessionState {
  streamId: string;
  sequence: number;
  activeTurns: Map<string, TurnState>;
  configOptions: Map<string, AdvertisedConfigOption>;
  liveEvents: Map<string, string>;
}

interface AdvertisedConfigOption {
  scope: 'session' | 'turn';
  type: 'select' | 'boolean' | 'number' | 'text';
  choices?: Array<{ value: string | boolean | number | null }>;
}

const inputCapabilities = {
  localFile: 'input.localFile',
  localImage: 'input.localImage',
  skill: 'input.skill',
} as const satisfies Partial<Record<TurnStartParams['input'][number]['type'], CapabilityName>>;

function wireIdKey(id: WireId): string {
  return `${typeof id}:${String(id)}`;
}

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolViolation('NDJSON top-level value must be an object.');
  }
  return value as Record<string, unknown>;
}

export function parseProxyRequest(value: unknown): ProxyRequest {
  const parsed = proxyRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw requestViolation('INVALID_REQUEST', formatIssues(parsed.error));
  }
  return parsed.data;
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
      if (!('sessionId' in event.params)) {
        throw protocolViolation('Process-level runtime.error cannot appear in session replay.');
      }
      if (!('turnId' in event.params)) {
        throw protocolViolation('Session replay can contain only turn-scoped notifications.');
      }
      if (event.params.sessionId !== this.sessionId) {
        throw protocolViolation(
          `Replay event session ${event.params.sessionId} does not match ${this.sessionId}.`,
        );
      }
      if (event.params.streamId !== this.replayStreamId) {
        throw protocolViolation('Replay event streamId does not match replayStreamId.');
      }
      if (event.params.sequence !== this.nextSequence) {
        throw protocolViolation(
          `Replay sequence ${event.params.sequence} does not match expected ${this.nextSequence}.`,
        );
      }

      const fingerprint = canonicalJson(event);
      const existing = this.events.get(event.params.eventId);
      if (existing !== undefined && existing !== fingerprint) {
        throw protocolViolation(
          `Replay event ${event.params.eventId} changed canonical content.`,
        );
      }
      if (existing !== undefined) {
        throw protocolViolation(`Replay event ${event.params.eventId} was duplicated.`);
      }
      this.events.set(event.params.eventId, fingerprint);
      this.nextSequence += 1;
    }
  }
}

const notificationCapabilities: Partial<Record<ProxyNotification['method'], CapabilityName>> = {
  'tool.started': 'event.tool',
  'tool.updated': 'event.tool',
  'tool.completed': 'event.tool',
  'approval.requested': 'approval.relay',
  'approval.resolved': 'approval.relay',
  'plan.updated': 'event.plan',
  'diff.updated': 'event.diff',
  'usage.updated': 'event.usage',
  'agent.updated': 'event.agent',
  'notice.created': 'event.notice',
  'extension.event': 'extension.events',
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
        return undefined;
      case 'reasoning':
        return 'event.reasoning';
      case 'plan':
        return 'event.plan';
      case 'command':
        return 'event.command';
      case 'status':
        return 'event.status';
    }
  }
  return notificationCapabilities[notification.method];
}

export interface HostProtocolValidatorOptions {
  pluginId: string;
  processScope?: 'shared' | 'session';
}

export class HostProtocolValidator {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();
  private initializePending = false;
  private initialized = false;
  private negotiated: InitializeResult | null = null;
  private readonly catalogConfigOptions = new Map<string, AdvertisedConfigOption>();
  private readonly processLiveEvents = new Map<string, string>();

  constructor(private readonly options: HostProtocolValidatorOptions) {}

  get initializeResult(): InitializeResult | null {
    return this.negotiated;
  }

  registerRequest(value: unknown): ProxyRequest {
    const request = parseProxyRequest(value);
    if (!this.initialized && request.method !== 'initialize') {
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
      this.assertConfigOptions(
        this.catalogConfigOptions,
        Object.entries(request.params.config),
        'session',
      );
    } else if (request.method === 'turn.start') {
      this.assertConfigOptions(
        this.sessionConfigOptions(request.params.sessionId, request.params.streamId),
        Object.entries(request.params.config.native),
        'turn',
      );
    } else if (request.method === 'session.config.set') {
      this.assertConfigOptions(
        this.sessionConfigOptions(request.params.sessionId, request.params.streamId),
        [[request.params.optionId, request.params.value]],
        'session',
      );
    }

    const key = wireIdKey(request.id);
    if (this.pending.has(key)) {
      throw requestViolation('CONFLICT', `Request id ${String(request.id)} is already pending.`);
    }
    this.pending.set(key, {
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
    const key = wireIdKey(envelope.id);
    const pending = this.pending.get(key);
    if (!pending) {
      throw protocolViolation(`Response id ${String(envelope.id)} has no pending request.`);
    }
    this.pending.delete(key);

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
      if (initialized.plugin.id !== this.options.pluginId) {
        throw protocolViolation(
          `Handshake plugin id ${initialized.plugin.id} does not match ${this.options.pluginId}.`,
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
    } else if (pending.method === 'session.create') {
      const session = (result.data as unknown as { session: {
        id: string;
        streamId: string;
        configOptions?: Array<AdvertisedConfigOption & { id: string }>;
      } }).session;
      const params = pending.params as { sessionId: string };
      if (session.id !== params.sessionId) {
        throw protocolViolation(
          `session.create returned ${session.id}; expected Host session ${params.sessionId}.`,
        );
      }
      this.sessions.set(session.id, {
        streamId: session.streamId,
        sequence: 0,
        activeTurns: new Map(),
        liveEvents: new Map(),
        configOptions: session.configOptions === undefined
          ? new Map(this.catalogConfigOptions)
          : this.configOptionMap(session.configOptions),
      });
    } else if (pending.method === 'catalog.list') {
      this.catalogConfigOptions.clear();
      const catalog = result.data as {
        sessionOptions: Array<{
          id: string;
          scope: 'session' | 'turn';
          type: AdvertisedConfigOption['type'];
          choices?: AdvertisedConfigOption['choices'];
        }>;
      };
      for (const option of catalog.sessionOptions) {
        this.catalogConfigOptions.set(option.id, {
          scope: option.scope,
          type: option.type,
          ...(option.choices ? { choices: option.choices } : {}),
        });
      }
    } else if (pending.method === 'session.get') {
      const params = pending.params as { sessionId: string };
      const session = (result.data as { session: {
        id: string;
        streamId: string;
        configOptions?: Iterable<AdvertisedConfigOption & { id: string }>;
      } }).session;
      const state = this.sessions.get(params.sessionId);
      if (state === undefined) {
        throw protocolViolation(`session.get returned an unattached session ${params.sessionId}.`);
      }
      if (session.id !== params.sessionId || session.streamId !== state.streamId) {
        throw protocolViolation('session.get returned a different session attachment.');
      }
      if (session.configOptions !== undefined) {
        state.configOptions = this.configOptionMap(session.configOptions);
      }
    } else if (pending.method === 'session.config.set') {
      const params = pending.params as { sessionId: string; streamId: string };
      const configResult = result.data as unknown as {
        session: { id: string; streamId: string };
        configOptions: Iterable<AdvertisedConfigOption & { id: string }>;
      };
      const state = this.sessionState(params.sessionId, params.streamId);
      if (
        configResult.session.id !== params.sessionId
        || configResult.session.streamId !== params.streamId
      ) {
        throw protocolViolation('session.config.set returned a different session attachment.');
      }
      state.configOptions = this.configOptionMap(configResult.configOptions);
    } else if (pending.method === 'session.close') {
      const params = pending.params as { sessionId: string };
      this.sessions.delete(params.sessionId);
    }

    return { id: envelope.id, result: result.data };
  }

  private assertConfigOptions(
    advertised: ReadonlyMap<string, AdvertisedConfigOption>,
    entries: ReadonlyArray<readonly [string, string | boolean | number | null]>,
    expectedScope?: 'session' | 'turn',
  ): void {
    for (const [optionId, value] of entries) {
      const option = advertised.get(optionId);
      if (
        option === undefined
        || (expectedScope !== undefined && option.scope !== expectedScope)
      ) {
        throw requestViolation(
          'INVALID_REQUEST',
          `Config option ${optionId} was not advertised for ${expectedScope ?? 'this session'}.`,
        );
      }
      const validType = value === null
        || (option.type === 'boolean' && typeof value === 'boolean')
        || (option.type === 'number' && typeof value === 'number')
        || (option.type === 'text' && typeof value === 'string')
        || option.type === 'select';
      const validChoice = option.type !== 'select'
        || value === null
        || option.choices?.some(choice => Object.is(choice.value, value)) === true;
      if (!validType || !validChoice) {
        throw requestViolation(
          'INVALID_REQUEST',
          `Config option ${optionId} value was not advertised by the Proxy.`,
        );
      }
    }
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

  private configOptionMap(
    options: Iterable<AdvertisedConfigOption & { id: string }>,
  ): Map<string, AdvertisedConfigOption> {
    return new Map(Array.from(options, option => [option.id, {
      scope: option.scope,
      type: option.type,
      ...(option.choices ? { choices: option.choices } : {}),
    }]));
  }

  private acceptNotification(value: unknown): ProxyNotification {
    if (!this.initialized || this.negotiated === null) {
      throw protocolViolation('Proxy emitted a notification before initialize completed.');
    }
    const notification = parseProxyNotification(value);
    if (notification.method === 'input.recorded') {
      throw protocolViolation('input.recorded is valid only inside session.replay.');
    }
    const capability = capabilityForNotification(notification);
    if (capability !== undefined && this.negotiated.capabilities[capability] === undefined) {
      throw protocolViolation(
        `Proxy emitted ${notification.method} without capability ${capability}.`,
      );
    }

    if (
      notification.method === 'extension.event'
      && notification.params.data.namespace !== this.options.pluginId
    ) {
      throw protocolViolation(
        `Extension namespace ${notification.params.data.namespace} does not match plugin ${this.options.pluginId}.`,
      );
    }

    if (!('sessionId' in notification.params)) {
      this.rememberLiveEvent(notification, this.processLiveEvents);
      return notification;
    }
    const params = notification.params;
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw protocolViolation(
        `Notification references unattached session ${params.sessionId}.`,
      );
    }
    if (params.streamId !== session.streamId) {
      throw protocolViolation(
        `Notification stream ${params.streamId} does not match active stream ${session.streamId}.`,
      );
    }
    const expected = session.sequence + 1;
    if (params.sequence !== expected) {
      throw protocolViolation(
        `Notification sequence ${params.sequence} does not match expected ${expected}.`,
      );
    }
    session.sequence = params.sequence;

    this.validateLifecycle(notification, session);
    if (
      notification.method === 'session.updated'
      && notification.params.data.configOptions !== undefined
    ) {
      session.configOptions = this.configOptionMap(notification.params.data.configOptions);
    }
    this.rememberLiveEvent(notification, session.liveEvents);
    return notification;
  }

  private validateLifecycle(
    notification: ProxyNotification,
    session: SessionState,
  ): void {
    if (!('turnId' in notification.params)) return;
    const { turnId } = notification.params;
    if (notification.method === 'turn.started') {
      if (session.activeTurns.has(turnId)) {
        throw protocolViolation(`Turn ${turnId} started more than once.`);
      }
      session.activeTurns.set(turnId, {
        tools: new Set(),
        approvals: new Map(),
        conversationDeltaSeen: false,
      });
      return;
    }

    const turn = session.activeTurns.get(turnId);
    if (!turn) {
      throw protocolViolation(
        `${notification.method} references inactive turn ${turnId}.`,
      );
    }

    if (notification.method === 'tool.started') {
      const id = notification.params.data.toolCallId;
      if (turn.tools.has(id)) throw protocolViolation(`Tool ${id} started more than once.`);
      turn.tools.add(id);
    } else if (notification.method === 'tool.updated') {
      if (!turn.tools.has(notification.params.data.toolCallId)) {
        throw protocolViolation('tool.updated arrived before tool.started.');
      }
    } else if (notification.method === 'tool.completed') {
      const id = notification.params.data.toolCallId;
      if (!turn.tools.delete(id)) {
        throw protocolViolation('tool.completed arrived without an open tool.');
      }
    } else if (notification.method === 'approval.requested') {
      const id = notification.params.data.approvalId;
      if (turn.approvals.has(id)) {
        throw protocolViolation(`Approval ${id} was requested more than once.`);
      }
      turn.approvals.set(
        id,
        new Set(notification.params.data.options.map(option => option.id)),
      );
    } else if (notification.method === 'approval.resolved') {
      const id = notification.params.data.approvalId;
      const options = turn.approvals.get(id);
      if (options === undefined) {
        throw protocolViolation('approval.resolved arrived without a pending approval.');
      }
      if (
        notification.params.data.resolution === 'selected'
        && (
          notification.params.data.optionId === undefined
          || !options.has(notification.params.data.optionId)
        )
      ) {
        throw protocolViolation(
          `Approval ${id} selected an option that was not advertised.`,
        );
      }
      turn.approvals.delete(id);
    } else if (
      notification.method === 'usage.updated'
      && notification.params.data.conversation?.mode === 'delta'
    ) {
      if (turn.conversationDeltaSeen) {
        throw protocolViolation(`Turn ${turnId} emitted conversation delta usage more than once.`);
      }
      turn.conversationDeltaSeen = true;
    } else if (
      notification.method === 'turn.completed'
      || notification.method === 'turn.failed'
    ) {
      if (turn.tools.size > 0 || turn.approvals.size > 0) {
        throw protocolViolation(
          `Turn ${turnId} terminated with open tools or approvals.`,
        );
      }
      session.activeTurns.delete(turnId);
    }
  }

  private rememberLiveEvent(
    notification: ProxyNotification,
    liveEvents: Map<string, string>,
  ): void {
    const eventId = notification.params.eventId;
    const fingerprint = canonicalJson(notification);
    const existing = liveEvents.get(eventId);
    if (existing !== undefined) {
      throw protocolViolation(existing === fingerprint
        ? `Live event ${eventId} was duplicated.`
        : `Live event ${eventId} changed canonical content.`);
    }
    liveEvents.set(eventId, fingerprint);
  }
}

function zodResponseEnvelope(
  value: unknown,
):
  | { id: WireId; result: unknown }
  | { id: WireId; error: unknown } {
  const success = proxySuccessResponseEnvelopeSchema.safeParse(value);
  if (success.success) return success.data;
  const failure = proxyErrorResponseSchema.safeParse(value);
  if (failure.success) return failure.data;
  throw protocolViolation(
    `Invalid Proxy response: ${formatIssues(success.error)}; ${formatIssues(failure.error)}`,
  );
}

export { ProxyProtocolError };
