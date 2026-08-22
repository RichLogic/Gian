import { GROK_PERMISSION_SPECS, type GrokPermissionMode } from './permissions.js';

export interface GrokReasoningEffort {
  id: string;
  value: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface GrokAvailableModel {
  modelId: string;
  name?: string;
  description?: string;
  _meta?: {
    supportsReasoningEffort?: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: GrokReasoningEffort[];
  };
}

export interface GrokModelState {
  currentModelId?: string;
  availableModels?: GrokAvailableModel[];
}

export interface GrokAdvertisedCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

export function modelStateFromUnknown(value: unknown): GrokModelState {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const models = Array.isArray(record.availableModels) ? record.availableModels : [];
  return {
    ...(typeof record.currentModelId === 'string' ? { currentModelId: record.currentModelId } : {}),
    availableModels: models.flatMap((item): GrokAvailableModel[] => {
      if (!item || typeof item !== 'object') return [];
      const model = item as Record<string, unknown>;
      if (typeof model.modelId !== 'string' || !model.modelId) return [];
      const parsed: GrokAvailableModel = { modelId: model.modelId };
      if (typeof model.name === 'string') parsed.name = model.name;
      if (typeof model.description === 'string') parsed.description = model.description;
      if (model._meta && typeof model._meta === 'object') {
        parsed._meta = model._meta as NonNullable<GrokAvailableModel['_meta']>;
      }
      return [parsed];
    }),
  };
}

export function commandsFromUnknown(value: unknown): GrokAdvertisedCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GrokAdvertisedCommand[] => {
    if (!item || typeof item !== 'object') return [];
    const command = item as Record<string, unknown>;
    if (typeof command.name !== 'string' || !command.name) return [];
    return [{
      name: command.name,
      ...(typeof command.description === 'string' ? { description: command.description } : {}),
      ...(command.input && typeof command.input === 'object'
        ? { input: command.input as { hint?: string } }
        : { input: null }),
    }];
  });
}

export function catalogFromModelState(
  state: GrokModelState,
  permissionMode: GrokPermissionMode = 'default',
) {
  const current = state.currentModelId ?? state.availableModels?.[0]?.modelId ?? '';
  const models = (state.availableModels ?? []).map(model => {
    const efforts = (model._meta?.reasoningEfforts ?? []).map(effort => ({
      id: effort.value || effort.id,
      displayName: effort.label || effort.value || effort.id,
      isDefault: effort.default === true
        || effort.value === model._meta?.reasoningEffort
        || effort.id === model._meta?.reasoningEffort,
    }));
    if (efforts.length > 0 && !efforts.some(effort => effort.isDefault)) {
      efforts[0]!.isDefault = true;
    }
    return {
      id: model.modelId,
      displayName: model.name || model.modelId,
      description: model.description ?? '',
      hidden: false,
      isDefault: model.modelId === current,
      efforts,
      input: ['text', 'localFile', 'localImage'] as const,
    };
  });
  return {
    models,
    modes: GROK_PERMISSION_SPECS.map(spec => ({
      id: spec.id,
      displayName: spec.displayName,
      description: spec.description,
      isDefault: spec.isDefault,
      approval: spec.approval,
      workspace: spec.workspace,
      network: spec.network,
    })),
    sessionOptions: [
      ...(models.length === 0 ? [] : [{
        id: 'model',
        displayName: 'Model',
        category: 'model',
        type: 'select' as const,
        scope: 'session' as const,
        currentValue: current || models[0]!.id,
        choices: models.map(model => ({
          value: model.id,
          displayName: model.displayName,
        })),
      }, {
        id: 'reasoning_effort',
        displayName: 'Thinking',
        category: 'reasoning_effort',
        type: 'select' as const,
        scope: 'session' as const,
        currentValue: models.find(model => model.isDefault)?.efforts.find(effort => effort.isDefault)?.id
          ?? models[0]?.efforts[0]?.id
          ?? null,
        choices: uniqueEfforts(models).map(effort => ({
          value: effort.id,
          displayName: effort.displayName,
        })),
        ...(() => {
          const enabledWhen = effortEnabledWhen(models);
          return enabledWhen ? { enabledWhen } : {};
        })(),
      }]),
      {
        id: 'permission_mode',
        displayName: 'Mode',
        category: 'mode',
        type: 'select' as const,
        scope: 'session' as const,
        currentValue: permissionMode,
        choices: GROK_PERMISSION_SPECS.map(spec => ({
          value: spec.id,
          displayName: spec.displayName,
        })),
      },
    ].filter(option => !option.choices || option.choices.length > 0),
  };
}

export function toV2ConfigOptions(
  sessionOptions: ReturnType<typeof catalogFromModelState>['sessionOptions'],
) {
  return sessionOptions.map((option) => {
    const role = option.id === 'model'
      ? 'model' as const
      : option.id === 'reasoning_effort'
        ? 'effort' as const
        : option.id === 'permission_mode'
          ? 'approval_mode' as const
          : undefined;
    return {
      id: option.id,
      displayName: option.displayName,
      binding: 'session' as const,
      ...(role ? { role } : {}),
      control: 'select' as const,
      required: false,
      defaultValue: option.currentValue ?? null,
      ...(option.choices && option.choices.length > 0 ? { choices: option.choices } : {}),
      ...('enabledWhen' in option && option.enabledWhen ? { enabledWhen: option.enabledWhen } : {}),
      ...('visibleWhen' in option && option.visibleWhen ? { visibleWhen: option.visibleWhen } : {}),
      ...('constraints' in option && option.constraints ? { constraints: option.constraints } : {}),
    };
  });
}

type ConfigCondition = { optionId: string; oneOf: Array<string | boolean | number | null> };

function effortEnabledWhen(
  models: Array<{ id: string; efforts: Array<{ id: string; displayName: string }> }>,
): ConfigCondition[] | undefined {
  const withEffort = models.filter((model) => model.efforts.length > 0);
  if (withEffort.length === 0 || withEffort.length === models.length) return undefined;
  return [{ optionId: 'model', oneOf: withEffort.map((model) => model.id) }];
}

function uniqueEfforts(models: Array<{ efforts: Array<{ id: string; displayName: string }> }>) {
  const seen = new Map<string, { id: string; displayName: string }>();
  for (const model of models) {
    for (const effort of model.efforts) {
      if (!seen.has(effort.id)) seen.set(effort.id, effort);
    }
  }
  return [...seen.values()];
}

export function effortIdsForModel(state: GrokModelState, modelId: string): string[] {
  const model = state.availableModels?.find(item => item.modelId === modelId);
  return (model?._meta?.reasoningEfforts ?? []).map(effort => effort.value || effort.id);
}
