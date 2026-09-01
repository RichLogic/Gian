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

export function projectCatalog(runtimeFingerprint: string, state: InnerReadState): ProjectedCatalog {
  const settings = state.settings;
  if (isUnconfigured(settings)) {
    return bootstrapCatalog(runtimeFingerprint);
  }
  const revision = revisionFor(runtimeFingerprint, state);
  const models = settings?.model?.available ?? [];
  const current = settings?.model?.current
    ?? settings?.model?.lastUsed
    ?? models[0]?.ref;

  const defaultModel = current?.providerId !== undefined && current?.modelId !== undefined
    ? encodeModelValue({ providerId: current.providerId, modelId: current.modelId })
    : models[0]?.ref?.providerId !== undefined && models[0]?.ref?.modelId !== undefined
      ? encodeModelValue({ providerId: models[0].ref.providerId, modelId: models[0].ref.modelId })
      : null;

  const modelOption: CatalogConfigOption = {
    id: 'model',
    displayName: 'Model',
    description: 'ZCode model for the next turn.',
    binding: 'turn',
    control: 'select',
    required: true,
    defaultValue: defaultModel,
    choices: models
      .filter((model) => model.ref?.providerId !== undefined && model.ref?.modelId !== undefined)
      .map((model) => {
        const ref = model.ref as { providerId: string; modelId: string };
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

  const configOptions: CatalogConfigOption[] = [modelOption];
  const currentModel = models.find((model) => model.ref?.providerId === current?.providerId
    && model.ref?.modelId === current?.modelId);
  const reasoning = currentModel?.reasoning;
  if (reasoning?.enabled === true) {
    const thinkingOption: CatalogConfigOption = {
      id: 'thinking',
      displayName: 'Thinking',
      description: 'Reasoning effort for the selected model.',
      binding: 'turn',
      control: 'select',
      required: true,
      defaultValue: settings?.thoughtLevel?.current
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

/** `catalog.resolve`: fill defaults ONLY for missing keys; an explicit value
 *  that is invalid must fail with CONFIG_VALUE_INVALID (§7.2). */
export function resolveCatalog(
  catalog: ProjectedCatalog,
  input: { sessionConfig: Record<string, unknown>; turnConfig: Record<string, unknown> },
): ResolvedCatalog {
  const resolved: Record<string, string | number | boolean | null> = {};
  for (const option of catalog.configOptions) {
    if (option.binding !== 'turn') continue;
    const provided = input.turnConfig[option.id];
    if (provided !== undefined) {
      if (option.control === 'select') {
        const valid = (option.choices ?? []).some((choice) => Object.is(choice.value, provided));
        if (!valid) throw new ConfigValueInvalidError(`Config option ${option.id} value was not advertised.`);
      } else if (option.control === 'boolean' && typeof provided !== 'boolean') {
        throw new ConfigValueInvalidError(`Config option ${option.id} must be boolean.`);
      } else if (option.control === 'number' && typeof provided !== 'number') {
        throw new ConfigValueInvalidError(`Config option ${option.id} must be number.`);
      } else if (option.control === 'text' && typeof provided !== 'string') {
        throw new ConfigValueInvalidError(`Config option ${option.id} must be text.`);
      }
      resolved[option.id] = provided as string | number | boolean | null;
      continue;
    }
    if (option.defaultValue !== null && option.defaultValue !== undefined) {
      resolved[option.id] = option.defaultValue;
    }
  }
  for (const [key, value] of Object.entries(input.turnConfig)) {
    if (catalog.configOptions.some((option) => option.id === key) === false) {
      throw new ConfigValueInvalidError(`Unknown turn config option ${key}.`);
    }
  }
  return {
    catalogRevision: catalog.catalogRevision,
    resolvedDefaults: {
      sessionConfig: {},
      turnConfig: resolved,
    },
  };
}
