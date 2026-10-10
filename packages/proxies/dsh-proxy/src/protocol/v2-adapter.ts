/**
 * gian.proxy/2.1 adapter for ai.deepseek.harness.
 *
 * The adapter owns the outer wire contract: initialize identity, capability
 * narrowing, catalog projection from bridge facts, session/turn request
 * validation and idempotency, and the two-phase response-before-notification
 * queue.
 */

import { createHash } from 'node:crypto';
import {
  OpaqueSidechatResumeStore,
  verifyNativeSessionHostBinding,
  type SidechatAnchor,
} from '@gian/proxy-protocol';
import {
  PLUGIN_ID,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  DshProxyService,
  ServiceError,
  diffStatusFor,
  diffsFromMeta,
  hashId,
  todoStatusFor,
  unifiedDiff,
  type AttachedSession,
  type ConfigValue,
  type SessionStateName,
} from '../core/service.js';
import { discoverDshRuntimes, probeDshRuntime } from '../runtime/discover.js';
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

function customizationUnsupportedList(kind: string, status: 'proxy_unsupported' | 'provider_unsupported' | 'unavailable') {
  return {
    kind,
    status,
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics: [],
  };
}

function customizationUnavailableDetail(kind: string, id: string, message: string) {
  return {
    kind,
    id,
    status: 'unavailable',
    observedAt: new Date().toISOString(),
    text: '',
    truncated: false,
    diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message }],
  };
}

const BASE_CAPABILITIES: Record<string, number> = {
  'catalog.resolve': 1,
  'session.replay': 1,
  'session.create.hostBindingProof': 1,
  'event.reasoning': 1,
  'event.usage': 1,
  'event.step': 1,
  'event.request': 1,
};

/**
 * Bridge capability key → Gian capability names it earns. The mapping only
 * runs for capabilities the connected bridge actually advertised, so the
 * wire capabilities always sit on verified native boundaries.
 */
const BRIDGE_CAPABILITY_MAP: Record<string, string[]> = {
  'turn.steer': ['turn.steer'],
  'input.attachments': ['input.localFile', 'input.localImage'],
  'input.skill': ['input.skill'],
  'session.fork': ['session.fork', 'session.fork.atTurn', 'sidechat'],
  'session.native.list': ['session.native.list'],
};

/**
 * One open Side Chat route. The transient conversation itself lives as an
 * attached session keyed by the sidechatId; this record only carries the
 * parent binding, the sealed resume reference, and the creation anchor.
 */
interface SidechatRecord {
  parentSessionId: string;
  resumeRefId: string;
  anchor: SidechatAnchor;
  createFingerprint: string;
  /** Set on resume so a retried identical resume replays the first result. */
  resumeFingerprint?: string;
}

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

const CATALOG_INPUT_TYPES = new Set(['text', 'localFile', 'localImage', 'skill']);

export class DshV2Adapter {
  private initialized = false;
  private protocolVersion: '2.1' | '2.2' | '2.3' = '2.1';
  private capabilities: Record<string, number> = { ...BASE_CAPABILITIES };
  private readonly service: DshProxyService;
  private catalogState: CatalogState = {
    catalogRevision: `dsh-catalog-${PLUGIN_VERSION}-bootstrap`,
    configOptions: this.defaultConfigOptions(),
  };
  private catalogInput: Array<{ type: string }> = [{ type: 'text' }];
  private queue: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  /** responseId → settled interaction identity for idempotent/conflict replies. */
  private readonly interactionResponses = new Map<string, {
    interactionId: string;
    actionId: string;
    fingerprint: string;
  }>();
  /** turnId → last steer fingerprint for retry-idempotent steering. */
  private readonly steerFingerprints = new Map<string, string>();
  /** sidechatId → parent binding / sealed resumeRef / anchor. */
  private readonly sidechats = new Map<string, SidechatRecord>();
  /**
   * Seals Provider-owned recovery data into opaque resumeRefs and persists
   * hashed close tombstones (GIAN_PLUGIN_DATA_DIR). The ref is never logged
   * and only travels inside sidechat results.
   */
  private readonly resumeStore = new OpaqueSidechatResumeStore();

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
    // A shared-Host crash must terminalize every open turn and pending
    // interaction instead of leaving the Host waiting on events that can no
    // longer arrive.
    if (typeof this.bridge.onExit === 'function') {
      this.bridge.onExit(() => {
        this.service.handleRuntimeExited();
      });
    }
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
        if (this.capabilities['turn.steer'] === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'turn.steer is not advertised for DSH.');
        }
        return this.turnSteer(params);
      case 'interaction.respond':
        if (this.capabilities.interaction === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'interaction is not advertised for DSH.');
        }
        return this.interactionRespond(params);
      case 'session.close':
        return this.sessionClose(params);
      case 'session.replay':
        return this.sessionReplay(params);
      case 'session.native.list':
        if (this.capabilities['session.native.list'] === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.native.list is not advertised for DSH.');
        }
        return this.bridge.request('session.native.list', {
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
        });
      case 'session.native.delete':
        // Re-checked in @deepseek-ai/dsh@0.2.0-rc.2: persistence is still
        // create/open/flush/stat/list, so there is no durable-history deletion.
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.native.delete is not advertised for DSH.');
      case 'session.rename':
        // SessionHeader still has no title. SessionTitleService.rename exists
        // in 0.2.0-rc.2 and is not connected in this migration.
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.rename is not advertised for DSH.');
      case 'session.fork':
        if (this.capabilities['session.fork'] === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'session.fork is not advertised for DSH.');
        }
        return this.sessionFork(params);
      case 'sidechat.create':
        if (this.capabilities.sidechat === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'sidechat is not advertised for DSH.');
        }
        return this.createSidechat(params);
      case 'sidechat.resume':
        if (this.capabilities.sidechat === undefined) {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'sidechat is not advertised for DSH.');
        }
        return this.resumeSidechat(params);
      case 'sidechat.close':
        return this.closeSidechat(params);
      case 'runtime.discover':
        if (this.protocolVersion === '2.1') {
          throw new ServiceError('METHOD_NOT_FOUND', 'runtime.discover requires gian.proxy/2.2.');
        }
        return discoverDshRuntimes();
      case 'runtime.probe':
        if (this.protocolVersion === '2.1') {
          throw new ServiceError('METHOD_NOT_FOUND', 'runtime.probe requires gian.proxy/2.2.');
        }
        return probeDshRuntime(String(params.path ?? ''));
      case 'customization.list':
      case 'customization.detail':
        if (this.protocolVersion !== '2.3') {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', `${request.method} requires gian.proxy/2.3.`);
        }
        return this.customization(request.method, request.params);
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
    const selected = versions.includes('2.3')
      ? '2.3'
      : versions.includes('2.2')
        ? '2.2'
        : versions.includes('2.1')
          ? '2.1'
          : null;
    if (selected === null) {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.1, 2.2, or 2.3 is required.');
    }
    this.protocolVersion = selected;
    if (selected === '2.1' || process.env.GIAN_RUNTIME_BIN) {
      const bridgeInitialized = await this.bridge.request(
        'initialize',
        { protocol: { versions: ['1.0'] } },
      );
      const bridgeCapabilities = bridgeInitialized.capabilities !== null
        && typeof bridgeInitialized.capabilities === 'object'
        && !Array.isArray(bridgeInitialized.capabilities)
        ? bridgeInitialized.capabilities as Record<string, unknown>
        : {};
      const runtimeCapabilities: Record<string, number> = {};
      for (const [bridgeKey, gianNames] of Object.entries(BRIDGE_CAPABILITY_MAP)) {
        if (bridgeCapabilities[bridgeKey] === undefined) continue;
        for (const name of gianNames) runtimeCapabilities[name] = 1;
      }
      // Structured native projections (todo/write → plan.updated,
      // tool/result meta → diff.updated) exist on DSH session format 4.
      // Older formats, including 3, stay unadvertised.
      const bridgeRuntime = bridgeInitialized.runtime !== null
        && typeof bridgeInitialized.runtime === 'object'
        ? bridgeInitialized.runtime as { sessionFormatVersion?: unknown }
        : {};
      const structuredEvents = bridgeRuntime.sessionFormatVersion === 4
        ? { 'event.plan': 1, 'event.diff': 1 }
        : {};
      this.capabilities = {
        ...BASE_CAPABILITIES,
        ...structuredEvents,
        ...runtimeCapabilities,
        ...(bridgeCapabilities.interaction === undefined ? {} : { interaction: 1 }),
        ...(selected === '2.1'
          ? {}
          : { 'runtime.discover': 1, 'runtime.probe': 1 }),
        ...(selected === '2.3' ? { 'customization.list': 1 } : {}),
      };
      const catalog = await this.bridge.request('catalog.list', {});
      this.catalogState = {
        catalogRevision: this.catalogRevisionFrom(catalog),
        configOptions: this.catalogOptionsFrom(catalog),
      };
      this.catalogInput = this.catalogInputFrom(catalog);
    } else {
      this.capabilities = {
        ...BASE_CAPABILITIES,
        'runtime.discover': 1,
        'runtime.probe': 1,
        ...(selected === '2.3' ? { 'customization.list': 1 } : {}),
      };
    }
    this.initialized = true;
    return {
      protocol: { name: 'gian.proxy', version: selected },
      plugin: { id: PLUGIN_ID, name: PLUGIN_NAME, version: this.options.pluginVersion ?? PLUGIN_VERSION },
      process: { scope: 'shared' },
      capabilities: this.capabilities,
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
      providerOption.choices = providers
        .filter(provider => models.some(model => String(model.provider) === String(provider.id)))
        .map(provider => ({
          value: String(provider.id),
          displayName: String(provider.label ?? provider.name ?? provider.id),
        }));
      if (providerOption.choices.length === 0) {
        throw new ServiceError('RUNTIME_UNAVAILABLE', 'DSH exposes no Provider with a selectable model.');
      }
      if (selectedProvider !== undefined
        && !providerOption.choices.some(choice => choice.value === selectedProvider)) {
        throw new ServiceError('CONFIG_VALUE_INVALID', `Provider ${selectedProvider} was not advertised.`);
      }
      const candidateProvider = selectedProvider
        ?? (typeof defaults.provider === 'string' ? defaults.provider : undefined)
        ?? providerOption.choices[0]?.value;
      const defaultProvider = providerOption.choices.some(choice => choice.value === candidateProvider)
        ? candidateProvider
        : providerOption.choices[0]?.value;
      if (defaultProvider !== undefined) providerOption.defaultValue = defaultProvider;
    }
    const effectiveProvider = String(providerOption?.defaultValue ?? selectedProvider ?? '');
    const providerModels = models.filter(model => model.provider === effectiveProvider);
    const visibleModels = providerModels;
    if (visibleModels.length > 0) {
      const modelOption = base.find(option => option.id === 'model');
      if (modelOption) {
        const requestedModel = visibleModels.some(model => model.id === selectedModel)
          ? selectedModel
          : undefined;
        const advertisedDefault = defaults.provider === effectiveProvider
          && typeof defaults.model === 'string'
          && visibleModels.some(model => model.id === defaults.model)
          ? defaults.model
          : undefined;
        const defaultModel = requestedModel ?? advertisedDefault ?? visibleModels[0]?.id;
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
    const effectiveModel = String(base.find(option => option.id === 'model')?.defaultValue ?? '');
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
        const configuredEffort = typeof reasoning?.defaultEffort === 'string'
          ? reasoning.defaultEffort
          : undefined;
        const defaultEffort = effortOption.choices.some(choice => choice.value === configuredEffort)
          ? configuredEffort
          : effortOption.choices[0]?.value;
        if (defaultEffort !== undefined) effortOption.defaultValue = defaultEffort;
      }
    } else {
      const effortIndex = base.findIndex(option => option.id === 'effort');
      if (effortIndex >= 0) base.splice(effortIndex, 1);
    }
    const permissionPresets = Array.isArray(catalog.permissionPresets)
      ? catalog.permissionPresets as unknown[]
      : [];
    const permissionChoices = permissionPresets.flatMap(choice => {
      const record = choice !== null && typeof choice === 'object'
        ? choice as Record<string, unknown>
        : null;
      const id = String(record?.id ?? choice);
      if (record?.approvalPolicy === 'ask' && this.capabilities.interaction === undefined) return [];
      return [{
        value: id,
        displayName: String(record?.label ?? record?.name ?? id),
        ...(typeof record?.description === 'string'
          ? { description: record.description }
          : {}),
      }];
    });
    const configuredPermissionDefault = typeof catalog.defaultPermissionPreset === 'string'
      ? catalog.defaultPermissionPreset
      : undefined;
    if (permissionChoices.some(choice => choice.value === configuredPermissionDefault)) {
      base.push({
        id: 'permission_preset',
        displayName: 'Permission',
        description: 'DSH sandbox and approval behavior for the next turn.',
        binding: 'turn',
        control: 'select',
        required: false,
        defaultValue: configuredPermissionDefault!,
        choices: permissionChoices,
      });
    }
    const presets = Array.isArray(catalog.agentPresets)
      ? catalog.agentPresets as unknown[]
      : [];
    const presetChoices = presets.flatMap(choice => {
      const record = choice !== null && typeof choice === 'object'
        ? choice as Record<string, unknown>
        : null;
      if (typeof record?.broken === 'string') return [];
      const id = String(record?.id ?? choice);
      return [{
        value: id,
        displayName: String(record?.label ?? record?.name ?? id),
        ...(typeof record?.description === 'string'
          ? { description: record.description }
          : {}),
      }];
    });
    if (presetChoices.length > 0) {
      const configuredDefault = typeof catalog.defaultAgentPreset === 'string'
        ? catalog.defaultAgentPreset
        : undefined;
      base.unshift({
        id: 'agent_preset',
        displayName: 'Agent preset',
        description: 'DSH capability composition fixed when the Session is created.',
        binding: 'session',
        control: 'select',
        required: false,
        defaultValue: presetChoices.some(choice => choice.value === configuredDefault)
          ? configuredDefault!
          : presetChoices[0]!.value,
        choices: presetChoices,
      });
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

  /** Project the bridge's runtime-truth input descriptors onto the wire. */
  private catalogInputFrom(catalog: Record<string, unknown>): Array<{ type: string }> {
    const raw = Array.isArray(catalog.input) ? catalog.input as unknown[] : [];
    const projected = raw
      .map(entry => (entry !== null && typeof entry === 'object' ? (entry as { type?: unknown }).type : entry))
      .filter((type): type is string => typeof type === 'string' && CATALOG_INPUT_TYPES.has(type));
    const unique = [...new Set(projected)];
    return unique.length > 0 ? unique.map(type => ({ type })) : [{ type: 'text' }];
  }

  private async catalogList(): Promise<unknown> {
    const native = await this.bridge.request('catalog.list', {});
    this.catalogState = {
      catalogRevision: this.catalogRevisionFrom(native),
      configOptions: this.catalogOptionsFrom(native),
    };
    this.catalogInput = this.catalogInputFrom(native);
    return this.catalog();
  }

  private catalog(
    configOptions = this.catalogState.configOptions,
    catalogRevision = this.catalogState.catalogRevision,
  ): unknown {
    const hasThinking = configOptions.some(option => option.id === 'effort');
    const hasApproval = configOptions.some(option => option.id === 'permission_preset');
    return {
      catalogRevision,
      input: this.catalogInput,
      configOptions,
      specialCatalogs: {
        model: 'model',
        ...(hasThinking ? { thinking: 'effort' } : {}),
        ...(hasApproval ? { approvalMode: 'permission_preset' } : {}),
      },
      actions: [
        {
          id: 'sidechat.create',
          supported: this.capabilities.sidechat !== undefined,
          ...(this.capabilities.sidechat === undefined
            ? { reason: 'Requires the native fork surface.' }
            : {}),
        },
        { id: 'session.fork', supported: this.capabilities['session.fork'] !== undefined },
        {
          id: 'session.fork.atTurn',
          supported: this.capabilities['session.fork.atTurn'] !== undefined,
          ...(this.capabilities['session.fork.atTurn'] === undefined
            ? { reason: 'Requires the native fork boundary.' }
            : {}),
        },
      ],
      slashCommands: [],
    };
  }

  private async catalogResolve(params: Record<string, unknown>): Promise<unknown> {
    const sessionConfig = (params.sessionConfig ?? {}) as Record<string, ConfigValue>;
    const turnConfig = (params.turnConfig ?? {}) as Record<string, ConfigValue>;
    const bridgeResolved = await this.bridge.request('catalog.resolve', params);
    const selectedModel = typeof turnConfig.model === 'string' ? turnConfig.model : undefined;
    const selectedProvider = typeof turnConfig.provider === 'string' ? turnConfig.provider : undefined;
    const options = this.catalogOptionsFrom(bridgeResolved, selectedModel, selectedProvider);
    const catalogRevision = this.catalogRevisionFrom(bridgeResolved);
    const resolvedSessionConfig = this.resolveConfigValues(options, 'session', sessionConfig, false);
    const resolvedTurnConfig = this.resolveConfigValues(options, 'turn', turnConfig, true);
    const resolvedDefaults = {
      sessionConfig: resolvedSessionConfig,
      turnConfig: resolvedTurnConfig,
    };
    this.catalogInput = this.catalogInputFrom(bridgeResolved);
    const base = this.catalog(options, catalogRevision) as Record<string, unknown>;
    return { ...base, resolvedDefaults };
  }

  private resolveConfigValues(
    options: ConfigOption[],
    binding: 'session' | 'turn',
    values: Record<string, ConfigValue>,
    allowDependentFallback: boolean,
  ): Record<string, ConfigValue> {
    for (const key of Object.keys(values)) {
      if (!options.some(option => option.id === key && option.binding === binding)) {
        throw new ServiceError('CONFIG_VALUE_INVALID', `Unknown ${binding}-bound config option ${key}.`);
      }
    }
    const resolved: Record<string, ConfigValue> = {};
    for (const option of options) {
      if (option.binding !== binding) continue;
      const provided = values[option.id];
      const valid = provided !== undefined && (
        (option.control === 'select'
          && option.choices?.some(choice => Object.is(choice.value, provided)) === true)
        || (option.control === 'boolean' && typeof provided === 'boolean')
        || (option.control === 'number' && typeof provided === 'number')
        || (option.control === 'text' && typeof provided === 'string')
      );
      if (provided !== undefined && !valid) {
        const dependencyFallback = allowDependentFallback
          && (option.id === 'model' || option.id === 'effort');
        if (!dependencyFallback) {
          throw new ServiceError('CONFIG_VALUE_INVALID', `Option ${option.id} value was not advertised.`);
        }
      }
      const value = valid ? provided : option.defaultValue;
      if (value !== undefined && value !== null && value !== '') resolved[option.id] = value;
      else if (option.required) {
        throw new ServiceError('CONFIG_REQUIRED', `Config option ${option.id} is required.`);
      }
    }
    return resolved;
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
    // An ordinary session.create must never adopt or revive a Side Chat route.
    if (this.sidechats.has(parsed.sessionId)) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${parsed.sessionId} is not attached.`);
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
    // Ownership proof authenticates this request, but is not immutable session
    // configuration. The first attach acquires its native id from the bridge.
    const { nativeSessionId: _nativeId, hostBindingProof: _proof, history: _history, ...identity } = parsed;
    const createFp = createHash('sha256').update(canonicalJson(identity)).digest('hex');
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
    const session = this.requireOrdinarySession(stringField(params, 'sessionId'));
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
    const resolvedCatalog = await this.bridge.request('catalog.resolve', {
      catalogRevision: this.catalogState.catalogRevision,
      sessionConfig: session.sessionConfig,
      turnConfig: config,
    });
    const resolvedOptions = this.catalogOptionsFrom(
      resolvedCatalog,
      typeof config.model === 'string' ? config.model : undefined,
      typeof config.provider === 'string' ? config.provider : undefined,
    );
    const retired = this.retiredTurnConfig(config, resolvedOptions);
    this.validateConfigSnapshot(retired.config, 'turn', resolvedOptions);
    session.acceptedTurns.set(turnId, turnFingerprint);
    if (retired.retiredModel !== null && retired.fallbackModel !== null) {
      session.pendingModelReselect = {
        turnId,
        retiredModel: retired.retiredModel,
        fallbackModel: retired.fallbackModel,
      };
    }

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
        config: retired.config,
      });
      return { accepted: true, turnId, ...(bridgeTurn && typeof bridgeTurn === 'object' ? {} : {}) };
    } catch (error) {
      // Native terminal evidence can arrive before the start RPC settles.
      // Keep its accepted receipt: retrying must never execute the Turn twice
      // or turn an already completed result into a transport failure.
      if ([...session.turnState.values()].some(turn => turn.gianTurnId === turnId && turn.terminal)) {
        return { accepted: true, turnId };
      }
      if (session.pendingModelReselect?.turnId === turnId) session.pendingModelReselect = null;
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
    const session = this.service.requireStream(sessionId, streamId);
    // Steering is a mid-turn primitive: it only applies to the session's
    // current active turn. Queueing for a later turn is turn.start's job and
    // is never silently substituted here.
    if (session.activeTurn !== turnId) {
      throw new ServiceError(
        'TURN_NOT_FOUND',
        session.activeTurn === null
          ? `Session ${sessionId} has no active turn to steer.`
          : `Turn ${turnId} is not the active turn of session ${sessionId}.`,
      );
    }
    const input = Array.isArray(params.input) ? params.input as unknown[] : [];
    // A retried identical steer is idempotent (no second native delivery);
    // different content on the same open turn is a deliberate new steer.
    const fingerprint = createHash('sha256').update(canonicalJson({ input })).digest('hex');
    const key = `${sessionId}:${turnId}`;
    if (this.steerFingerprints.get(key) === fingerprint) {
      return { accepted: true, turnId };
    }
    await this.bridge.request('turn.steer', { sessionId, turnId, input: coerceInput(input) });
    this.steerFingerprints.set(key, fingerprint);
    return { accepted: true, turnId };
  }

  private async interactionRespond(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const interactionId = stringField(params, 'interactionId');
    const actionId = stringField(params, 'actionId');
    const responseId = stringField(params, 'responseId');
    const values = (params.values ?? {}) as Record<string, unknown>;
    this.service.requireStream(sessionId, streamId);
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ actionId, values }))
      .digest('hex');
    const previous = this.interactionResponses.get(responseId);
    if (previous !== undefined) {
      if (previous.interactionId !== interactionId
        || previous.actionId !== actionId
        || previous.fingerprint !== fingerprint) {
        throw new ServiceError(
          'CONFLICT',
          `Response id ${responseId} was already used with a different answer.`,
        );
      }
      // Retried identical response: the first delivery settled the native
      // interaction; the retry is acknowledged without a second delivery.
      return { accepted: true, interactionId, responseId };
    }
    const bridgeResult = await this.bridge.request('interaction.respond', {
      sessionId,
      interactionId,
      actionId,
      values,
    });
    this.interactionResponses.set(responseId, { interactionId, actionId, fingerprint });
    return { accepted: true, interactionId, responseId, ...bridgeResult };
  }

  /**
   * Native fork through the DSH agent factory: the child carries the parent's
   * balanced completed-turn prefix as its durable seed, native
   * `parentSession`/`isSeeded` lineage, and a fresh live agent. The parent
   * record is only read.
   */
  private async sessionFork(params: Record<string, unknown>): Promise<unknown> {
    const sourceSessionId = stringField(params, 'sourceSessionId');
    const sourceStreamId = stringField(params, 'sourceStreamId');
    const newSessionId = stringField(params, 'sessionId');
    // A Side Chat is a one-off context snapshot and can never seed a
    // persistent fork (10.5.1).
    const source = this.requireOrdinaryStream(sourceSessionId, sourceStreamId);
    const anchor = (params.anchor ?? {}) as Record<string, unknown>;
    const sourceNativeId = source.nativeSessionId ?? sourceSessionId;
    let bridgeAnchor: { kind: 'head' } | { kind: 'turn'; nativeTurn: number };
    let anchorTurnId: string;
    let anchorSourceTurnId: string;
    if (anchor.type === 'head') {
      const latest = this.latestCompletedTurn(source);
      if (latest === null) {
        throw new ServiceError(
          'FORK_BOUNDARY_UNAVAILABLE',
          'A head fork requires at least one completed native turn to anchor on.',
        );
      }
      bridgeAnchor = { kind: 'head' };
      anchorTurnId = latest.turnId;
      anchorSourceTurnId = latest.sourceTurnId;
    } else if (anchor.type === 'turn') {
      const anchorTurnIdParam = typeof anchor.turnId === 'string' ? anchor.turnId : '';
      const anchorSourceTurnIdParam = typeof anchor.sourceTurnId === 'string' ? anchor.sourceTurnId : '';
      const nativeTurn = nativeTurnFromSourceId(anchorSourceTurnIdParam, sourceNativeId);
      if (anchorTurnIdParam.length === 0 || nativeTurn === null) {
        throw new ServiceError(
          'FORK_BOUNDARY_UNAVAILABLE',
          `Anchor sourceTurnId ${anchorSourceTurnIdParam} does not resolve to a native turn of session ${sourceSessionId}.`,
        );
      }
      bridgeAnchor = { kind: 'turn', nativeTurn };
      anchorTurnId = anchorTurnIdParam;
      anchorSourceTurnId = anchorSourceTurnIdParam;
    } else {
      throw new ServiceError('INVALID_PARAMS', 'params.anchor.type must be "head" or "turn".');
    }
    const forked = await this.bridge.request('session.fork', {
      sessionId: sourceSessionId,
      newSessionId,
      anchor: bridgeAnchor,
    });
    const session = (forked.session ?? null) as Record<string, unknown> | null;
    const nativeId = session !== null && typeof session.nativeId === 'string' ? session.nativeId : null;
    const cwd = session !== null && typeof session.cwd === 'string' ? session.cwd : source.cwd;
    const roots = session !== null && Array.isArray(session.roots)
      ? (session.roots as unknown[]).map(String)
      : source.roots;
    const createdAt = session !== null && typeof session.createdAt === 'string'
      ? session.createdAt
      : new Date().toISOString();
    const attached = this.service.attach({
      sessionId: newSessionId,
      cwd,
      roots,
      sessionConfig: source.sessionConfig,
      nativeSessionId: nativeId,
      createFingerprint: createHash('sha256')
        .update(canonicalJson({ forkOf: sourceSessionId, newSessionId, anchor: bridgeAnchor }))
        .digest('hex'),
    });
    if (nativeId !== null) attached.nativeSessionId = nativeId;
    attached.createdAt = createdAt;
    attached.updatedAt = createdAt;
    return {
      session: this.snapshot(newSessionId, attached.streamId),
      origin: {
        kind: 'fork',
        sessionId: sourceSessionId,
        turnId: anchorTurnId,
        sourceTurnId: anchorSourceTurnId,
      },
    };
  }

  private latestCompletedTurn(
    session: { turnState: Map<string, { terminal: boolean; gianTurnId: string; sourceTurnId: string }> },
  ): { turnId: string; sourceTurnId: string } | null {
    let latest: { turnId: string; sourceTurnId: string } | null = null;
    for (const turn of session.turnState.values()) {
      if (turn.terminal) latest = { turnId: turn.gianTurnId, sourceTurnId: turn.sourceTurnId };
    }
    return latest;
  }

  /* ------------------------------- Side Chat ------------------------------- */

  /**
   * Ordinary-session lookup: Side Chat routes stay invisible to every core
   * Session Method; a sidechatId must answer SESSION_NOT_FOUND (10.5.1).
   */
  private requireOrdinarySession(sessionId: string) {
    if (this.sidechats.has(sessionId)) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    return this.service.requireSession(sessionId);
  }

  private requireOrdinaryStream(sessionId: string, streamId: string) {
    const session = this.requireOrdinarySession(sessionId);
    if (session.streamId !== streamId) {
      throw new ServiceError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return session;
  }

  /**
   * The Side Chat context boundary follows ADR-0041's idle-only rule: DSH's
   * native fork only certifies completed-turn cuts, so creation requires an
   * idle parent and anchors on its latest terminal turn (empty when the
   * parent never accepted a turn). The activeInput anchor is unavailable
   * until DSH proves a live-turn boundary.
   */
  private sidechatAnchorFor(parent: AttachedSession): {
    anchor: SidechatAnchor;
    bridgeAnchor: { kind: 'head' } | { kind: 'turn'; nativeTurn: number };
  } {
    if (parent.activeTurn !== null || parent.pendingGianTurns.length > 0 || parent.state === 'running') {
      throw new ServiceError('SESSION_BUSY', 'Side Chat requires an idle parent Session.');
    }
    const latest = this.latestCompletedTurn(parent);
    if (latest) {
      const nativeTurn = nativeTurnFromSourceId(latest.sourceTurnId, parent.nativeSessionId ?? parent.id);
      if (nativeTurn === null) {
        throw new ServiceError(
          'FORK_BOUNDARY_UNAVAILABLE',
          `Side Chat anchor ${latest.sourceTurnId} does not resolve to a native turn.`,
        );
      }
      return {
        anchor: { type: 'turn', turnId: latest.turnId, sourceTurnId: latest.sourceTurnId },
        bridgeAnchor: { kind: 'turn', nativeTurn },
      };
    }
    return { anchor: { type: 'empty' }, bridgeAnchor: { kind: 'head' } };
  }

  private async createSidechat(params: Record<string, unknown>): Promise<unknown> {
    const parentSessionId = stringField(params, 'parentSessionId');
    const parentStreamId = stringField(params, 'parentStreamId');
    const sidechatId = stringField(params, 'sidechatId');
    const parent = this.requireOrdinaryStream(parentSessionId, parentStreamId);
    const fingerprint = JSON.stringify({ parentSessionId, parentStreamId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw new ServiceError('CONFLICT', `Side Chat ${sidechatId} was reused with a different parent.`);
      }
      return { sidechat: this.serializeSidechat(this.service.requireSession(sidechatId), existing) };
    }
    if (this.service.hasSession(sidechatId)) {
      throw new ServiceError('CONFLICT', `Side Chat ${sidechatId} already belongs to an ordinary Session.`);
    }
    const { anchor, bridgeAnchor } = this.sidechatAnchorFor(parent);
    const forked = await this.bridge.request('session.fork', {
      sessionId: parentSessionId,
      newSessionId: sidechatId,
      anchor: bridgeAnchor,
    });
    const session = (forked.session ?? null) as Record<string, unknown> | null;
    const nativeId = session !== null && typeof session.nativeId === 'string' ? session.nativeId : null;
    const attached = this.service.attach({
      sessionId: sidechatId,
      cwd: nonEmptyOrDefault(session !== null ? session.cwd : undefined, parent.cwd),
      roots: session !== null && Array.isArray(session.roots)
        ? (session.roots as unknown[]).map(String)
        : parent.roots,
      // sidechat.create carries no config: the Session-bound config is
      // inherited verbatim from the parent (10.5.1).
      sessionConfig: parent.sessionConfig,
      nativeSessionId: nativeId,
      createFingerprint: createHash('sha256')
        .update(canonicalJson({ sidechat: sidechatId, parent: fingerprint }))
        .digest('hex'),
    });
    if (nativeId !== null) attached.nativeSessionId = nativeId;
    const sealed = this.resumeStore.seal({
      sidechatId,
      parentSessionId,
      nativeSessionId: attached.nativeSessionId ?? sidechatId,
      anchor,
      sessionConfig: parent.sessionConfig,
      createdAt: attached.createdAt,
    });
    const record: SidechatRecord = {
      parentSessionId,
      resumeRefId: sealed.id,
      anchor,
      createFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, record);
    return { sidechat: this.serializeSidechat(attached, record) };
  }

  private async resumeSidechat(params: Record<string, unknown>): Promise<unknown> {
    const sidechatId = stringField(params, 'sidechatId');
    const parentSessionId = stringField(params, 'parentSessionId');
    const resumeRef = (params.resumeRef ?? null) as Record<string, unknown> | null;
    const resumeRefId = resumeRef !== null && typeof resumeRef.id === 'string' ? resumeRef.id : '';
    if (resumeRefId.length === 0) {
      throw new ServiceError('INVALID_PARAMS', 'params.resumeRef.id must be a non-empty string.');
    }
    if (this.resumeStore.closed(resumeRefId)) {
      throw new ServiceError('SIDECHAT_UNAVAILABLE', 'Side Chat was already closed.');
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (!payload) {
      throw new ServiceError('SIDECHAT_UNAVAILABLE', 'Side Chat resume reference is unavailable.');
    }
    if (payload.sidechatId !== sidechatId || payload.parentSessionId !== parentSessionId) {
      throw new ServiceError('CONFLICT', 'Side Chat resume identity does not match.');
    }
    const parent = this.requireOrdinarySession(parentSessionId);
    const fingerprint = JSON.stringify({ parentSessionId, resumeRefId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.resumeFingerprint !== fingerprint) {
        throw new ServiceError('CONFLICT', `Side Chat ${sidechatId} is attached with another resume reference.`);
      }
      return { sidechat: this.serializeSidechat(this.service.requireSession(sidechatId), existing, payload.createdAt) };
    }
    if (this.service.hasSession(sidechatId)) {
      throw new ServiceError('CONFLICT', `Side Chat ${sidechatId} already belongs to an ordinary Session.`);
    }
    const resumed = await this.bridge.request('session.resume', {
      sessionId: sidechatId,
      nativeSessionId: payload.nativeSessionId,
    });
    const session = (resumed.session ?? null) as Record<string, unknown> | null;
    const nativeId = session !== null && typeof session.nativeId === 'string' ? session.nativeId : null;
    const attached = this.service.attach({
      sessionId: sidechatId,
      cwd: nonEmptyOrDefault(session !== null ? session.cwd : undefined, parent.cwd),
      roots: session !== null && Array.isArray(session.roots)
        ? (session.roots as unknown[]).map(String)
        : parent.roots,
      sessionConfig: payload.sessionConfig,
      nativeSessionId: nativeId ?? payload.nativeSessionId,
      createFingerprint: createHash('sha256')
        .update(canonicalJson({ sidechatResume: sidechatId, resumeRefId }))
        .digest('hex'),
    });
    if (nativeId !== null) attached.nativeSessionId = nativeId;
    const record: SidechatRecord = {
      parentSessionId,
      resumeRefId,
      anchor: payload.anchor,
      createFingerprint: fingerprint,
      resumeFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, record);
    return { sidechat: this.serializeSidechat(attached, record, payload.createdAt) };
  }

  /**
   * Close barrier (10.5.4): terminalize the active turn and every open child
   * lifecycle BEFORE the Success response (the CLI writes the queued events
   * first for this method), keep the Provider session intact — DSH's
   * persistence contract has no delete, so providerDataDeleted stays false —
   * and converge unknown references idempotently.
   */
  private async closeSidechat(params: Record<string, unknown>): Promise<unknown> {
    const sidechatId = stringField(params, 'sidechatId');
    const resumeRef = (params.resumeRef ?? null) as Record<string, unknown> | null;
    const resumeRefId = resumeRef !== null && typeof resumeRef.id === 'string' ? resumeRef.id : '';
    if (resumeRefId.length === 0) {
      throw new ServiceError('INVALID_PARAMS', 'params.resumeRef.id must be a non-empty string.');
    }
    const streamId = typeof params.streamId === 'string' && params.streamId.length > 0
      ? params.streamId
      : null;
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
      throw new ServiceError('CONFLICT', 'resumeRef belongs to another live Side Chat.');
    }
    const live = this.sidechats.get(sidechatId);
    if (live) {
      if (live.resumeRefId !== resumeRefId) {
        throw new ServiceError('CONFLICT', 'resumeRef belongs to another Side Chat attachment.');
      }
      const session = this.service.requireSession(sidechatId);
      if (streamId !== null && session.streamId !== streamId) {
        throw new ServiceError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
      }
      this.service.closeSidechatRoute(sidechatId);
      await this.bridge.request('session.close', { sessionId: sidechatId });
      this.sidechats.delete(sidechatId);
    }
    const providerDataDeleted = false;
    this.resumeStore.rememberClosed(resumeRefId, { sidechatId, providerDataDeleted });
    return { ok: true as const, sidechatId, providerDataDeleted };
  }

  private serializeSidechat(
    session: AttachedSession,
    sidechat: SidechatRecord,
    createdAt = session.createdAt,
  ): Record<string, unknown> {
    return {
      id: session.id,
      parentSessionId: sidechat.parentSessionId,
      streamId: session.streamId,
      state: session.state,
      resumeRef: { id: sidechat.resumeRefId },
      anchor: sidechat.anchor,
      sessionConfig: session.sessionConfig,
      createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private async customization(method: string, params: Record<string, unknown>): Promise<unknown> {
    const kind = String(params.kind ?? '');
    if (kind !== 'skill' && kind !== 'mcp' && kind !== 'hook' && kind !== 'rule') {
      throw new ServiceError('CONFIG_VALUE_INVALID', `params.kind must be one of skill, mcp, hook, rule; got ${kind}.`);
    }
    try {
      if (method === 'customization.list') {
        return await this.bridge.request('customization.list', {
          kind,
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
        });
      }
      return await this.bridge.request('customization.detail', {
        kind,
        id: stringField(params, 'id'),
        ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
      });
    } catch (error) {
      // Bridges without the customization methods fail closed to the honest
      // empty-inventory shape instead of an opaque transport error.
      if (method === 'customization.list') {
        return customizationUnsupportedList(kind, 'unavailable');
      }
      return customizationUnavailableDetail(kind, String(params.id ?? ''), error instanceof Error ? error.message : String(error));
    }
  }

  private async sessionClose(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    // session.close(sidechatId) never closes a Side Chat; only the explicit
    // sidechat.close barrier may tear the transient route down (10.5.1).
    const session = this.requireOrdinaryStream(sessionId, streamId);
    if (session.closed) return { ok: true };
    await this.bridge.request('session.close', { sessionId });
    this.service.closeSession(sessionId, streamId);
    return { ok: true, ...(session ? {} : {}) };
  }

  private async sessionReplay(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const session = this.requireOrdinaryStream(sessionId, streamId);
    const cursor = params.cursor === null || params.cursor === undefined ? null : String(params.cursor);
    const limit = typeof params.limit === 'number' ? params.limit : 500;
    const page = await this.bridge.request('session.events.read', { sessionId, cursor, limit });
    const events = Array.isArray((page as { events?: unknown }).events)
      ? (page as { events: Array<{ type: string; data: Record<string, unknown>; seq: number }> }).events
      : [];
    const replayStreamId = `replay-${session.id}-${(page as { formatVersion?: unknown }).formatVersion ?? 0}`;
    const replayEvents = events.flatMap((event) => this.replayEventsFor(
      session,
      replayStreamId,
      event,
    ));
    return {
      replayStreamId,
      events: replayEvents,
      nextCursor: (page as { cursor?: unknown }).cursor ?? null,
    };
  }

  /**
   * Project one durable native event onto replay events whose identities are
   * derived exactly like the live projection: same sourceTurnId / stepId /
   * contentId / planId / diffId recipes and the same eventId hash inputs, so
   * a Host can reconcile live and replayed facts without duplicates. Native
   * events with no durable surface (assistant chunks are transient in
   * 0.2.0-rc.2; agent/inbox bookkeeping; the fork cut marker) are skipped rather
   * than fabricated.
   */
  private replayEventsFor(
    session: {
      id: string;
      nativeSessionId: string | null;
      turnConfigOptionsRevision: string | null;
    },
    replayStreamId: string,
    event: { type: string; data: Record<string, unknown>; seq: number },
  ): Array<Record<string, unknown>> {
    const nativeSessionId = session.nativeSessionId ?? session.id;
    const data = event.data;
    const nativeTurn = typeof data.turn === 'number' ? data.turn : 0;
    const step = typeof data.step === 'number' ? data.step : 0;
    const sourceId = `${nativeSessionId}:turn:${nativeTurn}`;
    const identityRevision = session.turnConfigOptionsRevision ?? `dsh-catalog-${PLUGIN_VERSION}`;

    const replayEventId = (projectionKind: string, ...identity: unknown[]): string =>
      hashId([PLUGIN_ID, nativeSessionId, projectionKind, event.seq, ...identity, identityRevision]);

    const base = {
      sessionId: session.id,
      replayStreamId,
      sequence: event.seq + 1,
      emittedAt: new Date().toISOString(),
    };
    // Replay events carry sourceTurnId only (no stream turnId): the replay
    // stream schema is a strict object keyed by durable native identity.
    const turnEnvelope = {
      ...base,
      sourceTurnId: sourceId,
    };

    switch (event.type) {
      case 'turn/start':
        return [{ ...turnEnvelope, method: 'turn.started', eventId: replayEventId('turn-started'), data: {} }];
      case 'turn/end': {
        const reason = (data.reason ?? {}) as Record<string, unknown>;
        const kind = typeof reason.kind === 'string' ? reason.kind : 'completed';
        const abortReason = (reason.reason ?? {}) as Record<string, unknown>;
        const abortKind = typeof abortReason.kind === 'string' ? abortReason.kind : 'unknown';
        if (kind === 'completed') {
          return [{ ...turnEnvelope, method: 'turn.completed', eventId: replayEventId('turn.completed'), data: { stopReason: 'completed' } }];
        }
        if (kind === 'max-tokens') {
          return [{ ...turnEnvelope, method: 'turn.completed', eventId: replayEventId('turn.completed'), data: { stopReason: 'limit_reached' } }];
        }
        if (kind === 'blocked') {
          return [{ ...turnEnvelope, method: 'turn.completed', eventId: replayEventId('turn.completed'), data: { stopReason: 'refused' } }];
        }
        if (kind === 'aborted') {
          return [{
            ...turnEnvelope,
            method: 'turn.completed',
            eventId: replayEventId('turn.completed'),
            data: { stopReason: abortKind === 'user' ? 'interrupted' : 'cancelled' },
          }];
        }
        if (kind === 'interrupted') {
          return [{
            ...turnEnvelope,
            method: 'turn.failed',
            eventId: replayEventId('turn.failed'),
            data: {
              error: {
                domainCode: 'RUNTIME_ERROR',
                message: 'Native turn was interrupted by persistence crash repair.',
                retryable: false,
                details: { crashRepaired: true },
              },
            },
          }];
        }
        if (kind === 'error') {
          return [{
            ...turnEnvelope,
            method: 'turn.failed',
            eventId: replayEventId('turn.failed'),
            data: {
              error: {
                domainCode: 'RUNTIME_ERROR',
                message: 'Native turn failed.',
                retryable: false,
                details: { native: (reason.error ?? null) as unknown },
              },
            },
          }];
        }
        return [{ ...turnEnvelope, method: 'turn.completed', eventId: replayEventId('turn.completed'), data: { stopReason: 'other' } }];
      }
      case 'step/start':
      case 'step/end':
        return [{
          ...turnEnvelope,
          method: 'step.updated',
          eventId: replayEventId('step-updated'),
          data: {
            stepId: `${sourceId}:step:${step}`,
            index: step,
            status: event.type === 'step/start' ? 'running' : 'completed',
          },
        }];
      case 'assistant/message': {
        const message = (data.message ?? {}) as Record<string, unknown>;
        const blocks = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        const out: Array<Record<string, unknown>> = [];
        for (const [index, block] of blocks.entries()) {
          const kind = block.type === 'reasoning' ? 'reasoning' : block.type === 'text' ? 'text' : null;
          if (!kind) continue;
          const stepId = `${sourceId}:step:${step}`;
          const contentId = contentIdForIdentity(sourceId, step, kind, index);
          out.push({
            ...turnEnvelope,
            method: 'content.completed',
            eventId: replayEventId('content-completed', contentId),
            data: {
              contentId,
              kind,
              ...(kind === 'text' ? { format: 'markdown' } : {}),
              stepId,
              content: String(block.text ?? ''),
            },
          });
        }
        const usage = data.usage as Record<string, unknown> | undefined;
        if (usage && blocks.length > 0) {
          const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
          const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
          const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
          const cacheWriteTokens = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
          const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
          out.push({
            ...turnEnvelope,
            method: 'usage.updated',
            eventId: replayEventId('usage-updated'),
            data: {
              stepId: `${sourceId}:step:${step}`,
              conversation: {
                mode: 'delta',
                inputTokens,
                outputTokens,
                ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
                totalTokens: inputTokens + outputTokens + cachedInputTokens,
              },
            },
          });
        }
        return out;
      }
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        const name = typeof data.name === 'string' ? data.name : '';
        if (callId.length === 0 || name.length === 0) return [];
        return [{
          ...turnEnvelope,
          method: 'activity.updated',
          eventId: replayEventId('activity-updated', callId, 'running'),
          data: {
            activityId: callId,
            kind: name,
            title: name,
            status: 'running',
            stepId: `${sourceId}:step:${step}`,
            presentation: { type: 'tool', data: { name, input: typeof data.arguments === 'string' ? data.arguments : '' } },
          },
        }];
      }
      case 'tool/result': {
        const message = (data.message ?? {}) as Record<string, unknown>;
        const callId = typeof message.callId === 'string' ? message.callId : `tool-${event.seq}`;
        const status = data.error !== undefined ? 'failed' : 'succeeded';
        const out: Array<Record<string, unknown>> = [{
          ...turnEnvelope,
          method: 'activity.updated',
          eventId: replayEventId('activity-updated', callId, 'terminal'),
          data: {
            activityId: callId,
            kind: callId,
            title: callId,
            status,
            presentation: {
              type: 'tool',
              data: { name: callId, output: JSON.stringify(message.content ?? '') },
            },
            details: { native: (message.content ?? null) as unknown },
          },
        }];
        const diffs = diffsFromMeta(data.meta);
        if (diffs !== null) {
          for (const [fileIndex, file] of diffs.entries()) {
            const diffId = hashId([nativeSessionId, 'diff', callId, file.path, fileIndex]);
            out.push({
              ...turnEnvelope,
              method: 'diff.updated',
              eventId: replayEventId('diff-updated', diffId),
              data: {
                diffId,
                diff: unifiedDiff(file),
                truncated: false,
                files: [{ path: file.path, status: diffStatusFor(file) }],
              },
            });
          }
        }
        return out;
      }
      case 'user/message': {
        const source = typeof data.source === 'string' ? data.source : 'gian';
        // Gian-issued input is already covered by turn.started's lifecycle;
        // only externally produced user messages are imported on replay.
        if (source === 'gian') return [];
        const message = (data.message ?? {}) as Record<string, unknown>;
        const blocks = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        const input = blocks
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => ({ type: 'text', text: String(block.text) }));
        if (input.length === 0) return [];
        return [{
          ...turnEnvelope,
          method: 'input.recorded',
          eventId: replayEventId('input-recorded'),
          data: { input },
        }];
      }
      case 'request/header': {
        const reason = data.reason === 'resume' ? 'resume' : data.reason === 'change' || data.reason === 'series' ? 'change' : 'initial';
        const header = (data.header ?? {}) as Record<string, unknown>;
        const config = (header.config ?? {}) as Record<string, unknown>;
        const model = config.model !== undefined ? String(config.model) : 'deepseek-chat';
        const provider = config.provider !== undefined ? String(config.provider) : 'deepseek';
        return [{
          ...turnEnvelope,
          method: 'request.updated',
          eventId: replayEventId('request-updated'),
          data: {
            requestId: `request-${sourceId}:step:${step}`,
            reason,
            stepId: `${sourceId}:step:${step}`,
            model: { provider, id: model },
            ...(typeof header.system === 'string' ? { systemPrompt: { text: header.system, truncated: false } } : {}),
            ...(Array.isArray(header.tools)
              ? { tools: (header.tools as Array<Record<string, unknown>>).map((tool) => ({ name: String(tool.name ?? '') })) }
              : {}),
          },
        }];
      }
      case 'request/context': {
        const contextWindow = typeof data.contextWindow === 'number' ? data.contextWindow : undefined;
        return [{
          ...turnEnvelope,
          method: 'request.updated',
          eventId: replayEventId('request-context'),
          data: {
            requestId: `request-${sourceId}`,
            reason: 'change',
            ...(contextWindow === undefined ? {} : { context: { window: contextWindow } }),
          },
        }];
      }
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos as Array<Record<string, unknown>> : [];
        const planId = `plan-${nativeSessionId}`;
        return [{
          ...turnEnvelope,
          method: 'plan.updated',
          eventId: replayEventId('plan-updated'),
          data: {
            planId,
            title: 'Todo list',
            steps: todos.map((todo, index) => ({
              id: hashId([nativeSessionId, 'todo', index, String(todo.content ?? '')]),
              text: String(todo.content ?? ''),
              status: todoStatusFor(todo.status),
            })),
          },
        }];
      }
      case 'assistant/chunk':
        // Transient in DSH 0.2.0-rc.2: chunks live only on the assistant stream,
        // never in the durable log. Replay must not fabricate them.
        return [];
      case 'approval/asked': {
        const askedId = typeof data.id === 'string' ? data.id : `asked-${event.seq}`;
        const interactionId = `dsh-approval-asked-${askedId}`;
        const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
        return [{
          ...turnEnvelope,
          method: 'interaction.requested',
          eventId: hashId([PLUGIN_ID, nativeSessionId, 'interaction-requested', event.seq, interactionId, identityRevision]),
          data: {
            interactionId,
            title: `Approve ${toolName}`,
            ...(typeof data.reason === 'string' ? { description: data.reason } : {}),
            presentation: { kind: 'permission' },
            inputs: [],
            actions: [
              { id: 'allow-once', label: 'Allow once', style: 'primary' },
              { id: 'reject', label: 'Reject', style: 'danger' },
            ],
          },
        }];
      }
      case 'approval/decided': {
        const askedId = typeof data.id === 'string' ? data.id : `asked-${event.seq}`;
        const interactionId = `dsh-approval-asked-${askedId}`;
        const outcome = data.outcome === 'allowed-once' || data.outcome === 'rejected'
          ? 'submitted'
          : 'cancelled';
        return [{
          ...turnEnvelope,
          method: 'interaction.resolved',
          eventId: hashId([PLUGIN_ID, nativeSessionId, 'interaction-resolved', event.seq, interactionId, identityRevision]),
          data: {
            interactionId,
            outcome,
            ...(outcome === 'submitted'
              ? { actionId: data.outcome === 'allowed-once' ? 'allow-once' : 'reject' }
              : {}),
          },
        }];
      }
      default:
        // Unknown durable events project exactly like the live generic path.
        if (event.type.startsWith('agent/inbox/') || event.type === 'session/end-seed') return [];
        const turn = typeof data.turn === 'number' ? data.turn : 0;
        const genericSourceId = `${nativeSessionId}:turn:${turn}`;
        const activityId = `generic-${genericSourceId}-${event.seq}`;
        return [{
          ...base,
          sourceTurnId: genericSourceId,
          turnId: `t-${turn}`,
          method: 'activity.updated',
          eventId: replayEventId('activity-generic', activityId),
          data: {
            activityId,
            kind: event.type,
            title: event.type,
            status: 'succeeded',
            presentation: { type: 'generic' },
            details: data as unknown,
          },
        }];
    }
  }

  private async shutdown(): Promise<unknown> {
    await this.bridge.request('shutdown', {});
    return { ok: true };
  }

  private snapshot(sessionId: string, streamId: string, _remote: Record<string, unknown> | null = null): Record<string, unknown> {
    const session = this.service.requireSession(sessionId);
    const busy = session.activeTurn !== null
      || session.pendingGianTurns.length > 0
      || session.state === 'running';
    const boundary = this.latestCompletedTurn(session) !== null;
    const everAccepted = session.acceptedTurns.size > 0;
    const idleAnchor = !busy && (boundary || !everAccepted);
    const idleBoundary = !busy && boundary;
    const forkSupported = this.capabilities['session.fork'] !== undefined;
    const atTurnSupported = this.capabilities['session.fork.atTurn'] !== undefined;
    const busyReason = 'Wait for the active turn to finish.';
    const boundaryReason = 'No stable terminal turn is available in this attach generation.';
    return {
      id: session.id,
      ...(session.nativeSessionId ? { nativeSession: { id: session.nativeSessionId } } : {}),
      streamId: session.streamId,
      state: session.state,
      sessionConfig: session.sessionConfig,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      availableActions: {
        ...(this.capabilities.sidechat === undefined ? {} : {
          'sidechat.create': {
            enabled: idleAnchor,
            ...(idleAnchor ? {} : { reason: busy ? busyReason : boundaryReason }),
          },
        }),
        ...(forkSupported ? {
          'session.fork': {
            enabled: idleBoundary,
            ...(idleBoundary ? {} : { reason: busy ? busyReason : boundaryReason }),
          },
        } : {}),
        ...(atTurnSupported ? {
          'session.fork.atTurn': {
            enabled: idleBoundary,
            ...(idleBoundary ? {} : { reason: busy ? busyReason : boundaryReason }),
          },
        } : {}),
      },
    };
  }

  /**
   * A model id removed by the runtime, and an effort that is not one of that
   * model's advertised choices, fall back to the advertised default. Other
   * invalid selects, including an unknown provider, still fail.
   * turn.start's result stays `{ accepted, turnId }`; the reselect prompt is
   * a turn notice emitted once the native turn starts.
   */
  private retiredTurnConfig(
    config: Record<string, ConfigValue>,
    options: ConfigOption[],
  ): { config: Record<string, ConfigValue>; retiredModel: string | null; fallbackModel: string | null } {
    const next: Record<string, ConfigValue> = { ...config };
    const model = options.find(option => option.id === 'model' && option.binding === 'turn');
    let retiredModel: string | null = null;
    let fallbackModel: string | null = null;
    if (model && next.model !== undefined && !selectChoiceIncludes(model, next.model)) {
      if (!selectChoiceIncludes(model, model.defaultValue)) {
        throw new ServiceError('CONFIG_VALUE_INVALID', 'Option model value was not advertised.');
      }
      retiredModel = String(next.model);
      fallbackModel = String(model.defaultValue);
      next.model = model.defaultValue;
    }
    const effort = options.find(option => option.id === 'effort' && option.binding === 'turn');
    if (effort && next.effort !== undefined && !selectChoiceIncludes(effort, next.effort)) {
      if (!selectChoiceIncludes(effort, effort.defaultValue)) {
        throw new ServiceError('CONFIG_VALUE_INVALID', 'Option effort value was not advertised.');
      }
      next.effort = effort.defaultValue;
    }
    return { config: next, retiredModel, fallbackModel };
  }

  private validateConfigSnapshot(
    values: Record<string, ConfigValue>,
    binding: 'session' | 'turn',
    advertised = this.catalogState.configOptions,
  ): void {
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

function selectChoiceIncludes(option: ConfigOption, value: ConfigValue): boolean {
  return option.choices?.some(choice => Object.is(choice.value, value)) === true;
}

/** Bridge cwd values may be empty on resume paths; fall back to the parent's. */
function nonEmptyOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
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
      ...(typeof record.skill === 'string' ? { skill: record.skill } : {}),
    };
  });
}

function hashIdLocal(parts: unknown[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex').slice(0, 32);
}

/** Parse `${nativeSessionId}:turn:${n}` into n when the native id matches. */
function nativeTurnFromSourceId(sourceTurnId: string, nativeSessionId: string): number | null {
  const prefix = `${nativeSessionId}:turn:`;
  if (sourceTurnId.startsWith(prefix) === false) return null;
  const suffix = sourceTurnId.slice(prefix.length);
  const turn = Number(suffix);
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
}

/** Same content identity recipe as the live projection (service.ts). */
function contentIdForIdentity(
  sourceTurnId: string,
  nativeStep: number,
  kind: string,
  index: number,
): string {
  const stepId = `${sourceTurnId}:step:${nativeStep}`;
  return kind === 'text' && index === 0
    ? `assistant-${stepId}`
    : `assistant-${kind}-${index}-${stepId}`;
}

export const DSH_CAPABILITIES = BASE_CAPABILITIES;
