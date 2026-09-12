/**
 * Catalog projection (Revision 2 §7).
 *
 * `workspace/readState` is the side-effect-free Catalog source proven by WP0
 * G0 (session/list count unchanged; no inner session/create anywhere). The
 * bootstrap Catalog only covers the unconfigured state readState itself
 * reports (available=0, zcode-unconfigured).
 *
 * Outer ConfigValue is scalar, so model references use the versioned reversible
 * encoding `zmodel:v1:<base64url(JSON.stringify([providerId, modelId]))>`;
 * anything malformed is CONFIG_VALUE_INVALID.
 */

import type {
  InnerModelInfo,
  InnerReasoningLevel,
  InnerReadState,
  InnerSettings,
  InnerSlashCommand,
} from './inner/model.js';

export const MODEL_VALUE_PREFIX = 'zmodel:v1:';

export interface CatalogConfigOption {
  id: string;
  displayName: string;
  description?: string;
  binding: 'session' | 'turn';
  control: 'select' | 'boolean' | 'number' | 'text';
  required: boolean;
  defaultValue: string | number | boolean | null;
  choices?: Array<{ value: string | number | boolean | null; displayName: string; description?: string }>;
  enabledWhen?: Array<{ optionId: string; oneOf: Array<string | number | boolean | null> }>;
  presentation?: { group?: string; order?: number };
}

export interface ProjectedCatalog {
  catalogRevision: string;
  input: Array<{ type: string; enabledWhen?: Array<{ optionId: string; oneOf: Array<string | number | boolean | null> }> }>;
  configOptions: CatalogConfigOption[];
  specialCatalogs: { model?: string; thinking?: string; approvalMode?: string };
  actions: Array<{ id: string; supported: boolean; reason?: string }>;
  slashCommands: Array<{ name: string; description: string; source: 'builtin' | 'user' | 'project'; argHints: Array<{ kind: string; placeholder?: string }> }>;
}

export class ConfigValueInvalidError extends Error {
  readonly domainCode = 'CONFIG_VALUE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValueInvalidError';
  }
}

export function encodeModelValue(ref: { providerId: string; modelId: string }): string {
  return MODEL_VALUE_PREFIX + Buffer
    .from(JSON.stringify([ref.providerId, ref.modelId]), 'utf8')
    .toString('base64url');
}

export function decodeModelValue(value: string): { providerId: string; modelId: string } {
  if (typeof value !== 'string' || value.startsWith(MODEL_VALUE_PREFIX) === false) {
    throw new ConfigValueInvalidError('Model config value must use the zmodel:v1 encoding.');
  }
  const encoded = value.slice(MODEL_VALUE_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ConfigValueInvalidError('Model config value payload is not valid base64url JSON.');
  }
  if (
    Array.isArray(decoded) === false
    || decoded.length !== 2
    || decoded.every((part): part is string => typeof part === 'string') === false
    || (decoded as string[])[0] === ''
    || (decoded as string[])[1] === ''
  ) {
    throw new ConfigValueInvalidError('Model config value payload must be [providerId, modelId].');
  }
  const [providerId, modelId] = decoded as [string, string];
  return { providerId, modelId };
}

/** Unconfigured vocabulary readState itself reports on a config-less HOME. */
function isUnconfigured(settings: InnerSettings | undefined): boolean {
  const providerId = settings?.model?.current?.providerId;
  return (settings?.model?.available?.length ?? 0) === 0
    && providerId !== undefined
    && providerId !== null
    && (providerId as string) === 'zcode-unconfigured';
}

export function bootstrapCatalog(runtimeFingerprint: string): ProjectedCatalog {
  return {
    catalogRevision: `zcode-bootstrap:${runtimeFingerprint}`,
    input: [{ type: 'text' }],
    configOptions: [],
    specialCatalogs: {},
    actions: [
      { id: 'sidechat.create', supported: false, reason: 'ZCode does not provide a Side Chat runtime context.' },
      { id: 'session.fork', supported: false, reason: 'ZCode does not provide a verifiable fork boundary.' },
      { id: 'session.fork.atTurn', supported: false, reason: 'ZCode does not provide a verifiable fork boundary.' },
    ],
    slashCommands: [],
  };
}

function catalogFingerprint(state: InnerReadState): string {
  return Buffer.from(JSON.stringify({
    settings: state.settings ?? {},
    slash: (state.slashCommands ?? []).map((command) => command.name ?? ''),
  }), 'utf8').toString('base64url').slice(0, 24);
}

export function revisionFor(runtimeFingerprint: string, state: InnerReadState): string {
  return `zcode:${Buffer.from(runtimeFingerprint).toString('base64url').slice(0, 12)}:${catalogFingerprint(state)}`;
}

type ModelWithRef = InnerModelInfo & {
  ref: { providerId: string; modelId: string };
};

interface CatalogSelection {
  providerId?: string;
  modelValue?: string;
}

function availableModels(settings: InnerSettings | undefined): ModelWithRef[] {
  return (settings?.model?.available ?? []).filter((model): model is ModelWithRef => (
    typeof model.ref?.providerId === 'string'
    && model.ref.providerId.length > 0
    && typeof model.ref.modelId === 'string'
    && model.ref.modelId.length > 0
  ));
}

function selectCatalogModel(
  settings: InnerSettings | undefined,
  selection: CatalogSelection,
): { providerId: string; model: ModelWithRef } {
  const models = availableModels(settings);
  const requestedRef = selection.modelValue === undefined
    ? undefined
    : decodeModelValue(selection.modelValue);
  const requestedModel = requestedRef === undefined
    ? undefined
    : models.find(model => (
        model.ref.providerId === requestedRef.providerId
        && model.ref.modelId === requestedRef.modelId
      ));
  if (requestedRef !== undefined && requestedModel === undefined) {
    throw new ConfigValueInvalidError('Model config value was not advertised.');
  }
  const current = settings?.model?.current ?? settings?.model?.lastUsed;
  const providerId = selection.providerId
    ?? requestedRef?.providerId
    ?? current?.providerId
    ?? models[0]?.ref.providerId;
  if (providerId === undefined || models.some(model => model.ref.providerId === providerId) === false) {
    throw new ConfigValueInvalidError('Provider config value was not advertised.');
  }
  const model = requestedModel?.ref.providerId === providerId
    ? requestedModel
    : models.find(candidate => (
        candidate.ref.providerId === providerId
        && candidate.ref.modelId === current?.modelId
      ))
      ?? models.find(candidate => candidate.ref.providerId === providerId);
  if (model === undefined) {
    throw new ConfigValueInvalidError(`Provider ${providerId} exposes no selectable model.`);
  }
  return { providerId, model };
}

export function projectCatalog(
  runtimeFingerprint: string,
  state: InnerReadState,
  selection: CatalogSelection = {},
): ProjectedCatalog {
  const settings = state.settings;
  if (isUnconfigured(settings)) {
    return bootstrapCatalog(runtimeFingerprint);
  }
  const revision = revisionFor(runtimeFingerprint, state);
  const models = availableModels(settings);
  const selected = selectCatalogModel(settings, selection);
  const providerChoices = new Map<string, string>();
  for (const model of models) {
    if (!providerChoices.has(model.ref.providerId)) {
      providerChoices.set(model.ref.providerId, model.providerLabel ?? model.ref.providerId);
    }
  }
  const providerOption: CatalogConfigOption = {
    id: 'provider',
    displayName: 'Provider',
    description: 'ZCode model provider for the next turn.',
    binding: 'turn',
    control: 'select',
    required: true,
    defaultValue: selected.providerId,
    choices: [...providerChoices].map(([value, displayName]) => ({ value, displayName })),
  };
  const visibleModels = models.filter(model => model.ref.providerId === selected.providerId);
  const defaultModel = encodeModelValue(selected.model.ref);

  const modelOption: CatalogConfigOption = {
    id: 'model',
    displayName: 'Model',
    description: 'ZCode model for the next turn.',
    binding: 'turn',
    control: 'select',
    required: true,
    defaultValue: defaultModel,
    choices: visibleModels
      .map((model) => {
        const ref = model.ref;
        return {
          value: encodeModelValue(ref),
          displayName: model.label ?? ref.modelId,
          ...(model.providerLabel !== undefined ? { description: model.providerLabel } : {}),
        };
      }),
  };

  const approvalOption: CatalogConfigOption = {
    id: 'approval_mode',
    displayName: 'Approval mode',
    description: 'How ZCode asks for permission before acting.',
    binding: 'turn',
    control: 'select',
    required: true,
    defaultValue: settings?.permission?.mode ?? settings?.mode?.current ?? 'build',
    choices: [
      { value: 'plan', displayName: 'Plan' },
      { value: 'build', displayName: 'Build' },
      { value: 'edit', displayName: 'Edit' },
      { value: 'yolo', displayName: 'Yolo' },
      { value: 'auto', displayName: 'Auto' },
    ],
  };

  const configOptions: CatalogConfigOption[] = [providerOption, modelOption];
  const reasoning = selected.model.reasoning;
  if (reasoning?.enabled === true) {
    const current = settings?.model?.current ?? settings?.model?.lastUsed;
    const selectedIsCurrent = current?.providerId === selected.model.ref.providerId
      && current.modelId === selected.model.ref.modelId;
    const thinkingOption: CatalogConfigOption = {
      id: 'thinking',
      displayName: 'Thinking',
      description: 'Reasoning effort for the selected model.',
      binding: 'turn',
      control: 'select',
      required: true,
      defaultValue: (selectedIsCurrent ? settings?.thoughtLevel?.current : undefined)
        ?? reasoning.defaultLevel
        ?? reasoning.levels?.[0]?.value
        ?? null,
      choices: (reasoning.levels ?? []).map((level: InnerReasoningLevel) => ({
        value: level.value,
        displayName: level.label ?? level.value,
      })),
    };
    if ((thinkingOption.choices ?? []).length > 0) {
      configOptions.push(thinkingOption);
    }
  }
  configOptions.push(approvalOption);

  return {
    catalogRevision: revision,
    input: [{ type: 'text' }],
    configOptions,
    specialCatalogs: {
      model: 'model',
      ...(configOptions.some((option) => option.id === 'thinking') ? { thinking: 'thinking' } : {}),
      approvalMode: 'approval_mode',
    },
    actions: [
      { id: 'sidechat.create', supported: false, reason: 'ZCode does not provide a Side Chat runtime context.' },
      { id: 'session.fork', supported: false, reason: 'ZCode does not provide a verifiable fork boundary.' },
      { id: 'session.fork.atTurn', supported: false, reason: 'ZCode does not provide a verifiable fork boundary.' },
    ],
    slashCommands: projectSlashCommands(state.slashCommands ?? []),
  };
}

export function projectSlashCommands(commands: InnerSlashCommand[]): ProjectedCatalog['slashCommands'] {
  const projected: ProjectedCatalog['slashCommands'] = [];
  for (const command of commands) {
    const name = typeof command.name === 'string' ? command.name.trim() : '';
    if (name === '' || name.includes(' ')) continue;
    if (command.source !== 'builtin') continue; // unverifiable source: not exposed (§7.3)
    projected.push({
      name: name.startsWith('/') ? name : `/${name}`,
      description: typeof command.description === 'string' ? command.description : '',
      source: 'builtin',
      argHints: [
        { kind: 'free', ...(typeof command.inputHint === 'string' ? { placeholder: command.inputHint } : {}) },
      ],
    });
  }
  return projected;
}

export interface ResolvedCatalog {
  catalogRevision: string;
  resolvedDefaults: { sessionConfig: Record<string, string | number | boolean | null>; turnConfig: Record<string, string | number | boolean | null> };
}

/** `catalog.resolve`: reject invalid explicit values except stale model or
 *  Thinking values made obsolete by an explicit Provider/model change. */
export function resolveCatalog(
  runtimeFingerprint: string,
  state: InnerReadState,
  input: { sessionConfig: Record<string, unknown>; turnConfig: Record<string, unknown> },
): ResolvedCatalog & ProjectedCatalog {
  if (Object.keys(input.sessionConfig).length > 0) {
    throw new ConfigValueInvalidError('ZCode v1 has no session-bound config options.');
  }
  const allowed = new Set(['provider', 'model', 'thinking', 'approval_mode']);
  for (const [key, value] of Object.entries(input.turnConfig)) {
    void value;
    if (!allowed.has(key)) {
      throw new ConfigValueInvalidError(`Unknown turn config option ${key}.`);
    }
  }
  const providerId = typeof input.turnConfig.provider === 'string'
    ? input.turnConfig.provider
    : undefined;
  const modelValue = typeof input.turnConfig.model === 'string'
    ? input.turnConfig.model
    : undefined;
  const catalog = projectCatalog(runtimeFingerprint, state, {
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelValue === undefined ? {} : { modelValue }),
  });
  const resolved: Record<string, string | number | boolean | null> = {};
  const baseline = projectCatalog(runtimeFingerprint, state);
  const baselineProvider = baseline.configOptions.find(option => option.id === 'provider')?.defaultValue;
  const baselineModel = baseline.configOptions.find(option => option.id === 'model')?.defaultValue;
  const dependencyChanged = (providerId !== undefined && providerId !== baselineProvider)
    || (modelValue !== undefined && modelValue !== baselineModel);
  const providerChangedModel = providerId !== undefined
    && modelValue !== undefined
    && decodeModelValue(modelValue).providerId !== providerId;
  for (const option of catalog.configOptions) {
    const provided = input.turnConfig[option.id];
    const valid = provided !== undefined
      && (option.choices ?? []).some((choice) => Object.is(choice.value, provided));
    const dependentStaleValue = (dependencyChanged && option.id === 'thinking')
      || (providerChangedModel && option.id === 'model');
    if (provided !== undefined && !valid && !dependentStaleValue) {
      throw new ConfigValueInvalidError(`Config option ${option.id} value was not advertised.`);
    }
    const value = valid ? provided : option.defaultValue;
    if (value !== null && value !== undefined) {
      resolved[option.id] = value as string | number | boolean | null;
    }
  }
  return {
    ...catalog,
    catalogRevision: catalog.catalogRevision,
    resolvedDefaults: {
      sessionConfig: {},
      turnConfig: resolved,
    },
  };
}
