import type {
  ApprovalMode,
  CcModelCapabilities,
  CodexModelCapabilities,
  ConfigCondition,
  ConfigOption,
  ConfigValue,
  Executor,
  NativeConfigChoice,
  NativeConfigOption,
  ProxyModeCapabilities,
  Session,
  SlashCommand,
  SlashCommandSource,
  ThinkingEffort,
} from '@gian/shared';
import { isApprovalMode, usesNativeExecutorConfig } from '@gian/shared';
import { loadProxyCapabilities, loadProxyModels, loadSlashCommands } from '../../api.js';

export type ProxyModel = CcModelCapabilities | CodexModelCapabilities;

/** Capability catalogs differ per (Proxy kind, Agent CLI path) — two Agents
 *  of one kind never share a cached catalog/models/modes entry. The
 *  agent-less key is the kind default (first saved Agent's runtime). */
function scopeKey(executor: Executor, agentId?: string | null): string {
  return agentId ? `${executor}::${agentId}` : executor;
}

const modelCache = new Map<string, ProxyModel[]>();
const modelPromises = new Map<string, Promise<ProxyModel[]>>();

export function getModelsCached(
  executor: 'claude' | 'codex',
  agentId?: string | null,
): ProxyModel[] | undefined {
  return modelCache.get(scopeKey(executor, agentId));
}

export function fetchModelsCached(
  executor: 'claude' | 'codex',
  agentId?: string | null,
): Promise<ProxyModel[]> {
  const key = scopeKey(executor, agentId);
  const hit = modelCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = modelPromises.get(key);
  if (inflight) return inflight;
  const request = loadProxyModels(executor, agentId)
    .then(models => {
      modelCache.set(key, models);
      modelPromises.delete(key);
      return models;
    })
    .catch(error => {
      modelPromises.delete(key);
      throw error;
    });
  modelPromises.set(key, request);
  return request;
}

export function defaultModel(models: ProxyModel[], executor: 'claude' | 'codex'): string {
  const fallback = models.find(model => model.isDefault) ?? models[0];
  return fallback?.model ?? (executor === 'codex' ? 'gpt-5-codex' : '');
}

export function modelLabel(models: ProxyModel[], id: string): string {
  return models.find(model => model.model === id)?.displayName ?? id;
}

const modeCache = new Map<string, ProxyModeCapabilities[]>();
const modePromises = new Map<string, Promise<ProxyModeCapabilities[]>>();

export function getModesCached(
  executor: 'claude' | 'codex',
  agentId?: string | null,
): ProxyModeCapabilities[] | undefined {
  return modeCache.get(scopeKey(executor, agentId));
}

/** Proxy-advertised approval_mode choices, or the legacy `modes` list. */
export function modesFromCapabilities(capabilities: unknown): ProxyModeCapabilities[] {
  const catalog = catalogFromCapabilities(capabilities);
  const option = catalog.configOptions.find(entry => entry.role === 'approval_mode');
  if (option?.choices && option.choices.length > 0) {
    return option.choices.map(choice => ({
      id: String(choice.value),
      label: choice.displayName,
      description: choice.description ?? '',
      isDefault: Object.is(choice.value, option.defaultValue),
    }));
  }
  if (!capabilities || typeof capabilities !== 'object') return [];
  const modes = (capabilities as { modes?: unknown }).modes;
  if (!Array.isArray(modes)) return [];
  return modes.filter((mode): mode is ProxyModeCapabilities => (
    !!mode
    && typeof mode === 'object'
    && typeof (mode as { id?: unknown }).id === 'string'
    && typeof (mode as { label?: unknown }).label === 'string'
  ));
}

/** `undefined` when initialize capabilities were not included in the payload. */
export function steerAdvertised(capabilities: unknown): boolean | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const advertised = (capabilities as { capabilities?: Record<string, unknown> }).capabilities;
  if (!advertised) return undefined;
  return advertised['turn.steer'] !== undefined;
}

const steerCache = new Map<string, boolean | undefined>();
const steerPromises = new Map<string, Promise<boolean | undefined>>();

export interface ComposerCatalog {
  catalogRevision?: string;
  configOptions: ConfigOption[];
  input: Array<{ type: string; enabledWhen?: ConfigCondition[] }>;
  slashCommands: SlashCommand[];
  /**
   * Catalog View support declarations for Gian standard Actions (gian.proxy/2.0
   * proposal §9.4). Absent on catalogs from Proxies predating the amendment —
   * treated as "not declared", equivalent to `supported:false` (§9.4: 缺失的
   * 已知 Action 与 supported:false 等价). `catalog.changed` wholesale-replaces
   * the array, never merges.
   */
  actions?: CatalogActionDescriptor[];
  resolveAdvertised?: boolean;
}

/**
 * One `catalog.list`/`catalog.resolve` Action Descriptor (proposal §9.4):
 * `id` and `supported` are required; `reason` is optional and only used for
 * greyed-out display.
 */
export interface CatalogActionDescriptor {
  id: string;
  supported: boolean;
  reason?: string;
}

/** Known standard Action ids (proposal §9.4). Unknown ids in a catalog are
 *  parsed but ignored by gating (forward compatibility, §9.4). */
export const KNOWN_CATALOG_ACTION_IDS = [
  'sidechat.create',
  'session.fork',
  'session.fork.atTurn',
] as const;

export type KnownCatalogActionId = typeof KNOWN_CATALOG_ACTION_IDS[number];

const EMPTY_CATALOG: ComposerCatalog = { configOptions: [], input: [], slashCommands: [] };
const catalogCache = new Map<string, ComposerCatalog>();
const catalogPromises = new Map<string, Promise<ComposerCatalog>>();

/** Roles that already have a dedicated Composer slot. */
export const PLACED_CATALOG_ROLES = new Set([
  'model',
  'effort',
  'fast',
  'approval_mode',
  'execution_mode',
]);

export function mergeTurnCatalog(
  processOptions: ConfigOption[],
  sessionTurnOptions: ConfigOption[] | undefined,
): ConfigOption[] {
  if (sessionTurnOptions === undefined) return processOptions;
  return [
    ...processOptions.filter((option) => option.binding === 'session'),
    ...sessionTurnOptions,
  ];
}

export function optionByRole(
  options: ConfigOption[],
  role: string,
): ConfigOption | undefined {
  return options.find((option) => option.role === role);
}

export function modelsFromCatalog(option: ConfigOption | undefined): ProxyModel[] {
  if (!option?.choices?.length) return [];
  return option.choices.map((choice) => ({
    id: String(choice.value),
    model: String(choice.value),
    displayName: choice.displayName,
    description: choice.description ?? '',
    hidden: false,
    isDefault: Object.is(choice.value, option.defaultValue),
    defaultEffort: null,
    supportedEfforts: [],
    defaultThinking: null,
    supportedThinking: [],
  }));
}

/** Prefer the active catalog's model choices. Fall back to the process /
 *  session snapshot, then the Claude/Codex capability list. Native executors
 *  (Kimi/Grok) have no `/models` list, so an empty primary option must not
 *  wipe a still-valid snapshot. */
export function displayModelsFromCatalog(
  primary: ConfigOption | undefined,
  fallback?: ConfigOption,
  extras: ProxyModel[] = [],
): ProxyModel[] {
  const fromPrimary = modelsFromCatalog(primary);
  if (fromPrimary.length > 0) return fromPrimary;
  const fromFallback = modelsFromCatalog(fallback);
  if (fromFallback.length > 0) return fromFallback;
  return extras;
}

function stringChoices(option: ConfigOption | undefined): string[] {
  return (option?.choices ?? []).flatMap(choice => (
    typeof choice.value === 'string' && choice.value ? [choice.value] : []
  ));
}

function legacyModels(raw: unknown): ProxyModel[] {
  if (!raw || typeof raw !== 'object' || !('models' in raw)) return [];
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.filter((model): model is ProxyModel => (
    !!model
    && typeof model === 'object'
    && 'hidden' in model
    && !(model as ProxyModel).hidden
  ));
}

/** Settings Executors defaults: prefer gian.proxy/2.0 catalog roles, keep
 *  Protocol 1 `models`/`modes` arrays as a fallback. Never assume `models`
 *  exists on the capabilities payload. */
export function executorSettingsFromCapabilities(executor: Executor, raw: unknown): {
  models: ProxyModel[];
  thinkingLevels: string[];
  modes: ProxyModeCapabilities[];
} {
  const catalog = catalogFromCapabilities(raw);
  const catalogModels = modelsFromCatalog(optionByRole(catalog.configOptions, 'model'));
  const models = catalogModels.length > 0 ? catalogModels : legacyModels(raw);
  const thinkingLevels = stringChoices(optionByRole(catalog.configOptions, 'effort'));
  const catalogMode = optionByRole(catalog.configOptions, 'approval_mode');
  const advertisedModes = modesFromCapabilities(raw)
    .filter(mode => mode.id.length > 0 && mode.id !== 'null');
  const legacyModes = raw && typeof raw === 'object'
    ? modesFromCapabilities({ modes: (raw as { modes?: unknown }).modes })
    : [];
  // Managed Claude/Codex defaults are Gian's semantic ApprovalMode values.
  // A Protocol 2 Proxy that publishes native, low-level permission values in
  // the approval role (Codex 0.2.0, Claude 0.2.0) must not turn those into an
  // AgentProxyDefaults.mode that Host cannot apply. Native executors own their
  // mode vocabulary and therefore keep the Catalog values verbatim.
  const catalogModesAreSemantic = advertisedModes.length > 0
    && advertisedModes.every(mode => isApprovalMode(mode.id));
  const modes = usesNativeExecutorConfig(executor)
    ? advertisedModes
    : catalogMode?.choices?.length && catalogModesAreSemantic
      ? advertisedModes
      : legacyModes.filter(mode => isApprovalMode(mode.id));
  return { models, thinkingLevels, modes };
}

export function applyResolvedDefaults(
  values: Record<string, ConfigValue>,
  defaults: Record<string, ConfigValue> | undefined,
): Record<string, ConfigValue> {
  if (!defaults) return values;
  const next = { ...values };
  for (const [id, value] of Object.entries(defaults)) {
    if (next[id] === undefined) next[id] = value;
  }
  return next;
}

export function createConfigsFromCatalog(
  executor: Executor,
  options: ConfigOption[],
  values: Record<string, ConfigValue>,
): {
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: 'fast' | null;
  session_config: Record<string, ConfigValue>;
  turn_config: Record<string, ConfigValue>;
} {
  const session_config: Record<string, ConfigValue> = {};
  const turn_config: Record<string, ConfigValue> = {};
  let model: string | undefined;
  let thinkingEffort: ThinkingEffort | null | undefined;
  let approvalMode: ApprovalMode | null | undefined;
  let serviceTier: 'fast' | null | undefined;
  for (const option of options) {
    if (!optionVisible(option, values) || !optionEnabled(option, values)) continue;
    const value = values[option.id];
    if (value === undefined) continue;
    if (
      (option.role === 'effort' || option.role === 'model')
      && option.choices
      && option.choices.length > 0
      && !option.choices.some(choice => Object.is(choice.value, value))
    ) {
      continue;
    }
    if (option.binding === 'session') session_config[option.id] = value;
    else turn_config[option.id] = value;
    if (option.role === 'model' && value != null && value !== '') model = String(value);
    else if (option.role === 'effort') {
      thinkingEffort = value == null ? null : String(value);
    } else if (option.role === 'approval_mode' && isApprovalMode(value)
      && !usesNativeExecutorConfig(executor)) {
      approvalMode = value;
    } else if (option.role === 'fast') {
      serviceTier = value === true ? 'fast' : null;
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    session_config,
    turn_config,
  };
}

export function conditionsMatch(
  conditions: ConfigCondition[] | undefined,
  values: Record<string, ConfigValue>,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(condition =>
    condition.oneOf.some(candidate => Object.is(candidate, values[condition.optionId])));
}

export function optionVisible(
  option: Pick<ConfigOption, 'visibleWhen'>,
  values: Record<string, ConfigValue>,
): boolean {
  return conditionsMatch(option.visibleWhen, values);
}

export function optionEnabled(
  option: Pick<ConfigOption, 'enabledWhen'>,
  values: Record<string, ConfigValue>,
): boolean {
  return conditionsMatch(option.enabledWhen, values);
}

export function composerConfigValues(
  session: Pick<
    Session,
    'turn_config' | 'executor_config' | 'model' | 'thinking_effort' | 'approval_mode' | 'service_tier'
  >,
  options: ConfigOption[],
): Record<string, ConfigValue> {
  const values: Record<string, ConfigValue> = {
    ...(session.executor_config?.values ?? {}),
    ...(session.turn_config ?? {}),
  };
  for (const option of options) {
    if (values[option.id] !== undefined) continue;
    if (option.role === 'model' && session.model != null && session.model !== '') {
      values[option.id] = session.model;
    } else if (option.role === 'effort' && session.thinking_effort != null) {
      values[option.id] = session.thinking_effort;
    } else if (option.role === 'approval_mode' && session.approval_mode != null) {
      values[option.id] = session.approval_mode;
    } else if (option.role === 'fast') {
      values[option.id] = session.service_tier === 'fast';
    } else if (option.defaultValue !== undefined) {
      values[option.id] = option.defaultValue;
    }
  }
  return values;
}

export function runtimeCatalogOptions(
  options: ConfigOption[],
  values: Record<string, ConfigValue>,
): ConfigOption[] {
  return options
    .filter(option => option.binding === 'turn')
    .filter(option => !option.role || !PLACED_CATALOG_ROLES.has(option.role))
    .filter(option => optionVisible(option, values))
    .sort((left, right) => (left.presentation?.order ?? 0) - (right.presentation?.order ?? 0));
}

export function inputTypeAdvertised(
  catalog: ComposerCatalog,
  type: string,
  values: Record<string, ConfigValue>,
): boolean {
  const descriptor = catalog.input.find(entry => entry.type === type);
  if (!descriptor) return false;
  return conditionsMatch(descriptor.enabledWhen, values);
}

function isConfigCondition(value: unknown): value is ConfigCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { optionId?: unknown; oneOf?: unknown };
  return typeof record.optionId === 'string' && Array.isArray(record.oneOf);
}

function isConfigOption(value: unknown): value is ConfigOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as ConfigOption;
  return typeof record.id === 'string'
    && (record.binding === 'session' || record.binding === 'turn')
    && (record.control === 'select' || record.control === 'boolean'
      || record.control === 'number' || record.control === 'text')
    && typeof record.required === 'boolean';
}

function isSlashCommand(value: unknown): value is SlashCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as SlashCommand;
  return typeof record.name === 'string' && typeof record.description === 'string';
}

/** Defensive guard for one catalog `actions[]` descriptor (proposal §9.4):
 *  `id` and `supported` required; `reason` kept only when it is a string. */
function isActionDescriptor(value: unknown): value is CatalogActionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as CatalogActionDescriptor;
  return typeof record.id === 'string' && typeof record.supported === 'boolean';
}

export function catalogFromCapabilities(raw: unknown): ComposerCatalog {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CATALOG };
  const record = raw as {
    catalogRevision?: unknown;
    configOptions?: unknown;
    input?: unknown;
    actions?: unknown;
    slashCommands?: unknown;
    capabilities?: Record<string, unknown>;
  };
  return {
    catalogRevision: typeof record.catalogRevision === 'string' ? record.catalogRevision : undefined,
    configOptions: Array.isArray(record.configOptions)
      ? record.configOptions.filter(isConfigOption)
      : [],
    input: Array.isArray(record.input)
      ? record.input.flatMap((entry): ComposerCatalog['input'] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const item = entry as { type?: unknown; enabledWhen?: unknown };
        if (typeof item.type !== 'string') return [];
        const enabledWhen = Array.isArray(item.enabledWhen)
          ? item.enabledWhen.filter(isConfigCondition)
          : undefined;
        return [{ type: item.type, ...(enabledWhen ? { enabledWhen } : {}) }];
      })
      : [],
    slashCommands: Array.isArray(record.slashCommands)
      ? record.slashCommands.filter(isSlashCommand)
      : [],
    // `actions` stays undefined when the field is absent — a legacy catalog
    // — and becomes a (possibly empty) parsed array when the Proxy declares
    // it. Malformed entries are dropped; a non-string `reason` is stripped.
    ...(record.actions !== undefined
      ? {
          actions: (Array.isArray(record.actions) ? record.actions : [])
            .filter(isActionDescriptor)
            .map(descriptor => ({
              id: descriptor.id,
              supported: descriptor.supported,
              ...(typeof descriptor.reason === 'string' ? { reason: descriptor.reason } : {}),
            })),
        }
      : {}),
    resolveAdvertised: record.capabilities?.['catalog.resolve'] !== undefined,
  };
}

export function getCatalogCached(
  executor: Executor,
  agentId?: string | null,
): ComposerCatalog | undefined {
  return catalogCache.get(scopeKey(executor, agentId));
}

export function fetchCatalogCached(
  executor: Executor,
  agentId?: string | null,
): Promise<ComposerCatalog> {
  const key = scopeKey(executor, agentId);
  const hit = catalogCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = catalogPromises.get(key);
  if (inflight) return inflight;
  const request = Promise.resolve()
    .then(() => loadProxyCapabilities(executor, agentId))
    .then(raw => {
      const catalog = catalogFromCapabilities(raw);
      catalogCache.set(key, catalog);
      catalogPromises.delete(key);
      if (executor === 'claude' || executor === 'codex') {
        const modes = modesFromCapabilities(raw);
        if (modes.length > 0) modeCache.set(key, modes);
      }
      const advertised = steerAdvertised(raw);
      if (advertised !== undefined) steerCache.set(key, advertised);
      return catalog;
    })
    .catch(error => {
      catalogPromises.delete(key);
      throw error;
    });
  catalogPromises.set(key, request);
  return request;
}

export function fetchSteerCached(
  executor: Executor,
  agentId?: string | null,
): Promise<boolean | undefined> {
  const key = scopeKey(executor, agentId);
  if (steerCache.has(key)) return Promise.resolve(steerCache.get(key));
  const inflight = steerPromises.get(key);
  if (inflight) return inflight;
  const request = Promise.resolve()
    .then(() => loadProxyCapabilities(executor, agentId))
    .then(capabilities => {
      const advertised = steerAdvertised(capabilities);
      steerCache.set(key, advertised);
      steerPromises.delete(key);
      return advertised;
    })
    .catch(error => {
      steerPromises.delete(key);
      throw error;
    });
  steerPromises.set(key, request);
  return request;
}

export function clearComposerCapabilityCaches(): void {
  modelCache.clear();
  modelPromises.clear();
  modeCache.clear();
  modePromises.clear();
  steerCache.clear();
  steerPromises.clear();
  catalogCache.clear();
  catalogPromises.clear();
}

export function fetchModesCached(
  executor: 'claude' | 'codex',
  agentId?: string | null,
): Promise<ProxyModeCapabilities[]> {
  const key = scopeKey(executor, agentId);
  const hit = modeCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = modePromises.get(key);
  if (inflight) return inflight;
  // Defer the call so a missing/broken api export rejects instead of throwing
  // synchronously — callers treat either as "keep the built-in fallback".
  const request = Promise.resolve()
    .then(() => loadProxyCapabilities(executor, agentId))
    .then(capabilities => {
      const modes = modesFromCapabilities(capabilities);
      modeCache.set(key, modes);
      modePromises.delete(key);
      return modes;
    })
    .catch(error => {
      modePromises.delete(key);
      throw error;
    });
  modePromises.set(key, request);
  return request;
}

export function claudeModelFamily(id: string): string {
  return /^claude-(opus|sonnet|haiku)\b/.exec(id)?.[1] ?? id;
}

export function supportedEfforts(model: ProxyModel | undefined): ThinkingEffort[] {
  if (!model) return [];
  if ('supportedEfforts' in model) return model.supportedEfforts;
  if ('supportedThinking' in model) {
    return model.supportedThinking.map(effort => effort === null ? 'off' : effort) as ThinkingEffort[];
  }
  return [];
}

export function defaultEffort(model: ProxyModel | undefined): ThinkingEffort | null {
  if (!model) return null;
  if ('defaultEffort' in model) return model.defaultEffort;
  if ('defaultThinking' in model) return (model.defaultThinking ?? 'off') as ThinkingEffort;
  return null;
}

const slashCache = new Map<string, SlashCommand[]>();
const slashPromises = new Map<string, Promise<SlashCommand[]>>();

/** Emitted after a workspace-scoped command cache is invalidated. Mounted
 *  composers for that workspace refresh immediately instead of waiting for a
 *  session remount. */
export const SLASH_CACHE_INVALIDATED_EVENT = 'gian:slash-cache-invalidated';

function slashCacheKey(
  executor: 'claude' | 'codex',
  workspaceId: string | undefined,
  agentId?: string | null,
): string {
  return `${scopeKey(executor, agentId)}:${workspaceId ?? '_'}`;
}

export function getSlashCached(
  executor: 'claude' | 'codex',
  workspaceId?: string,
  agentId?: string | null,
): SlashCommand[] | undefined {
  return slashCache.get(slashCacheKey(executor, workspaceId, agentId));
}

/** Drop both executor entries for a workspace. Project commands/skills can
 *  change after the Host reports a branch/fetch/merge update, while the user
 *  and builtin entries are cheap enough to rediscover with them. */
export function invalidateSlashCacheForWorkspace(workspaceId: string): void {
  for (const executor of ['claude', 'codex'] as const) {
    const key = slashCacheKey(executor, workspaceId);
    slashCache.delete(key);
    // Do not let an older request repopulate the invalidated key. The request
    // may still resolve for its original caller, but a subsequent fetch starts
    // a fresh discovery and owns the cache write.
    slashPromises.delete(key);
  }
}

/** Test/session teardown helper; production invalidation is workspace-scoped
 *  through `invalidateSlashCacheForWorkspace`. */
export function clearSlashCache(): void {
  slashCache.clear();
  slashPromises.clear();
}

export function fetchSlashCached(
  executor: 'claude' | 'codex',
  workspaceId?: string,
  agentId?: string | null,
): Promise<SlashCommand[]> {
  const key = slashCacheKey(executor, workspaceId, agentId);
  const hit = slashCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = slashPromises.get(key);
  if (inflight) return inflight;
  let request: Promise<SlashCommand[]>;
  request = loadSlashCommands(executor, workspaceId, agentId)
    .then(commands => {
      // Cache only if this is still the request registered for the key. A
      // workspace invalidation can deliberately detach an older in-flight
      // request before it resolves.
      if (slashPromises.get(key) === request) {
        slashCache.set(key, commands);
        slashPromises.delete(key);
      }
      return commands;
    })
    .catch(error => {
      if (slashPromises.get(key) === request) slashPromises.delete(key);
      throw error;
    });
  slashPromises.set(key, request);
  return request;
}

const sourceOrder: SlashCommandSource[] = ['builtin', 'project', 'user'];

export function slashFilterGrouped(
  commands: SlashCommand[],
  prefix: string,
): Array<{ source: SlashCommandSource; items: SlashCommand[] }> {
  const normalizedPrefix = prefix && prefix !== '/' ? prefix.toLowerCase() : null;
  const groups: Array<{ source: SlashCommandSource; items: SlashCommand[] }> = [];
  for (const source of sourceOrder) {
    let items = commands.filter(command => command.source === source);
    if (normalizedPrefix) {
      items = items.filter(command => command.name.toLowerCase().startsWith(normalizedPrefix));
    }
    if (items.length > 0) groups.push({ source, items });
  }
  return groups;
}

export function flatFiltered(
  groups: Array<{ source: SlashCommandSource; items: SlashCommand[] }>,
): SlashCommand[] {
  return groups.flatMap(group => group.items);
}

export interface ComposerModeOption {
  key: string;
  mode: ApprovalMode;
  /** i18n title key for known mode ids; absent → render `label` instead. */
  titleKey?: string;
  /** i18n hint key for known mode ids; absent → render `description` instead. */
  descKey?: string;
  /** Proxy-advertised label, used when no i18n title exists (unknown ids). */
  label?: string;
  /** Proxy-advertised description, used when no i18n hint exists. */
  description?: string;
}

/** Known mode ids keep their localized composer labels (zh users see the
 *  Chinese hints); ids the proxy adds later fall back to the advertised
 *  label/description. */
const CLAUDE_MODE_I18N: Record<string, { titleKey: string; descKey?: string }> = {
  plan: { titleKey: 'mode.plan' },
  ask: { titleKey: 'mode.ask' },
  auto: { titleKey: 'mode.auto' },
  custom: { titleKey: 'mode.custom' },
  'full-access': { titleKey: 'mode.full-access' },
};

const CODEX_MODE_I18N: Record<string, { titleKey: string; descKey?: string }> = {
  plan: { titleKey: 'mode.plan' },
  ask: { titleKey: 'composer.approval.ask.title', descKey: 'composer.approval.ask.desc' },
  auto: { titleKey: 'composer.approval.approve.title', descKey: 'composer.approval.approve.desc' },
  'full-access': { titleKey: 'composer.approval.full.title', descKey: 'composer.approval.full.desc' },
  custom: { titleKey: 'composer.approval.custom.title', descKey: 'composer.approval.custom.desc' },
};

/** Built-in fallback shown until the proxy capabilities resolve (or if the
 *  fetch fails). Mirrors what cc-proxy/codex-proxy advertised when this UI
 *  was hardcoded. */
export const CLAUDE_MODES: ComposerModeOption[] = [
  { key: 'plan', mode: 'plan', titleKey: 'mode.plan' },
  { key: 'ask', mode: 'ask', titleKey: 'mode.ask' },
  { key: 'auto', mode: 'auto', titleKey: 'mode.auto' },
];

export const CODEX_APPROVALS: ComposerModeOption[] = [
  { key: 'ask', mode: 'ask', titleKey: 'composer.approval.ask.title', descKey: 'composer.approval.ask.desc' },
  { key: 'approve', mode: 'auto', titleKey: 'composer.approval.approve.title', descKey: 'composer.approval.approve.desc' },
  { key: 'full', mode: 'full-access', titleKey: 'composer.approval.full.title', descKey: 'composer.approval.full.desc' },
  { key: 'custom', mode: 'custom', titleKey: 'composer.approval.custom.title', descKey: 'composer.approval.custom.desc' },
];

/** Mode dropdown rows: proxy-advertised modes once capabilities resolve, the
 *  built-in fallback list before that. */
export function composerModeOptions(
  executor: Executor,
  modes: ProxyModeCapabilities[] | undefined,
): ComposerModeOption[] {
  if (!modes || modes.length === 0) {
    if (executor === 'codex') return CODEX_APPROVALS;
    if (executor === 'claude') return CLAUDE_MODES;
    return [];
  }
  const i18n = executor === 'codex' ? CODEX_MODE_I18N : CLAUDE_MODE_I18N;
  return modes.map(mode => ({
    key: mode.id,
    mode: mode.id as ApprovalMode,
    titleKey: i18n[mode.id]?.titleKey,
    descKey: i18n[mode.id]?.descKey,
    label: mode.label,
    description: mode.description,
  }));
}

/** Collapsed dropdown button label for the active mode. */
export function composerModeLabel(
  executor: Executor,
  mode: string,
  modes: ProxyModeCapabilities[] | undefined,
  t: (key: string) => string,
): string {
  const titleKey = (executor === 'codex' ? CODEX_MODE_I18N : CLAUDE_MODE_I18N)[mode]?.titleKey;
  if (titleKey) return t(titleKey);
  return modes?.find(entry => entry.id === mode)?.label ?? mode;
}

const CODEX_EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

function codexEffortLabel(level: ThinkingEffort | null): string {
  if (!level) return '';
  return CODEX_EFFORT_LABELS[level] ?? level;
}

export function effortLabel(
  executor: Executor,
  level: ThinkingEffort | null,
): string {
  if (!level) return '';
  return executor === 'codex'
    ? codexEffortLabel(level)
    : level.replace(/(^|[-_])(\w)/g, (_match, separator: string, letter: string) =>
      `${separator ? ' ' : ''}${letter.toUpperCase()}`);
}

export type NativeOptionRole = 'model' | 'effort' | 'mode';

export function nativeOptionRole(option: NativeConfigOption): NativeOptionRole | null {
  const category = option.category?.trim().toLowerCase();
  const id = option.id.trim().toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    category === 'thought_level'
    || category === 'thought'
    || category === 'thinking'
    || category === 'effort'
    || category === 'reasoning_effort'
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'effort';
  if (
    category === 'mode'
    || category === 'approval_mode'
    || id === 'mode'
    || id === 'permission_mode'
    || id === 'approval_mode'
  ) return 'mode';
  return null;
}

function nativeChoiceDisplayLabel(role: NativeOptionRole, choice: NativeConfigChoice): string {
  const value = String(choice.value ?? '').toLowerCase();
  if (role === 'mode' && (value === 'plan' || value === 'auto' || value === 'yolo')) {
    return value;
  }
  return choice.label;
}

export function nativeChoiceLabel(option: NativeConfigOption, role: NativeOptionRole): string {
  const current = option.choices?.find(choice =>
    String(choice.value ?? '') === String(option.currentValue ?? ''));
  return current
    ? nativeChoiceDisplayLabel(role, current)
    : String(option.currentValue ?? option.name);
}

export { nativeChoiceDisplayLabel };
