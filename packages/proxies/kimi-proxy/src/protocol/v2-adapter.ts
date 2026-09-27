/**
 * gian.proxy/2.1–2.3 adapter for Kimi Code, transport = the Kimi local server
 * API (`kimi web` REST + `/api/v1/ws`). The ACP transport is retired.
 *
 * Notification ordering: the service emits through this adapter; dispatch()
 * queues notifications produced while a request is running and the CLI
 * flushes them AFTER the response (contract §16, Response-before-Notification).
 */

import { createHash } from 'node:crypto';

import { KimiProxyService, normalizeKimiError } from '../core/service.js';
import type { TurnConfigMap } from '../core/service.js';
import { discoverKimiRuntimes, probeKimiRuntime } from '../runtime/discover.js';
import {
  KimiProtocolError,
} from '../transport/protocol.js';

type ConfigValue = string | number | boolean | null;

export type WireRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type V2EventSink = (method: string, params: Record<string, unknown>) => void;

const PROTOCOL_NAME = 'gian.proxy';
const PROTOCOL_V2 = '2.1';
const PROTOCOL_V22 = '2.2';
const PROTOCOL_V23 = '2.3';

/** Capability set on the server-api transport (upstream 2.1.1 evidence in
 *  README). Host MCP injection is NOT declared: the REST session-create
 *  surface does not accept inline MCP servers (engine-side ephemeral
 *  mcpServers never crossed to REST). */
const CAPABILITIES: Record<string, number> = {
  'input.localFile': 1,
  'input.localImage': 1,
  'input.skill': 1,
  'catalog.resolve': 1,
  'session.native.list': 1,
  'session.native.delete': 1,
  'session.replay': 1,
  'session.rename': 1,
  'sidechat': 1,
  'session.fork': 1,
  'turn.steer': 1,
  'interaction': 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.diff': 1,
  'event.usage': 1,
};

const CUSTOMIZATION_CAPABILITIES = { 'customization.list': 1 } as const;

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

  requireStream(sessionId: string, streamId: string): void {
    const active = this.streams.get(sessionId);
    if (active === undefined) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    if (active !== streamId) {
      throw new KimiProtocolError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
  }

  accept(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: unknown;
    config: unknown;
  }): 'new' | 'duplicate' {
    this.requireStream(params.sessionId, params.streamId);
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

class InteractionResponseLedger {
  private readonly entries = new Map<string, string>();

  observe(responseId: string, fingerprint: string): 'new' | 'duplicate' {
    const existing = this.entries.get(responseId);
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        throw new KimiProtocolError('CONFLICT', `Response ${responseId} was reused with different content.`);
      }
      return 'duplicate';
    }
    this.entries.set(responseId, fingerprint);
    return 'new';
  }
}

class ReplayPager {
  private readonly active = new Map<string, {
    replayStreamId: string;
    events: readonly unknown[];
  }>();

  page(
    sessionId: string,
    latest: { replayStreamId: string; events: readonly unknown[] },
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
      replayStreamId: snapshot.replayStreamId,
      events: snapshot.events.slice(offset, end),
      nextCursor,
    };
  }

  close(sessionId: string): void {
    this.active.delete(sessionId);
  }
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KimiProtocolError('INVALID_PARAMS', `${label} must be a non-empty string.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function isConfigValue(value: unknown): value is ConfigValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

interface AttachedSession {
  id: string;
  nativeSessionId: string;
  streamId: string;
  state: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  isSidechat: boolean;
}

interface AttachedSidechat {
  id: string;
  parentSessionId: string;
  streamId: string;
  state: string;
  resumeRef: { id: string };
  anchor: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class KimiProtocolV2Adapter {
  private initialized = false;
  private protocolVersion: '2.1' | '2.2' | '2.3' = '2.1';
  private notificationQueue: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sidechats = new Map<string, AttachedSidechat>();
  private readonly turnLedger = new TurnLedger();
  private readonly responseLedger = new InteractionResponseLedger();
  private readonly replayPager = new ReplayPager();
  private readonly createFingerprints = new Map<string, string>();
  private catalogRevision = '';

  constructor(
    private readonly service: KimiProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V2EventSink,
  ) {
    this.service.setEmitSink((notification) => this.emit(notification.method, notification.params));
  }

  private emit(method: string, params: Record<string, unknown>): void {
    if (this.notificationQueue !== null) {
      this.notificationQueue.push({ method, params });
      return;
    }
    this.emitEvent(method, params);
  }

  async dispatch(request: WireRequest): Promise<
    | { ok: true; result: unknown; notifications: Array<{ method: string; params: Record<string, unknown> }> }
    | { ok: false; error: unknown; notifications: Array<{ method: string; params: Record<string, unknown> }> }
  > {
    const capturesNotifications = request.method !== 'customization.list'
      && request.method !== 'customization.detail';
    const queue = capturesNotifications
      ? [] as Array<{ method: string; params: Record<string, unknown> }>
      : null;
    const previous = this.notificationQueue;
    if (queue) this.notificationQueue = queue;
    try {
      const result = await this.route(request);
      return { ok: true, result, notifications: queue ?? [] };
    } catch (error) {
      return { ok: false, error, notifications: queue ?? [] };
    } finally {
      if (queue) this.notificationQueue = previous;
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
      case 'catalog.resolve': return this.resolveCatalog(request.params);
      case 'session.create': return this.createSession(request.params);
      case 'session.get': return { session: this.serialize(this.requireOrdinarySession(nonEmptyString(request.params.sessionId, 'sessionId'))) };
      case 'turn.start': return this.startTurn(request.params);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'turn.steer': return this.steerTurn(request.params);
      case 'interaction.respond': return this.respondInteraction(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'session.rename': return this.renameSession(request.params);
      case 'session.fork': return this.forkSession(request.params);
      case 'sidechat.create': return this.createSidechat(request.params);
      case 'sidechat.resume': return this.resumeSidechat(request.params);
      case 'sidechat.close': return this.closeSidechat(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.native.delete': return this.deleteNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'runtime.discover':
        if (this.protocolVersion === '2.1') {
          throw new KimiProtocolError('METHOD_NOT_FOUND', 'runtime.discover requires gian.proxy/2.2.');
        }
        return discoverKimiRuntimes();
      case 'runtime.probe':
        if (this.protocolVersion === '2.1') {
          throw new KimiProtocolError('METHOD_NOT_FOUND', 'runtime.probe requires gian.proxy/2.2.');
        }
        return probeKimiRuntime(String(request.params.path ?? ''));
      case 'customization.list':
      case 'customization.detail':
        if (this.protocolVersion !== '2.3') {
          throw new KimiProtocolError('CAPABILITY_NOT_SUPPORTED', `${request.method} requires gian.proxy/2.3.`);
        }
        return request.method === 'customization.list'
          ? this.service.inspectCustomizations({
              kind: request.params.kind as import('@gian/proxy-protocol').CustomizationKind,
              ...(request.params.cwd !== undefined && request.params.cwd !== null ? { cwd: String(request.params.cwd) } : {}),
            })
          : this.service.customizationDetail({
              kind: request.params.kind as import('@gian/proxy-protocol').CustomizationKind,
              id: nonEmptyString(request.params.id, 'id'),
              ...(request.params.cwd !== undefined && request.params.cwd !== null ? { cwd: String(request.params.cwd) } : {}),
            });
      case 'shutdown': return { ok: true as const };
      default:
        throw new KimiProtocolError('METHOD_NOT_FOUND', `Unknown method ${request.method}.`);
    }
  }

  // ---- initialize ----

  private initialize(params: Record<string, unknown>) {
    if (this.initialized) {
      throw new KimiProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.');
    }
    const protocol = record(params.protocol);
    const versions = Array.isArray(protocol.versions) ? protocol.versions.map(String) : [];
    const selected = versions.includes(PROTOCOL_V23)
      ? PROTOCOL_V23
      : versions.includes(PROTOCOL_V22)
        ? PROTOCOL_V22
        : versions.includes(PROTOCOL_V2)
          ? PROTOCOL_V2
          : null;
    if (protocol.name !== PROTOCOL_NAME || selected === null) {
      throw new KimiProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.1, 2.2, or 2.3 is required.');
    }
    this.initialized = true;
    this.protocolVersion = selected;
    const capabilities: Record<string, number> = { ...CAPABILITIES };
    if (selected !== '2.1') {
      capabilities['runtime.discover'] = 1;
      capabilities['runtime.probe'] = 1;
    }
    if (selected === '2.3') Object.assign(capabilities, CUSTOMIZATION_CAPABILITIES);
    return {
      protocol: { name: PROTOCOL_NAME, version: selected },
      plugin: { id: 'kimi', name: 'Kimi Code', version: this.pluginVersion },
      process: { scope: 'shared' as const },
      capabilities,
    };
  }

  // ---- catalog ----

  private async catalog() {
    return this.finishCatalog(await this.projectedOptions({}));
  }

  private async projectedOptions(turnConfig: TurnConfigMap): Promise<Array<Record<string, unknown>>> {
    const facts = await this.service.catalogFacts();
    const models = facts.models;
    const options: Array<Record<string, unknown>> = [];
    if (models.length > 0) {
      const known = (value: string) => models.some((model) => model.model === value);
      const requested = turnConfig.model;
      const selectedModel = requested !== undefined && known(requested)
        ? requested
        : facts.defaultModel !== null && known(facts.defaultModel)
          ? facts.defaultModel
          : models[0]!.model;
      options.push({
        id: 'model',
        displayName: 'Model',
        description: 'Kimi model for the next turn.',
        binding: 'turn',
        control: 'select',
        required: true,
        defaultValue: selectedModel,
        choices: models.map((model) => ({
          value: model.model,
          displayName: model.display_name ?? model.model,
        })),
      });
      const selected = models.find((model) => model.model === selectedModel);
      const efforts = (selected?.support_efforts ?? []).filter((effort) => typeof effort === 'string' && effort !== '');
      if (efforts.length > 0) {
        options.push({
          id: 'thinking',
          displayName: 'Thinking',
          description: 'Reasoning effort for the selected model.',
          binding: 'turn',
          control: 'select',
          required: true,
          defaultValue: selected?.default_effort !== undefined && efforts.includes(selected.default_effort)
            ? selected.default_effort
            : efforts[0],
          choices: efforts.map((effort) => ({ value: effort, displayName: effort })),
        });
      }
    }
    options.push({
      id: 'approval_mode',
      displayName: 'Approval mode',
      description: 'How Kimi asks for permission before acting.',
      binding: 'turn',
      control: 'select',
      required: true,
      defaultValue: 'manual',
      choices: [
        { value: 'manual', displayName: 'Manual' },
        { value: 'yolo', displayName: 'Yolo' },
        { value: 'auto', displayName: 'Auto' },
      ],
    });
    return options;
  }

  private async finishCatalog(configOptions: Array<Record<string, unknown>>) {
    const has = (id: string) => configOptions.some((option) => option.id === id);
    const specialCatalogs = {
      ...(has('model') ? { model: 'model' } : {}),
      ...(has('thinking') ? { thinking: 'thinking' } : {}),
      approvalMode: 'approval_mode',
    };
    const payload = {
      catalogRevision: '',
      input: [
        { type: 'text' as const },
        { type: 'localFile' as const },
        { type: 'localImage' as const },
        { type: 'skill' as const },
      ],
      configOptions,
      specialCatalogs,
      actions: [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: true },
        {
          id: 'session.fork.atTurn',
          supported: false,
          reason: 'The Kimi server API exposes only head forks (POST /sessions/{id}/children has no turn boundary).',
        },
        { id: 'session.native.delete', supported: true },
      ],
      slashCommands: [] as Array<{ name: string; description: string; source: 'builtin'; argHints: Array<{ kind: 'free' }> }>,
    };
    payload.catalogRevision = stableId('catalog', {
      input: payload.input,
      configOptions,
      specialCatalogs,
      actions: payload.actions,
      slashCommands: payload.slashCommands,
    });
    this.catalogRevision = payload.catalogRevision;
    return payload;
  }

  private async resolveCatalog(params: Record<string, unknown>) {
    const catalogRevision = nonEmptyString(params.catalogRevision, 'catalogRevision');
    if (catalogRevision !== this.catalogRevision) {
      throw new KimiProtocolError('CONFIG_VALUE_INVALID', 'Unknown catalogRevision; call catalog.list again.');
    }
    const sessionConfig = record(params.sessionConfig);
    if (Object.keys(sessionConfig).length > 0) {
      throw new KimiProtocolError(
        'CONFIG_BINDING_INVALID',
        'Kimi config options are turn-bound; send them in turnConfig, not sessionConfig.',
      );
    }
    const turnConfig = record(params.turnConfig);
    const allowed = new Set(['model', 'thinking', 'approval_mode']);
    for (const key of Object.keys(turnConfig)) {
      if (!allowed.has(key)) {
        throw new KimiProtocolError('CONFIG_VALUE_INVALID', `Unknown turn config option ${key}.`);
      }
      if (!isConfigValue(turnConfig[key])) {
        throw new KimiProtocolError('CONFIG_VALUE_INVALID', `Config option ${key} must be a scalar.`);
      }
    }
    const requested: TurnConfigMap = {
      ...(typeof turnConfig.model === 'string' ? { model: turnConfig.model } : {}),
      ...(typeof turnConfig.thinking === 'string' ? { thinking: turnConfig.thinking } : {}),
      ...(typeof turnConfig.approval_mode === 'string' ? { approval_mode: turnConfig.approval_mode } : {}),
    };
    const baseline = await this.projectedOptions({});
    const baselineModel = (baseline.find((option) => option.id === 'model') as { defaultValue?: string } | undefined)?.defaultValue;
    const modelChanged = requested.model !== undefined && requested.model !== baselineModel;
    const projected = await this.projectedOptions(requested);
    const resolved: Record<string, ConfigValue> = {};
    for (const option of projected) {
      const id = option.id as string;
      const choices = (option.choices ?? []) as Array<{ value: ConfigValue }>;
      const provided = turnConfig[id];
      const valid = provided !== undefined && choices.some((choice) => Object.is(choice.value, provided));
      if (provided !== undefined && !valid && !(id === 'thinking' && modelChanged)) {
        // A Thinking value made stale by an explicit model change is dropped,
        // not rejected: the new model's own default takes over.
        throw new KimiProtocolError('CONFIG_VALUE_INVALID', `Config option ${id} value was not advertised.`);
      }
      const value = valid ? provided : option.defaultValue;
      if (value !== null && value !== undefined) {
        resolved[id] = value as ConfigValue;
      }
    }
    const payload = await this.finishCatalog(projected);
    return {
      ...payload,
      resolvedDefaults: {
        sessionConfig: {},
        turnConfig: resolved,
      },
    };
  }

  // ---- session lifecycle ----

  private async createSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const workspace = record(params.workspace);
    const cwd = nonEmptyString(workspace.cwd, 'workspace.cwd');
    const config = record(params.config);
    if (Object.keys(config).length > 0) {
      throw new KimiProtocolError(
        'CONFIG_BINDING_INVALID',
        'Kimi config options are turn-bound; session.create takes an empty config snapshot.',
      );
    }
    if (params.hostServices !== undefined) {
      throw new KimiProtocolError(
        'CAPABILITY_NOT_SUPPORTED',
        'The Kimi server API has no per-session MCP injection: session/create does not accept inline '
        + 'MCP servers (the engine-side ephemeral mcpServers never crossed to the REST surface), and '
        + "writing the user-level mcp.json would exceed Gian's configuration boundary.",
      );
    }
    const nativeSession = params.nativeSession !== undefined && params.nativeSession !== null
      ? record(params.nativeSession)
      : null;
    const nativeId = nativeSession !== null && typeof nativeSession.id === 'string' && nativeSession.id !== ''
      ? nativeSession.id
      : undefined;
    const history = nativeSession !== null && nativeSession.history === 'replay' ? 'replay' as const : 'none' as const;

    // Idempotency: same id + same request replays the snapshot. Only the
    // workspace fingerprints the create: native-id/history differences are
    // legal rebinds after a runtime restart, and a wrong native id is
    // rejected by the service's ownership check instead.
    const fingerprint = JSON.stringify({ cwd });
    if (this.sessions.has(sessionId)) {
      const known = this.createFingerprints.get(sessionId);
      if (known !== undefined && known !== fingerprint) {
        throw new KimiProtocolError('CONFLICT', 'session.create was replayed with different parameters.');
      }
      const result = await this.service.createSession({
        sessionId, cwd, history,
        ...(nativeId !== undefined ? { nativeSessionId: nativeId } : {}),
      });
      this.turnLedger.attach(sessionId, result.snapshot.streamId as string);
      return { session: result.snapshot };
    }

    const result = await this.service.createSession({
      sessionId, cwd, history,
      ...(nativeId !== undefined ? { nativeSessionId: nativeId } : {}),
    });
    this.createFingerprints.set(sessionId, fingerprint);
    this.trackSession(sessionId, result.snapshot, false);
    this.turnLedger.attach(sessionId, result.snapshot.streamId as string);
    if (result.replayNotifications !== undefined) {
      for (const notification of result.replayNotifications) {
        this.emit(notification.method, notification.params);
      }
    }
    return { session: result.snapshot };
  }

  private trackSession(sessionId: string, snapshot: Record<string, unknown>, isSidechat: boolean): void {
    const entry: AttachedSession = {
      id: snapshot.id as string,
      nativeSessionId: (snapshot.nativeSession as { id: string } | undefined)?.id
        ?? this.service.get(sessionId)?.nativeSessionId
        ?? '',
      streamId: snapshot.streamId as string,
      state: snapshot.state as string,
      lastError: null,
      createdAt: snapshot.createdAt as string,
      updatedAt: snapshot.updatedAt as string,
      isSidechat,
    };
    this.sessions.set(sessionId, entry);
    if (isSidechat) {
      this.sidechats.set(sessionId, {
        id: sessionId,
        parentSessionId: (snapshot as { parentSessionId?: string }).parentSessionId ?? '',
        streamId: entry.streamId,
        state: entry.state,
        resumeRef: (snapshot as { resumeRef?: { id: string } }).resumeRef ?? { id: '' },
        anchor: (snapshot as { anchor?: Record<string, unknown> }).anchor ?? { type: 'empty' },
        lastError: null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  }

  private requireOrdinarySession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    if (session.isSidechat) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${sessionId} is a Side Chat.`);
    }
    return session;
  }

  private serialize(session: AttachedSession): Record<string, unknown> {
    return {
      id: session.id,
      nativeSession: { id: session.nativeSessionId },
      streamId: session.streamId,
      state: session.state as 'idle' | 'running' | 'waiting_interaction' | 'stale',
      sessionConfig: {},
      ...(session.lastError !== null ? { lastError: session.lastError } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  // ---- turns ----

  private async startTurn(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const turnId = nonEmptyString(params.turnId, 'turnId');
    const input = Array.isArray(params.input) ? params.input as Array<Record<string, unknown>> : [];
    const config = record(params.config);
    const observed = this.turnLedger.accept({ sessionId, streamId, turnId, input, config });
    if (observed === 'duplicate') {
      return { accepted: true, turnId };
    }
    try {
      await this.service.startTurn({
        sessionId,
        streamId,
        turnId,
        input: input as never,
        config: {
          ...(typeof config.model === 'string' ? { model: config.model } : {}),
          ...(typeof config.thinking === 'string' ? { thinking: config.thinking } : {}),
          ...(typeof config.approval_mode === 'string' ? { approval_mode: config.approval_mode } : {}),
        },
      });
    } catch (error) {
      this.turnLedger.forget({ sessionId, streamId, turnId });
      throw error;
    }
    return { accepted: true, turnId };
  }

  private async steerTurn(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const turnId = nonEmptyString(params.turnId, 'turnId');
    this.turnLedger.requireStream(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input as Array<Record<string, unknown>> : [];
    await this.service.steerTurn({ sessionId, streamId, turnId, input: input as never });
    return { accepted: true, turnId };
  }

  private async interruptTurn(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const turnId = nonEmptyString(params.turnId, 'turnId');
    this.turnLedger.requireStream(sessionId, streamId);
    await this.service.interruptTurn({ sessionId, streamId, turnId });
    return { accepted: true, turnId };
  }

  // ---- interactions ----

  private async respondInteraction(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const turnId = nonEmptyString(params.turnId, 'turnId');
    const responseId = nonEmptyString(params.responseId, 'responseId');
    const interactionId = nonEmptyString(params.interactionId, 'interactionId');
    const actionId = nonEmptyString(params.actionId, 'actionId');
    const values = record(params.values);
    this.turnLedger.requireStream(sessionId, streamId);
    const observed = this.responseLedger.observe(
      responseId,
      JSON.stringify({ interactionId, actionId, values }),
    );
    if (observed === 'duplicate') {
      return { accepted: true, interactionId, responseId };
    }
    await this.service.respondInteraction({
      sessionId, streamId, turnId, interactionId, actionId, values,
    });
    return { accepted: true, interactionId, responseId };
  }

  // ---- close / rename / delete / list / replay ----

  private async closeSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const sidechat = this.sidechats.get(sessionId);
    if (sidechat !== undefined) {
      await this.service.closeSidechat({ sidechatId: sessionId, resumeRef: sidechat.resumeRef, streamId });
      this.sidechats.delete(sessionId);
    } else {
      await this.service.closeSession(sessionId, streamId);
    }
    this.turnLedger.close(sessionId);
    this.replayPager.close(sessionId);
    this.sessions.delete(sessionId);
    this.createFingerprints.delete(sessionId);
    return { ok: true as const };
  }

  private async renameSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const name = params.name;
    if (typeof name !== 'string' || [...name].length === 0 || [...name].length > 200) {
      throw new KimiProtocolError('INVALID_PARAMS', 'params.name must be 1-200 Unicode code points.');
    }
    this.turnLedger.requireStream(sessionId, streamId);
    await this.service.renameSession(sessionId, streamId, name);
    return { ok: true as const };
  }

  private async deleteNative(params: Record<string, unknown>) {
    const nativeSessionId = nonEmptyString(params.nativeSessionId, 'nativeSessionId');
    await this.service.deleteNativeSession(nativeSessionId);
    return { ok: true as const };
  }

  private async listNative(params: Record<string, unknown>) {
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 500) : 100;
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : null;
    const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : undefined;
    return await this.service.listNativeSessions({
      ...(cwd !== undefined ? { cwd } : {}),
      ...(cursor !== null ? { cursor } : {}),
      limit,
    });
  }

  private async replay(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const streamId = nonEmptyString(params.streamId, 'streamId');
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 500) : 200;
    const cursor = params.cursor === null || params.cursor === undefined ? null : String(params.cursor);
    this.turnLedger.requireStream(sessionId, streamId);
    const result = await this.service.replay({ sessionId, streamId, cursor });
    return this.replayPager.page(
      sessionId,
      { replayStreamId: result.replayStreamId, events: result.events },
      cursor,
      limit,
    );
  }

  // ---- fork & side chat ----

  private async forkSession(params: Record<string, unknown>) {
    const sourceSessionId = nonEmptyString(params.sourceSessionId, 'sourceSessionId');
    const sourceStreamId = nonEmptyString(params.sourceStreamId, 'sourceStreamId');
    const sessionId = nonEmptyString(params.sessionId, 'sessionId');
    const anchorRaw = record(params.anchor);
    if (this.sessions.has(sessionId)) {
      throw new KimiProtocolError('CONFLICT', `Session ${sessionId} already exists.`);
    }
    const anchor = anchorRaw.type === 'turn'
      ? {
          type: 'turn' as const,
          turnId: nonEmptyString(anchorRaw.turnId, 'anchor.turnId'),
          sourceTurnId: nonEmptyString(anchorRaw.sourceTurnId, 'anchor.sourceTurnId'),
        }
      : { type: 'head' as const };
    const result = await this.service.forkSession({ sourceSessionId, sourceStreamId, sessionId, anchor });
    this.trackSession(sessionId, result.session, false);
    this.turnLedger.attach(sessionId, result.session.streamId as string);
    return result;
  }

  private async createSidechat(params: Record<string, unknown>) {
    const parentSessionId = nonEmptyString(params.parentSessionId, 'parentSessionId');
    const parentStreamId = nonEmptyString(params.parentStreamId, 'parentStreamId');
    const sidechatId = nonEmptyString(params.sidechatId, 'sidechatId');
    const existing = this.sidechats.get(sidechatId);
    if (existing !== undefined) {
      // Idempotent replay of the same create.
      return { sidechat: this.serializeSidechat(existing) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new KimiProtocolError('CONFLICT', `Session ${sidechatId} already exists.`);
    }
    const snapshot = await this.service.createSidechat({ parentSessionId, parentStreamId, sidechatId });
    this.trackSession(sidechatId, snapshot, true);
    const attached = this.sidechats.get(sidechatId)!;
    this.turnLedger.attach(sidechatId, attached.streamId);
    return { sidechat: this.serializeSidechat(attached) };
  }

  private async resumeSidechat(params: Record<string, unknown>) {
    const sidechatId = nonEmptyString(params.sidechatId, 'sidechatId');
    const parentSessionId = nonEmptyString(params.parentSessionId, 'parentSessionId');
    const resumeRefRaw = record(params.resumeRef);
    const resumeRef = { id: nonEmptyString(resumeRefRaw.id, 'resumeRef.id') };
    const existing = this.sidechats.get(sidechatId);
    if (existing !== undefined && existing.resumeRef.id === resumeRef.id) {
      return { sidechat: this.serializeSidechat(existing) };
    }
    const snapshot = await this.service.resumeSidechat({ sidechatId, parentSessionId, resumeRef });
    this.trackSession(sidechatId, snapshot, true);
    const attached = this.sidechats.get(sidechatId)!;
    attached.resumeRef = resumeRef;
    this.turnLedger.attach(sidechatId, attached.streamId);
    return { sidechat: this.serializeSidechat(attached) };
  }

  private async closeSidechat(params: Record<string, unknown>) {
    const sidechatId = nonEmptyString(params.sidechatId, 'sidechatId');
    const resumeRefRaw = record(params.resumeRef);
    const resumeRef = { id: nonEmptyString(resumeRefRaw.id, 'resumeRef.id') };
    const streamId = typeof params.streamId === 'string' && params.streamId !== '' ? params.streamId : undefined;
    await this.service.closeSidechat({
      sidechatId,
      resumeRef,
      ...(streamId !== undefined ? { streamId } : {}),
    });
    this.turnLedger.close(sidechatId);
    this.replayPager.close(sidechatId);
    this.sidechats.delete(sidechatId);
    this.sessions.delete(sidechatId);
    return { ok: true as const, sidechatId, providerDataDeleted: false };
  }

  private serializeSidechat(sidechat: AttachedSidechat): Record<string, unknown> {
    return {
      id: sidechat.id,
      parentSessionId: sidechat.parentSessionId,
      streamId: sidechat.streamId,
      state: sidechat.state as 'idle' | 'running' | 'waiting_interaction' | 'stale',
      resumeRef: sidechat.resumeRef,
      anchor: sidechat.anchor,
      sessionConfig: {},
      ...(sidechat.lastError !== null ? { lastError: sidechat.lastError } : {}),
      createdAt: sidechat.createdAt,
      updatedAt: sidechat.updatedAt,
    };
  }

  // ---- shutdown ----

  async shutdown(): Promise<void> {
    await this.service.shutdown();
  }
}

/** Normalize any error into a KimiProtocolError for the wire. */
export function standardError(error: unknown): KimiProtocolError {
  return normalizeKimiError(error);
}
