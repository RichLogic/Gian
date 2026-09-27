/**
 * Catalog projection (Revision 2 §7) for ZCode CLI 0.16.9.
 *
 * `catalog.list` stays side-effect-free: `workspace/readPresentation` supplies
 * mode and slash commands, while the pinned `gian/modelCatalog` integration
 * returns allowlisted Registry metadata without creating a session or
 * exposing Provider credentials. Live snapshots may update only the current
 * selection when it still belongs to that Registry catalog.
 *
 * Outer ConfigValue stays scalar; model references use the versioned
 * reversible encoding `zmodel:v1:<base64url(JSON.stringify([providerId,
 * modelId]))>`; anything malformed is CONFIG_VALUE_INVALID.
 */

import { createHash } from 'node:crypto';
import type {
  InnerModelInfo,
  InnerPresentation,
  InnerReadState,
  InnerReasoningLevel,
  InnerSettings,
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

export interface CatalogActions {
  fork: { supported: boolean; reason?: string };
  forkAtTurn: { supported: boolean; reason?: string };
  sidechat: { supported: boolean; reason?: string };
}

/** Kept in one place so bootstrap and projected catalogs agree. */
const SIDECHAT_UNAVAILABLE_REASON = 'ZCode selection side chats inherit hidden parent context and restrict fork/retry; not a semantic Gian Side Chat.';

/** Capability truth for 0.16.9 (see README for the full evidence map):
 *  - v4 `forkAssistant` is a stable conversation-only fork (fork-edit-retry.ts:6),
 *    exposed for head and completed-turn boundaries;
 *  - upstream `createSelectionSideSession` always inherits the parent's
 *    committed context with hidden-transcript rewriting (session-fork.ts:677-693)
 *    and restricts fork/edit/retry inside the child — not semantically equal to
 *    a Gian Side Chat, so it stays unsupported;
 *  - v4 `deleteSession` is documented as closeSession ("非真删 record",
 *    session-mgmt.ts:154-158), so native delete is never declared. */
export function catalogActions(): CatalogActions {
  return {
    fork: { supported: true },
    forkAtTurn: { supported: true },
    sidechat: {
      supported: false,
      reason: SIDECHAT_UNAVAILABLE_REASON,
    },
  } as CatalogActions;
}

function actionsList(): ProjectedCatalog['actions'] {
  const actions = catalogActions();
  const list: ProjectedCatalog['actions'] = [
    { id: 'session.fork', supported: actions.fork.supported },
    { id: 'session.fork.atTurn', supported: actions.forkAtTurn.supported },
    { id: 'sidechat.create', supported: actions.sidechat.supported },
    { id: 'session.native.delete', supported: false, reason: 'ZCode deleteSession is a close: history is never purged (session-mgmt.ts:154-158).' },
  ];
  if (actions.fork.reason !== undefined) list[0]!.reason = actions.fork.reason;
  if (actions.forkAtTurn.reason !== undefined) list[1]!.reason = actions.forkAtTurn.reason;
  if (actions.sidechat.reason !== undefined) list[2]!.reason = actions.sidechat.reason;
  return list;
}

/** Unconfigured workspace: no provider account configured yet. */
function isUnconfigured(settings: InnerSettings | undefined, presentation: InnerPresentation | undefined): boolean {
  const providerId = settings?.model?.current?.providerId;
  return (settings?.model?.available?.length ?? 0) === 0
    && (presentation?.mode === undefined || presentation.mode === null)
    && (providerId === undefined || providerId === null || providerId === 'zcode-unconfigured');
}

export function bootstrapCatalog(runtimeFingerprint: string): ProjectedCatalog {
  return {
    catalogRevision: `zcode-bootstrap:${runtimeFingerprint}`,
    input: [{ type: 'text' }],
    configOptions: [],
    specialCatalogs: {},
    actions: [
      { id: 'session.fork', supported: false, reason: 'catalog.list has not run yet.' },
      { id: 'session.fork.atTurn', supported: false, reason: 'catalog.list has not run yet.' },
      { id: 'sidechat.create', supported: false, reason: SIDECHAT_UNAVAILABLE_REASON },
      { id: 'session.native.delete', supported: false, reason: 'ZCode deleteSession is a close: history is never purged (session-mgmt.ts:154-158).' },
    ],
    slashCommands: [],
  };
}

function catalogFingerprint(presentation: InnerPresentation, observed: InnerReadState | null): string {
  return createHash('sha256').update(JSON.stringify({
    mode: presentation.mode ?? '',
    slash: (presentation.slashCommands ?? []).map((command) => command.name ?? ''),
    model: observed?.settings?.model?.current ?? null,
    available: observed?.settings?.model?.available ?? [],
    thought: observed?.settings?.thoughtLevel?.current ?? null,
  })).digest('hex').slice(0, 24);
}

export function revisionFor(runtimeFingerprint: string, presentation: InnerPresentation, observed: InnerReadState | null): string {
  return `zcode:${Buffer.from(runtimeFingerprint).toString('base64url').slice(0, 12)}:${catalogFingerprint(presentation, observed)}`;
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
  if (models.length === 0) {
    throw new ConfigValueInvalidError(
      'ZCode has no configured model provider in the selected HOME.',
    );
  }
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

/** Catalog input vocabulary for 0.16.9: the v4 `sendText` payload accepts
 *  text plus `{ref,fileName,mime,bytes}` attachments (local zero-copy by
 *  absolute path), and skills activate through the canonical manual-skill
 *  prompt (slash-commands.ts:229 buildManualSkillPrompt). */
export const CATALOG_INPUT: ProjectedCatalog['input'] = [
  { type: 'text' },
  { type: 'localImage' },
  { type: 'localFile' },
  { type: 'skill' },
];

export function projectCatalog(
  runtimeFingerprint: string,
  presentation: InnerPresentation,
  observed: InnerReadState | null = null,
  selection: CatalogSelection = {},
): ProjectedCatalog {
  const settings = observed?.settings;
  if (isUnconfigured(settings, presentation)) {
    return bootstrapCatalog(runtimeFingerprint);
  }
  const revision = revisionFor(runtimeFingerprint, presentation, observed);
  const models = availableModels(settings);
  if (models.length === 0 && (selection.modelValue !== undefined || selection.providerId !== undefined)) {
    // A model/provider value cannot resolve against an empty observed market.
    throw new ConfigValueInvalidError('Model config value was not advertised.');
  }
  const configOptions: CatalogConfigOption[] = [];
  let selected: { providerId: string; model: ModelWithRef } | null = null;
  if (models.length > 0) {
    selected = selectCatalogModel(settings, selection);
    const providerChoices = new Map<string, string>();
    for (const model of models) {
      if (!providerChoices.has(model.ref.providerId)) {
        providerChoices.set(model.ref.providerId, model.providerLabel ?? model.ref.providerId);
      }
    }
    configOptions.push({
      id: 'provider',
      displayName: 'Provider',
      description: 'ZCode model provider for the next turn.',
      binding: 'turn',
      control: 'select',
      required: true,
      defaultValue: selected.providerId,
      choices: [...providerChoices].map(([value, displayName]) => ({ value, displayName })),
    });
    const visibleModels = models.filter(model => model.ref.providerId === selected!.providerId);
    configOptions.push({
      id: 'model',
      displayName: 'Model',
      description: 'ZCode model for the next turn.',
      binding: 'turn',
      control: 'select',
      required: true,
      defaultValue: encodeModelValue(selected.model.ref),
      choices: visibleModels
        .map((model) => {
          const ref = model.ref;
          return {
            value: encodeModelValue(ref),
            displayName: model.label ?? ref.modelId,
            ...(model.providerLabel !== undefined ? { description: model.providerLabel } : {}),
          };
        }),
    });

    // Thinking/Reasoning: 0.16.9 reports the model's reasoning facts on the
    // current model option and the session's full thoughtLevel list.
    const reasoning = selected.model.reasoning;
    const levels: InnerReasoningLevel[] = (reasoning?.levels ?? [])
      .filter((level) => typeof level.value === 'string' && level.value !== '');
    const thoughtChoices = (levels.length > 0 ? levels : (settings?.thoughtLevel?.available ?? []))
      .filter((level) => typeof level.value === 'string' && level.value !== '');
    if (reasoning?.enabled !== false && thoughtChoices.length > 0) {
      const current = settings?.model?.current ?? settings?.model?.lastUsed;
      const selectedIsCurrent = current?.providerId === selected.model.ref.providerId
        && current.modelId === selected.model.ref.modelId;
      // The session's thoughtLevel facts belong to the CURRENT model; a
      // different selection takes the model's own default level.
      configOptions.push({
        id: 'thinking',
        displayName: 'Thinking',
        description: 'Reasoning effort for the selected model.',
        binding: 'turn',
        control: 'select',
        required: true,
        defaultValue: (selectedIsCurrent ? settings?.thoughtLevel?.current : undefined)
          ?? reasoning?.defaultLevel
          ?? thoughtChoices[0]?.value
          ?? null,
        choices: thoughtChoices.map((level: InnerReasoningLevel) => ({
          value: level.value,
          displayName: level.label ?? level.value,
        })),
      });
    }
  }

  const currentMode = presentation.mode ?? settings?.permission?.mode ?? 'build';
  configOptions.push({
    id: 'approval_mode',
    displayName: 'Approval mode',
    description: 'How ZCode asks for permission before acting.',
    binding: 'turn',
    control: 'select',
    required: true,
    defaultValue: currentMode,
    choices: [
      { value: 'plan', displayName: 'Plan' },
      { value: 'build', displayName: 'Build' },
      { value: 'edit', displayName: 'Edit' },
      { value: 'yolo', displayName: 'Yolo' },
    ],
  });

  return {
    catalogRevision: revision,
    input: CATALOG_INPUT,
    configOptions,
    specialCatalogs: {
      ...(models.length > 0 ? { model: 'model' } : {}),
      ...(configOptions.some((option) => option.id === 'thinking') ? { thinking: 'thinking' } : {}),
      approvalMode: 'approval_mode',
    },
    actions: actionsList(),
    slashCommands: projectSlashCommands(presentation.slashCommands ?? []),
  };
}

export function projectSlashCommands(commands: InnerPresentation['slashCommands']): ProjectedCatalog['slashCommands'] {
  const projected: ProjectedCatalog['slashCommands'] = [];
  for (const command of commands ?? []) {
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
  presentation: InnerPresentation,
  observed: InnerReadState | null,
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
  const catalog = projectCatalog(runtimeFingerprint, presentation, observed, {
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelValue === undefined ? {} : { modelValue }),
  });
  const resolved: Record<string, string | number | boolean | null> = {};
  const baseline = projectCatalog(runtimeFingerprint, presentation, observed);
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
