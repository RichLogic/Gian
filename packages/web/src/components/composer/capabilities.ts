import type {
  ApprovalMode,
  CcModelCapabilities,
  CodexModelCapabilities,
  Executor,
  NativeConfigChoice,
  NativeConfigOption,
  SlashCommand,
  SlashCommandSource,
  ThinkingEffort,
} from '@gian/shared';
import { loadProxyModels, loadSlashCommands } from '../../api.js';

export type ProxyModel = CcModelCapabilities | CodexModelCapabilities;

const modelCache = new Map<'claude' | 'codex', ProxyModel[]>();
const modelPromises = new Map<'claude' | 'codex', Promise<ProxyModel[]>>();

export function getModelsCached(executor: 'claude' | 'codex'): ProxyModel[] | undefined {
  return modelCache.get(executor);
}

export function fetchModelsCached(executor: 'claude' | 'codex'): Promise<ProxyModel[]> {
  const hit = modelCache.get(executor);
  if (hit) return Promise.resolve(hit);
  const inflight = modelPromises.get(executor);
  if (inflight) return inflight;
  const request = loadProxyModels(executor)
    .then(models => {
      modelCache.set(executor, models);
      modelPromises.delete(executor);
      return models;
    })
    .catch(error => {
      modelPromises.delete(executor);
      throw error;
    });
  modelPromises.set(executor, request);
  return request;
}

export function defaultModel(models: ProxyModel[], executor: 'claude' | 'codex'): string {
  const fallback = models.find(model => model.isDefault) ?? models[0];
  return fallback?.model ?? (executor === 'codex' ? 'gpt-5-codex' : '');
}

export function modelLabel(models: ProxyModel[], id: string): string {
  return models.find(model => model.model === id)?.displayName ?? id;
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

function slashCacheKey(executor: 'claude' | 'codex', workspaceId: string | undefined): string {
  return `${executor}:${workspaceId ?? '_'}`;
}

export function getSlashCached(
  executor: 'claude' | 'codex',
  workspaceId?: string,
): SlashCommand[] | undefined {
  return slashCache.get(slashCacheKey(executor, workspaceId));
}

export function fetchSlashCached(executor: 'claude' | 'codex', workspaceId?: string): Promise<SlashCommand[]> {
  const key = slashCacheKey(executor, workspaceId);
  const hit = slashCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = slashPromises.get(key);
  if (inflight) return inflight;
  const request = loadSlashCommands(executor, workspaceId)
    .then(commands => {
      slashCache.set(key, commands);
      slashPromises.delete(key);
      return commands;
    })
    .catch(error => {
      slashPromises.delete(key);
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

export const CODEX_APPROVALS: Array<{
  key: string;
  mode: ApprovalMode;
  titleKey: string;
  descKey: string;
}> = [
  { key: 'ask', mode: 'ask', titleKey: 'composer.approval.ask.title', descKey: 'composer.approval.ask.desc' },
  { key: 'approve', mode: 'auto', titleKey: 'composer.approval.approve.title', descKey: 'composer.approval.approve.desc' },
  { key: 'full', mode: 'full-access', titleKey: 'composer.approval.full.title', descKey: 'composer.approval.full.desc' },
  { key: 'custom', mode: 'custom', titleKey: 'composer.approval.custom.title', descKey: 'composer.approval.custom.desc' },
];

export function codexApprovalLabelKey(mode: ApprovalMode): string {
  switch (mode) {
    case 'ask': return 'composer.approval.ask.title';
    case 'auto': return 'composer.approval.approve.title';
    case 'custom': return 'composer.approval.custom.title';
    case 'full-access': return 'composer.approval.full.title';
    default: return 'composer.approval.title';
  }
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
  executor: Exclude<Executor, 'kimi'>,
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
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'effort';
  if (category === 'mode' || id === 'mode') return 'mode';
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
