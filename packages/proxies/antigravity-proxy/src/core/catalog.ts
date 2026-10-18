import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import type { DomainCode } from '@gian/proxy-protocol';

import type { ConfigValues, GianConfigOption } from '../contracts.js';
import { redactRuntimeData } from './mcp.js';

/**
 * Official ACP 1.3.0 keeps a model only when its id starts with `gemini`
 * (`model_selection._GEMINI_MODEL_ID_PREFIX`). The same rule applies here to
 * model selectors only. A missing or non-Gemini current value stays unset.
 * A model selector with no remaining Gemini choice is omitted: Gian select
 * options require at least one choice, and this module does not invent one.
 * Native boolean options are omitted. The frozen string setter cannot send
 * ACP `{ type: 'boolean', value: boolean }`.
 */
const GEMINI_MODEL_PREFIX = 'gemini';

export type ConfigValidationCode =
  | 'invalid_catalog'
  | 'ambiguous_config'
  | 'unknown_config'
  | 'invalid_config_value'
  | 'unavailable_model';

export class ConfigValidationError extends Error {
  readonly code: ConfigValidationCode;
  readonly configId: string;
  readonly domainCode: DomainCode;
  readonly retryable = false;

  constructor(code: ConfigValidationCode, configId: string, message: string) {
    super(message);
    this.name = 'ConfigValidationError';
    this.code = code;
    this.configId = configId;
    this.domainCode = code === 'invalid_catalog' ? 'RUNTIME_ERROR' : 'CONFIG_VALUE_INVALID';
  }
}

interface FlatChoice {
  value: string;
  name: string;
  description?: string;
}

interface NormalizedOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  control: 'select' | 'boolean';
  currentValue: string | boolean | null;
  choices: FlatChoice[];
  model: boolean;
  mode: boolean;
  effort: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isGeminiModelId(value: string): boolean {
  return value.startsWith(GEMINI_MODEL_PREFIX);
}

function isSelectChoice(value: unknown): value is SessionConfigSelectOption {
  if (!isRecord(value)) return false;
  return nonEmpty(value.value)
    && nonEmpty(value.name)
    && !Array.isArray(value.options);
}

function isSelectGroup(value: unknown): value is SessionConfigSelectGroup {
  if (!isRecord(value)) return false;
  return nonEmpty(value.group)
    && nonEmpty(value.name)
    && Array.isArray(value.options)
    && !nonEmpty(value.value);
}

function pushChoice(choices: FlatChoice[], seen: Set<string>, choice: SessionConfigSelectOption): void {
  if (seen.has(choice.value)) return;
  seen.add(choice.value);
  const next: FlatChoice = { value: choice.value, name: choice.name };
  if (nonEmpty(choice.description)) next.description = choice.description;
  choices.push(next);
}

/** Flat choices, or every nested choice under a group. Group ids are not values. */
function flattenChoices(options: unknown): FlatChoice[] | null {
  if (!Array.isArray(options)) return null;
  const choices: FlatChoice[] = [];
  const seen = new Set<string>();
  for (const entry of options) {
    if (isSelectGroup(entry)) {
      for (const nested of entry.options) {
        if (isSelectChoice(nested)) pushChoice(choices, seen, nested);
      }
      continue;
    }
    if (isSelectChoice(entry)) pushChoice(choices, seen, entry);
  }
  return choices;
}

function categoryOf(option: Record<string, unknown>): string | undefined {
  return nonEmpty(option.category) ? option.category : undefined;
}

function classify(id: string, category: string | undefined): {
  model: boolean;
  mode: boolean;
  effort: boolean;
} {
  const model = category === 'model' || (category === undefined && id === 'model');
  const mode = !model && (category === 'mode' || (category === undefined && id === 'mode'));
  const effort = !model && !mode && (
    category === 'thought_level' || (category === undefined && (id === 'thought_level' || id === 'thinking'))
  );
  return { model, mode, effort };
}

function normalizeOption(value: unknown): NormalizedOption | null {
  if (!isRecord(value)) return null;
  if (!nonEmpty(value.id) || !nonEmpty(value.name)) return null;
  const category = categoryOf(value);
  const kind = classify(value.id, category);
  const description = nonEmpty(value.description) ? value.description : undefined;
  if (value.type === 'boolean') {
    return {
      id: value.id,
      name: value.name,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      control: 'boolean',
      currentValue: null,
      choices: [],
      ...kind,
    };
  }
  if (value.type !== 'select') return null;
  const flattened = flattenChoices(value.options);
  if (flattened === null) return null;
  const choices = kind.model ? flattened.filter((choice) => isGeminiModelId(choice.value)) : flattened;
  if (!kind.model && choices.length === 0) return null;
  const current = typeof value.currentValue === 'string' && choices.some((choice) => choice.value === value.currentValue)
    ? value.currentValue
    : null;
  return {
    id: value.id,
    name: value.name,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    control: 'select',
    currentValue: current,
    choices,
    ...kind,
  };
}

function toGianOption(option: NormalizedOption): GianConfigOption {
  const binding: GianConfigOption['binding'] = option.model || option.mode || option.effort
    ? 'turn'
    : 'session';
  const projected: GianConfigOption = {
    id: option.id,
    displayName: option.name,
    binding,
    control: option.control,
    required: false,
    defaultValue: option.currentValue,
  };
  if (option.description) projected.description = option.description;
  if (option.model) projected.role = 'model';
  else if (option.effort) projected.role = 'effort';
  else if (option.mode) {
    projected.role = 'approval_mode';
    projected.modeKind = 'provider-native';
  }
  if (option.control === 'select') {
    projected.choices = option.choices.map((choice) => {
      const projectedChoice: NonNullable<GianConfigOption['choices']>[number] = {
        value: choice.value,
        displayName: choice.name,
      };
      if (choice.description) projectedChoice.description = choice.description;
      return projectedChoice;
    });
  }
  return projected;
}

function normalizedOptions(options: readonly unknown[]): NormalizedOption[] {
  const normalized: NormalizedOption[] = [];
  for (const option of options) {
    const next = normalizeOption(option);
    if (next) normalized.push(next);
  }
  return normalized;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PROJECTED_THINKING_ID = 'thinking';

interface ModelProjection {
  model: NormalizedOption;
  families: Map<string, { choice: FlatChoice; variants: Map<string, string> }>;
  variants: Map<string, { family: string; effort: string }>;
}

/** Split only an advertised, recognisable id AND label pair. Unknown/fixed
 * models (including collisions with a real base id) keep their exact identity. */
function modelProjection(options: NormalizedOption[]): ModelProjection | null {
  const models = options.filter(option => option.model && option.control === 'select');
  if (models.length !== 1 || options.some(option => option.effort || option.id === PROJECTED_THINKING_ID)) return null;
  const model = models[0]!;
  const families: ModelProjection['families'] = new Map();
  const variants: ModelProjection['variants'] = new Map();
  for (const choice of model.choices) {
    const suffix = /-(low|medium|high|xhigh|max)$/.exec(choice.value);
    const label = /^(.*?)\s*\((Low|Medium|High|XHigh|Max)\)$/i.exec(choice.name);
    if (!suffix || !label || suffix[1] !== label[2]!.toLowerCase() || !label[1]!.trim()) continue;
    const family = choice.value.slice(0, -suffix[0].length);
    if (model.choices.some(item => item.value === family)) continue;
    const group = families.get(family) ?? {
      choice: { ...choice, value: family, name: label[1]!.trim() },
      variants: new Map<string, string>(),
    };
    group.variants.set(suffix[1]!, choice.value);
    families.set(family, group);
    variants.set(choice.value, { family, effort: suffix[1]! });
  }
  return families.size ? { model, families, variants } : null;
}

function projectedSelection(projection: ModelProjection, values: ConfigValues): { family?: string; effort?: string } {
  const selected = values[projection.model.id] ?? projection.model.currentValue;
  if (typeof selected !== 'string') return {};
  const variant = projection.variants.get(selected);
  const family = variant?.family ?? selected;
  const current = typeof projection.model.currentValue === 'string'
    ? projection.variants.get(projection.model.currentValue) : undefined;
  const effort = typeof values[PROJECTED_THINKING_ID] === 'string'
    ? values[PROJECTED_THINKING_ID] as string
    : variant?.effort ?? (current?.family === family ? current.effort : undefined);
  return { family, ...(effort ? { effort } : {}) };
}

export function toGianConfigOptions(options: SessionConfigOption[], values: ConfigValues = {}): GianConfigOption[] {
  if (!Array.isArray(options)) return [];
  const normalized = normalizedOptions(options);
  const projection = modelProjection(normalized);
  const seen = new Set<string>();
  const projected: GianConfigOption[] = [];
  for (const option of normalized) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    if (option.control !== 'select' || option.choices.length === 0) continue;
    if (!projection || projection.model !== option) {
      projected.push(toGianOption(option));
      continue;
    }
    const selection = projectedSelection(projection, values);
    const choices = new Map<string, FlatChoice>();
    for (const choice of option.choices) {
      const variant = projection.variants.get(choice.value);
      const next = variant ? projection.families.get(variant.family)!.choice : choice;
      choices.set(next.value, next);
    }
    // A saved legacy id remains selectable when resolving that saved value.
    // New pickers advertise families only; no stored default is rewritten.
    const legacy = option.choices.find(choice => choice.value === values[option.id] && projection.variants.has(choice.value));
    if (legacy) choices.set(legacy.value, legacy);
    projected.push(toGianOption({ ...option, choices: [...choices.values()], currentValue: selection.family ?? null }));
    const levels = selection.family
      ? [...(projection.families.get(selection.family)?.variants.keys() ?? [])]
      : [...new Set([...projection.families.values()].flatMap(group => [...group.variants.keys()]))];
    if (levels.length) projected.push({
      id: PROJECTED_THINKING_ID, displayName: 'Thinking', role: 'effort', binding: 'turn',
      control: 'select', required: false,
      defaultValue: selection.effort && levels.includes(selection.effort) ? selection.effort : null,
      choices: EFFORTS.filter(effort => levels.includes(effort)).map(effort => ({ value: effort, displayName: effort })),
    });
  }
  return projected;
}

/** ACP 1.3.0 config_options.py contract. Cold metadata has no session from
 * which to discover modes. Live catalogs never receive these extra choices. */
export function coldModeOption(): SessionConfigOption {
  return {
    id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
    options: [
      { value: 'default', name: 'Default', description: 'Default permission prompt flow' },
      { value: 'auto_edit', name: 'Auto Edit', description: 'Auto-approve file edit tools' },
      { value: 'yolo', name: 'YOLO', description: 'Auto-approve all tools' },
    ],
  };
}

/** Canonical product values, also used by catalog.resolve. Incomplete family
 * selections may resolve choices, but can never reach a native setter/prompt. */
export function resolveConfigValues(options: SessionConfigOption[], values: ConfigValues): ConfigValues {
  return translateConfig(options, values, true).product;
}

function translateConfig(options: SessionConfigOption[], values: ConfigValues, incomplete: boolean): {
  product: ConfigValues; native: ConfigValues;
} {
  if (!Array.isArray(options) || !isRecord(values)) {
    throw new ConfigValidationError('invalid_catalog', '', 'Config options or values are not readable.');
  }
  const projection = modelProjection(normalizedOptions(options));
  const native = { ...values };
  const product = { ...values };
  if (projection && (Object.hasOwn(values, projection.model.id) || Object.hasOwn(values, PROJECTED_THINKING_ID))) {
    const id = projection.model.id;
    const selection = projectedSelection(projection, values);
    const suppliedModel = values[id];
    const legacy = typeof suppliedModel === 'string' ? projection.variants.get(suppliedModel) : undefined;
    const explicitEffort = Object.hasOwn(values, PROJECTED_THINKING_ID);
    if (legacy && explicitEffort && values[PROJECTED_THINKING_ID] !== legacy.effort) {
      throw new ConfigValidationError('invalid_config_value', PROJECTED_THINKING_ID, 'The explicit model variant conflicts with Thinking. Choose a model family to change Thinking.');
    }
    const family = selection.family ? projection.families.get(selection.family) : undefined;
    if (Object.hasOwn(values, id) && suppliedModel !== selection.family && !legacy) {
      validateNativeConfigValues(options, { [id]: suppliedModel! });
    }
    if (family) {
      if (explicitEffort && (typeof values[PROJECTED_THINKING_ID] !== 'string' || !family.variants.has(values[PROJECTED_THINKING_ID] as string))) {
        throw new ConfigValidationError('invalid_config_value', PROJECTED_THINKING_ID, 'Thinking is not advertised for the selected model family.');
      }
      const nativeId = selection.effort ? family.variants.get(selection.effort) : undefined;
      if (!nativeId && !incomplete) {
        throw new ConfigValidationError('invalid_config_value', PROJECTED_THINKING_ID, 'Choose an advertised Thinking level for the selected model family.');
      }
      delete native[PROJECTED_THINKING_ID];
      if (nativeId) native[id] = nativeId;
      else delete native[id];
      product[id] = selection.family!;
      if (selection.effort) product[PROJECTED_THINKING_ID] = selection.effort;
    } else if (explicitEffort) {
      throw new ConfigValidationError('invalid_config_value', PROJECTED_THINKING_ID, 'The selected model does not advertise adjustable Thinking.');
    }
  }
  validateNativeConfigValues(options, native);
  return { product, native };
}

function matchesChoice(option: NormalizedOption, value: unknown): value is string {
  return typeof value === 'string' && option.choices.some((choice) => choice.value === value);
}

function scrubbed(value: string): string {
  const redacted = redactRuntimeData(value);
  return typeof redacted === 'string' ? redacted : '';
}

function unavailableModelMessage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'No Gemini model is available for this selector.';
  }
  const shown = scrubbed(value);
  if (shown.length === 0) return 'No Gemini model is available for this selector.';
  return `Model '${shown}' is not an available Gemini model.`;
}

export function validateConfigValues(
  options: SessionConfigOption[],
  values: ConfigValues,
): Array<{ configId: string; value: string }> {
  return validateNativeConfigValues(options, translateConfig(options, values, false).native);
}

function validateNativeConfigValues(
  options: SessionConfigOption[],
  values: ConfigValues,
): Array<{ configId: string; value: string }> {
  if (!Array.isArray(options) || !isRecord(values)) {
    throw new ConfigValidationError('invalid_catalog', '', 'Config options or values are not readable.');
  }
  const normalized = normalizedOptions(options);
  const applied: Array<{ configId: string; value: string }> = [];
  for (const [configId, value] of Object.entries(values)) {
    const matches = normalized.filter((option) => option.id === configId);
    if (matches.length > 1) {
      throw new ConfigValidationError(
        'ambiguous_config',
        configId,
        `Config id '${scrubbed(configId)}' is declared more than once.`,
      );
    }
    const option = matches[0];
    if (option === undefined) {
      throw new ConfigValidationError(
        'unknown_config',
        configId,
        `Unknown config id '${scrubbed(configId)}'.`,
      );
    }
    if (option.control !== 'select') {
      throw new ConfigValidationError(
        'invalid_config_value',
        configId,
        `Config '${scrubbed(configId)}' is not a supported string selector.`,
      );
    }
    if (option.model && !matchesChoice(option, value)) {
      throw new ConfigValidationError('unavailable_model', configId, unavailableModelMessage(value));
    }
    if (!matchesChoice(option, value)) {
      throw new ConfigValidationError(
        'invalid_config_value',
        configId,
        `Config '${configId}' does not accept the provided value.`,
      );
    }
    applied.push({ configId, value });
  }
  return applied;
}
