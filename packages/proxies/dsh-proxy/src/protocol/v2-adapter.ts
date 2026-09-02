/**
 * gian.proxy/2.1 adapter for ai.deepseek.harness.
 *
 * The adapter owns the outer wire contract: initialize identity, capability
 * narrowing, catalog projection from bridge facts, session/turn request
 * validation and idempotency, and the two-phase response-before-notification
 * queue.
 */

import { createHash } from 'node:crypto';
import { verifyNativeSessionHostBinding } from '@gian/proxy-protocol';
import {
  PLUGIN_ID,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  DshProxyService,
  ServiceError,
  type ConfigValue,
  type SessionStateName,
} from '../core/service.js';
import type { BridgeClient } from '../runtime/bridge-client.js';

export interface WireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface DispatchOutcome {
  ok: boolean;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
  };
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

export interface ConfigOption {
  id: string;
  displayName: string;
  description?: string;
  binding: 'session' | 'turn';
  role?: string;
  control: 'select' | 'boolean' | 'number' | 'text';
  required: boolean;
  defaultValue: ConfigValue;
  choices?: Array<{ value: ConfigValue; displayName: string; description?: string }>;
}

const CAPABILITIES: Record<string, number> = {
  'catalog.resolve': 1,
  'session.replay': 1,
  'session.create.hostBindingProof': 1,
  'event.reasoning': 1,
  'event.usage': 1,
  'event.step': 1,
  'event.request': 1,
};

function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input === null || typeof input !== 'object') return input;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      const child = (input as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalize(child);
    }
    return out;
  };
  return JSON.stringify(canonicalize(value));
}

function fingerprint(params: { input: unknown; config: unknown }): string {
  return createHash('sha256').update(canonicalJson({ input: params.input, config: params.config })).digest('hex');
}

interface CatalogState {
  catalogRevision: string;
  configOptions: ConfigOption[];
}

export class DshV2Adapter {
  private initialized = false;
  private readonly service: DshProxyService;
  private catalogState: CatalogState = {
    catalogRevision: `dsh-catalog-${PLUGIN_VERSION}-bootstrap`,
    configOptions: this.defaultConfigOptions(),
  };
  private queue: Array<{ method: string; params: Record<string, unknown> }> | null = null;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly options: { pluginVersion?: string; hostBindingKey?: string } = {},
  ) {
    this.service = new DshProxyService({
      emit: (event) => this.emit(event.method, event.params),
      pluginVersion: options.pluginVersion ?? PLUGIN_VERSION,
    });
    this.bridge.onNotification((notification) => {
      this.service.handleBridgeNotification(notification);
    });
  }

  private emit(method: string, params: Record<string, unknown>): void {
    if (this.queue) {
      this.queue.push({ method, params });
      return;
    }
    this.optionsEmit(method, params);
  }

  /** Replaceable sink for tests; defaults to no-op until the CLI wires it. */
  private optionsEmit: (method: string, params: Record<string, unknown>) => void = () => undefined;
  setEmitSink(sink: (method: string, params: Record<string, unknown>) => void): void {
    this.optionsEmit = sink;
  }

  /** Dispatch a request and flush its generated notifications after the
   * response is written (contract §16 ordering). */
  async dispatch(request: WireRequest): Promise<DispatchOutcome> {
    const queue: Array<{ method: string; params: Record<string, unknown> }> = [];
    const previous = this.queue;
    this.queue = queue;
    try {
      const result = await this.route(request);
      return { ok: true, result, notifications: queue };
    } catch (error) {
      const normalized = normalizeError(error);
      return { ok: false, error: normalized, notifications: queue };
    } finally {
      this.queue = previous;
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.emit(method, params);
  }

  private async route(request: WireRequest): Promise<unknown> {
    const { method, params } = request;
    if (method !== 'initialize' && method !== 'shutdown' && this.initialized === false) {
      throw new ServiceError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'catalog.list':
        return this.catalogList();
      case 'catalog.resolve':
        return this.catalogResolve(params);
      case 'session.create':
        return this.sessionCreate(params);
      case 'session.get':
        return this.sessionGet(params);
      case 'turn.start':
        return this.turnStart(params);
      case 'turn.interrupt':
        return this.turnInterrupt(params);
      case 'turn.steer':
        return this.turnSteer(params);
      case 'interaction.respond':
        throw new ServiceError(
          'CAPABILITY_NOT_SUPPORTED',
          'Interactive DSH approval and question routing is not advertised.',
        );
      case 'session.close':
        return this.sessionClose(params);
      case 'session.replay':
        return this.sessionReplay(params);
      case 'session.native.list':
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.native.list is not advertised for DSH.');
      case 'session.native.delete':
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.native.delete is not advertised for DSH.');
      case 'session.rename':
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.rename is not advertised for DSH.');
      case 'shutdown':
        return this.shutdown();
      default:
        throw new ServiceError('METHOD_NOT_FOUND', `Unknown method ${method}.`);
    }
  }

  private defaultConfigOptions(): ConfigOption[] {
    return [
      {
        id: 'provider',
        displayName: 'Provider',
        description: 'DSH model provider route.',
        binding: 'turn',
        control: 'select',
        required: false,
        defaultValue: 'deepseek-official',
        choices: [{ value: 'deepseek-official', displayName: 'DeepSeek' }],
      },
      {
        id: 'model',
        displayName: 'Model',
        description: 'Provider model for DeepSeek Harness turns.',
        binding: 'turn',
        control: 'select',
        required: true,
        defaultValue: 'deepseek-chat',
        choices: [
          { value: 'deepseek-chat', displayName: 'DeepSeek Chat' },
          { value: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
        ],
      },
      {
        id: 'effort',
        displayName: 'Reasoning effort',
        binding: 'turn',
        control: 'select',
        required: false,
        defaultValue: 'medium',
        choices: [
          { value: 'low', displayName: 'Low' },
          { value: 'medium', displayName: 'Medium' },
          { value: 'high', displayName: 'High' },
        ],
      },
    ];
  }

  private async initialize(params: Record<string, unknown>): Promise<unknown> {
    if (this.initialized) throw new ServiceError('ALREADY_INITIALIZED', 'initialize can only be sent once.');
    const protocol = (params.protocol ?? {}) as Record<string, unknown>;
    if ((protocol as { name?: unknown }).name !== 'gian.proxy') {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'Expected gian.proxy protocol name.');
    }
    const versions = Array.isArray(protocol.versions) ? protocol.versions as unknown[] : [];
    if (!versions.includes('2.1')) {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'Only gian.proxy/2.1 is supported.');
    }
    // Bridge initialize: fail hard when the child cannot establish the bridge.
    await this.bridge.request('initialize', { protocol: { versions: ['1.0'] } });
    const catalog = await this.bridge.request('catalog.list', {});
    this.catalogState = {
      catalogRevision: this.catalogRevisionFrom(catalog),
      configOptions: this.catalogOptionsFrom(catalog),
    };
    this.initialized = true;
    return {
      protocol: { name: 'gian.proxy', version: '2.1' },
      plugin: { id: PLUGIN_ID, name: PLUGIN_NAME, version: this.options.pluginVersion ?? PLUGIN_VERSION },
      process: { scope: 'shared' },
      capabilities: CAPABILITIES,
    };
  }

  private catalogOptionsFrom(
    catalog: Record<string, unknown>,
    selectedModel?: string,
    selectedProvider?: string,
  ): ConfigOption[] {
    const models = Array.isArray(catalog.models) ? catalog.models as Array<Record<string, unknown>> : [];
    const providers = Array.isArray(catalog.providers)
      ? catalog.providers as Array<Record<string, unknown>>
      : [];
    const defaults = catalog.defaultSelection !== null && typeof catalog.defaultSelection === 'object'
      ? catalog.defaultSelection as Record<string, unknown>
      : {};
    const base = this.defaultConfigOptions();
    const providerOption = base.find(option => option.id === 'provider');
    if (providerOption && providers.length > 0) {
      providerOption.choices = providers.map(provider => ({
        value: String(provider.id),
        displayName: String(provider.label ?? provider.name ?? provider.id),
      }));
      const defaultProvider = selectedProvider
        ?? (typeof defaults.provider === 'string' ? defaults.provider : undefined)
        ?? providerOption.choices[0]?.value;
      if (defaultProvider !== undefined) providerOption.defaultValue = defaultProvider;
    }
    const effectiveProvider = String(providerOption?.defaultValue ?? selectedProvider ?? '');
    const providerModels = models.filter(model => model.provider === effectiveProvider);
    const visibleModels = providerModels.length > 0 ? providerModels : models;
    if (visibleModels.length > 0) {
      const modelOption = base.find(option => option.id === 'model');
      if (modelOption) {
        const defaultModel = selectedModel
          ?? (defaults.provider === effectiveProvider && typeof defaults.model === 'string'
            ? defaults.model
            : undefined)
          ?? visibleModels[0]?.id;
        const index = base.indexOf(modelOption);
        base[index] = {
          ...modelOption,
          choices: visibleModels.map((model) => ({
            value: String(model.id ?? model),
            displayName: String(model.label ?? model.id ?? model),
          })),
          defaultValue: String(defaultModel ?? 'deepseek-chat'),
        };
      }
    }
    const effectiveModel = selectedModel
      ?? String(base.find(option => option.id === 'model')?.defaultValue ?? '');
    const model = visibleModels.find(candidate => candidate.id === effectiveModel) ?? visibleModels[0];
    const reasoning = model?.reasoning !== null && typeof model?.reasoning === 'object'
      ? model.reasoning as Record<string, unknown>
      : null;
    const efforts = Array.isArray(reasoning?.efforts)
      ? reasoning.efforts as Array<Record<string, unknown>>
      : [];
    if (efforts.length > 0) {
      const effortOption = base.find(option => option.id === 'effort');
      if (effortOption) {
        effortOption.choices = efforts.map(effort => ({
          value: String(effort.id),
          displayName: String(effort.label ?? effort.name ?? effort.id),
          ...(typeof effort.description === 'string'
            ? { description: effort.description }
            : {}),
        }));
        const defaultEffort = typeof reasoning?.defaultEffort === 'string'
          ? reasoning.defaultEffort
          : effortOption.choices[0]?.value;
        if (defaultEffort !== undefined) effortOption.defaultValue = defaultEffort;
      }
    } else {
      const effortIndex = base.findIndex(option => option.id === 'effort');
      if (effortIndex >= 0) base.splice(effortIndex, 1);
    }
    return base;
  }

  private catalogRevisionFrom(catalog: Record<string, unknown>): string {
    const nativeRevision = typeof catalog.catalogRevision === 'string'
      ? catalog.catalogRevision
      : 'unknown';
    const digest = createHash('sha256').update(nativeRevision).digest('hex').slice(0, 16);
    return `dsh-catalog-${PLUGIN_VERSION}-${digest}`;
  }

  private async catalogList(): Promise<unknown> {
    const native = await this.bridge.request('catalog.list', {});
    this.catalogState = {
      catalogRevision: this.catalogRevisionFrom(native),
      configOptions: this.catalogOptionsFrom(native),
    };
    return this.catalog();
  }

  private catalog(
    configOptions = this.catalogState.configOptions,
    catalogRevision = this.catalogState.catalogRevision,
  ): unknown {
    const hasThinking = configOptions.some(option => option.id === 'effort');
    return {
      catalogRevision,
      input: [{ type: 'text' }],
      configOptions,
      specialCatalogs: {
        model: 'model',
        ...(hasThinking ? { thinking: 'effort' } : {}),
      },
      slashCommands: [],
    };
  }

  private async catalogResolve(params: Record<string, unknown>): Promise<unknown> {
    const turnConfig = (params.turnConfig ?? {}) as Record<string, ConfigValue>;
    const bridgeResolved = await this.bridge.request('catalog.resolve', params).catch(() => null);
    const selectedModel = typeof turnConfig.model === 'string' ? turnConfig.model : undefined;
    const selectedProvider = typeof turnConfig.provider === 'string' ? turnConfig.provider : undefined;
    const options = bridgeResolved && typeof bridgeResolved === 'object'
      ? this.catalogOptionsFrom(bridgeResolved, selectedModel, selectedProvider)
      : this.catalogState.configOptions;
    const catalogRevision = bridgeResolved && typeof bridgeResolved === 'object'
      ? this.catalogRevisionFrom(bridgeResolved)
      : this.catalogState.catalogRevision;
    const resolvedTurnConfig = { ...turnConfig };
    for (const option of options) {
      if (option.binding === 'turn' && resolvedTurnConfig[option.id] === undefined) {
        resolvedTurnConfig[option.id] = option.defaultValue;
      }
    }
    const resolvedDefaults = { sessionConfig: {}, turnConfig: resolvedTurnConfig };
    const base = this.catalog(options, catalogRevision) as Record<string, unknown>;
    return { ...base, resolvedDefaults };
  }

  private sessionCreateParams(params: Record<string, unknown>): {
    sessionId: string;
    workspace: { cwd: string; roots: string[] };
    config: Record<string, ConfigValue>;
    nativeSessionId: string | null;
    history: 'none' | 'replay';
    hostBindingProof: string | null;
    hostServices: unknown[];
  } {
    const sessionId = stringField(params, 'sessionId');
    const workspace = (params.workspace ?? {}) as Record<string, unknown>;
    const cwd = stringField(workspace, 'cwd');
    const roots = Array.isArray(workspace.roots) ? (workspace.roots as unknown[]).map(String) : [];
    const config = (params.config ?? {}) as Record<string, ConfigValue>;
    const native = (params.nativeSession ?? null) as Record<string, unknown> | null;
    const nativeSessionId = native && typeof native.id === 'string' ? native.id : null;
    const history = native && native.history === 'replay' ? 'replay' as const : 'none' as const;
    const hostBindingProof = native && typeof native.hostBindingProof === 'string'
      ? native.hostBindingProof
      : null;
    const hostServices = Array.isArray(params.hostServices) ? params.hostServices : [];
    return {
      sessionId,
      workspace: { cwd, roots },
      config,
      nativeSessionId,
      history,
      hostBindingProof,
      hostServices,
    };
  }

  private async sessionCreate(params: Record<string, unknown>): Promise<unknown> {
    const parsed = this.sessionCreateParams(params);
    if (parsed.hostServices.length > 0) {
      throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'integration.mcp.streamableHttp is not declared.');
    }
    if (parsed.nativeSessionId !== null) {
      const key = this.options.hostBindingKey;
      const binding = {
        pluginId: PLUGIN_ID,
        sessionId: parsed.sessionId,
        nativeSessionId: parsed.nativeSessionId,
        cwd: parsed.workspace.cwd,
      };
      if (parsed.history !== 'none'
        || key === undefined
        || parsed.hostBindingProof === null
        || !verifyNativeSessionHostBinding(key, binding, parsed.hostBindingProof)) {
        throw new ServiceError(
          'RUNTIME_UNAVAILABLE',
          'DSH native session attach requires a valid Host ownership proof.',
        );
      }
    }
    this.validateConfigSnapshot(parsed.config, 'session');
    const createFp = createHash('sha256').update(canonicalJson({ ...parsed })).digest('hex');
    const alreadyAttached = this.service.hasSession(parsed.sessionId);
    const attached = this.service.attach({
      sessionId: parsed.sessionId,
      cwd: parsed.workspace.cwd,
      roots: parsed.workspace.roots,
      sessionConfig: parsed.config,
      nativeSessionId: parsed.nativeSessionId,
      createFingerprint: createFp,
    });
    if (alreadyAttached) return { session: this.snapshot(attached.id, attached.streamId) };
    try {
      const remote = await this.bridge.request('session.create', {
        sessionId: parsed.sessionId,
        workspace: { cwd: parsed.workspace.cwd, roots: parsed.workspace.roots },
        config: parsed.config,
        ...(parsed.nativeSessionId === null
          ? {}
          : {
            nativeSession: {
              id: parsed.nativeSessionId,
              history: 'none',
              hostBindingProof: parsed.hostBindingProof,
            },
          }),
      });
      attached.nativeSessionId = nativeIdFromBridge(remote) ?? attached.id;
    } catch (error) {
      this.service.discardAttachment(parsed.sessionId, createFp);
      throw error;
    }
    return { session: this.snapshot(attached.id, attached.streamId) };
  }

  private async sessionGet(params: Record<string, unknown>): Promise<unknown> {
    const session = this.service.requireSession(stringField(params, 'sessionId'));
    const remote = await this.bridge.request('session.get', { sessionId: session.id }).catch(() => null);
    return { session: this.snapshot(session.id, session.streamId, remote) };
  }

  private async turnStart(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const session = this.service.requireStream(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input as unknown[] : [];
    const config = (params.config ?? {}) as Record<string, ConfigValue>;
    this.validateConfigSnapshot(config, 'turn');

    const turnFingerprint = fingerprint({ input, config });
    const acceptedFingerprint = session.acceptedTurns.get(turnId);
    if (acceptedFingerprint !== undefined) {
      if (acceptedFingerprint !== turnFingerprint) {
        throw new ServiceError('CONFLICT', `Turn ${turnId} was reused with different params.`);
      }
      return { accepted: true, turnId };
    }
    if (session.activeTurn !== null || session.pendingGianTurns.length > 0 || session.state === 'running') {
      throw new ServiceError('SESSION_BUSY', `Session ${sessionId} already has an active turn.`);
    }
    session.acceptedTurns.set(turnId, turnFingerprint);

    this.notify('session.updated', {
      eventId: hashIdLocal(['session-updated', session.id, session.sequence + 1]),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence + 1,
      emittedAt: new Date().toISOString(),
      data: { state: 'running' as SessionStateName, updatedAt: new Date().toISOString() },
    });
    session.sequence += 1;
    session.state = 'running';
    this.service.prepareTurn(sessionId, turnId);

    try {
      const bridgeTurn = await this.bridge.request('turn.start', {
        sessionId,
        turnId,
        input: coerceInput(input),
        config,
      });
      return { accepted: true, turnId, ...(bridgeTurn && typeof bridgeTurn === 'object' ? {} : {}) };
    } catch (error) {
      session.acceptedTurns.delete(turnId);
      const pendingIndex = session.pendingGianTurns.lastIndexOf(turnId);
      if (pendingIndex >= 0) session.pendingGianTurns.splice(pendingIndex, 1);
      session.state = 'idle';
      session.updatedAt = new Date().toISOString();
      session.sequence += 1;
      this.notify('session.updated', {
        eventId: hashIdLocal(['session-updated', session.id, session.sequence]),
        sessionId: session.id,
        streamId: session.streamId,
        sequence: session.sequence,
        emittedAt: session.updatedAt,
        data: { state: 'idle', updatedAt: session.updatedAt },
      });
      throw error;
    }
  }

  private async turnInterrupt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    this.service.requireStream(sessionId, streamId);
    this.service.markInterruptAccepted(sessionId, turnId);
    await this.bridge.request('turn.interrupt', { sessionId, turnId });
    return { accepted: true, turnId };
  }

  private async turnSteer(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    this.service.requireStream(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input as unknown[] : [];
    await this.bridge.request('turn.steer', { sessionId, turnId, input: coerceInput(input) });
    return { accepted: true, turnId };
  }

  private async interactionRespond(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const interactionId = stringField(params, 'interactionId');
    const actionId = stringField(params, 'actionId');
    const values = (params.values ?? {}) as Record<string, unknown>;
    this.service.requireStream(sessionId, streamId);
    const bridgeResult = await this.bridge.request('interaction.respond', {
      sessionId,
      interactionId,
      actionId,
      values,
    });
    return { accepted: true, interactionId, responseId: params.responseId as string, ...bridgeResult };
  }

  private async sessionClose(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const session = this.service.requireStream(sessionId, streamId);
    await this.bridge.request('session.close', { sessionId });
    this.service.closeSession(sessionId, streamId);
    return { ok: true, ...(session ? {} : {}) };
  }

  private async sessionReplay(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const session = this.service.requireStream(sessionId, streamId);
    const cursor = params.cursor === null || params.cursor === undefined ? null : String(params.cursor);
    const limit = typeof params.limit === 'number' ? params.limit : 500;
    const page = await this.bridge.request('session.events.read', { sessionId, cursor, limit });
    const events = Array.isArray((page as { events?: unknown }).events)
      ? (page as { events: Array<{ type: string; data: Record<string, unknown>; seq: number }> }).events
      : [];
    const replayStreamId = `replay-${session.id}-${(page as { formatVersion?: unknown }).formatVersion ?? 0}`;
    const replayEvents = events.map((event) => this.replayEventFor(
      session.id,
      session.nativeSessionId ?? session.id,
      replayStreamId,
      event,
    ));
    return {
      replayStreamId,
      events: replayEvents,
      nextCursor: (page as { cursor?: unknown }).cursor ?? null,
    };
  }

  private replayEventFor(
    sessionId: string,
    nativeSessionId: string,
    replayStreamId: string,
    event: { type: string; data: Record<string, unknown>; seq: number },
  ): Record<string, unknown> {
    const turn = typeof event.data.turn === 'number' ? event.data.turn : 0;
    const step = typeof event.data.step === 'number' ? event.data.step : 0;
    const sourceId = `${nativeSessionId}:turn:${turn}`;
    const base = {
      method: replayMethod(event.type),
      eventId: hashIdLocal(['replay', PLUGIN_ID, nativeSessionId, event.type, event.seq, 0]),
      sessionId,
      replayStreamId,
      sequence: event.seq + 1,
      sourceTurnId: sourceId,
      emittedAt: new Date().toISOString(),
      data: {},
    };
    const data = replayData(event, sourceId, step);
    return { ...base, data };
  }

  private async shutdown(): Promise<unknown> {
    await this.bridge.request('shutdown', {});
    return { ok: true };
  }

  private snapshot(sessionId: string, streamId: string, _remote: Record<string, unknown> | null = null): Record<string, unknown> {
    const session = this.service.requireSession(sessionId);
    return {
      id: session.id,
      ...(session.nativeSessionId ? { nativeSession: { id: session.nativeSessionId } } : {}),
      streamId: session.streamId,
      state: session.state,
      sessionConfig: session.sessionConfig,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private validateConfigSnapshot(values: Record<string, ConfigValue>, binding: 'session' | 'turn'): void {
    const advertised = this.catalogState.configOptions;
    for (const [key, value] of Object.entries(values)) {
      const option = advertised.find((entry) => entry.id === key && entry.binding === binding);
      if (!option) {
        throw new ServiceError('CONFIG_VALUE_INVALID', `Unknown ${binding}-bound config option ${key}.`);
      }
      if (option.control === 'select') {
        const valid = option.choices?.some((choice) => Object.is(choice.value, value));
        if (!valid) throw new ServiceError('CONFIG_VALUE_INVALID', `Option ${key} value was not advertised.`);
      }
      if (option.control === 'boolean' && typeof value !== 'boolean') {
        throw new ServiceError('CONFIG_VALUE_INVALID', `Option ${key} must be boolean.`);
      }
      if (option.control === 'number' && typeof value !== 'number') {
        throw new ServiceError('CONFIG_VALUE_INVALID', `Option ${key} must be number.`);
      }
    }
    for (const option of advertised) {
      if (option.binding !== binding || option.required === false) continue;
      if (values[option.id] === undefined) {
        throw new ServiceError('CONFIG_REQUIRED', `Config option ${option.id} is required.`);
      }
    }
  }
}

function normalizeError(error: unknown): {
  code: number;
  message: string;
  data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
} {
  if (error instanceof ServiceError) {
    if (error.domainCode === 'METHOD_NOT_FOUND') {
      return { code: -32601, message: error.message };
    }
    return {
      code: -32000,
      message: error.message,
      data: { domainCode: error.domainCode, retryable: false, details: {} },
    };
  }
  if (error && typeof error === 'object' && (error as { domainCode?: unknown }).domainCode !== undefined) {
    const domainCode = String((error as { domainCode: unknown }).domainCode);
    return {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
      data: { domainCode, retryable: false, details: {} },
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `params.${key} must be a non-empty string.`);
  }
  return value;
}

function nativeIdFromBridge(remote: unknown): string | null {
  if (remote === null || typeof remote !== 'object') return null;
  const session = (remote as { session?: unknown }).session;
  if (session === null || typeof session !== 'object') return null;
  const nativeId = (session as { nativeId?: unknown }).nativeId;
  return typeof nativeId === 'string' && nativeId.length > 0 ? nativeId : null;
}

function coerceInput(input: unknown[]): Array<Record<string, unknown>> {
  return input.map((raw) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    return {
      type: record.type === 'text' ? 'text' : record.type === 'localFile' ? 'localFile'
        : record.type === 'localImage' ? 'localImage' : 'skill',
      ...(typeof record.text === 'string' ? { text: record.text } : {}),
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
      ...(typeof record.size === 'number' ? { size: record.size } : {}),
    };
  });
}

function hashIdLocal(parts: unknown[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex').slice(0, 32);
}

function replayMethod(type: string): string {
  switch (type) {
    case 'turn/start': return 'turn.started';
    case 'turn/end': return 'turn.completed';
    case 'step/start': return 'step.updated';
    case 'step/end': return 'step.updated';
    case 'assistant/chunk': return 'content.delta';
    case 'assistant/message': return 'content.completed';
    case 'tool/call': return 'activity.updated';
    case 'tool/result': return 'activity.updated';
    case 'user/message': return 'input.recorded';
    case 'request/header': return 'request.updated';
    case 'request/context': return 'request.updated';
    default: return 'activity.updated';
  }
}

function replayData(
  event: { type: string; data: Record<string, unknown> },
  sourceId: string,
  step: number,
): Record<string, unknown> {
  const data = event.data;
  switch (event.type) {
    case 'turn/start':
      return {};
    case 'turn/end':
      return { stopReason: 'completed' };
    case 'step/start':
      return { stepId: `${sourceId}:step:${step}`, index: step, status: 'running' };
    case 'step/end':
      return { stepId: `${sourceId}:step:${step}`, index: step, status: 'completed' };
    case 'assistant/chunk':
      return { contentId: 'assistant', kind: 'text', delta: '' };
    case 'assistant/message':
      return { contentId: 'assistant', kind: 'text', content: '' };
    case 'user/message':
      return { input: [{ type: 'text', text: '' }] };
    case 'request/header':
      return { requestId: `request-${sourceId}:step:${step}`, reason: 'initial' };
    case 'request/context': {
      const contextWindow = typeof data.contextWindow === 'number'
        ? data.contextWindow
        : undefined;
      return {
        requestId: `request-${sourceId}`,
        reason: 'change',
        ...(contextWindow === undefined ? {} : { context: { window: contextWindow } }),
      };
    }
    default:
      return { activityId: `activity-${event.type}`, kind: event.type, title: event.type, status: 'succeeded', presentation: { type: 'generic' } };
  }
}

export const DSH_CAPABILITIES = CAPABILITIES;
