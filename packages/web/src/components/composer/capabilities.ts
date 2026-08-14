import type {
  ApprovalMode,
  CcModelCapabilities,
  CodexModelCapabilities,
  Executor,
  NativeConfigChoice,
  NativeConfigOption,
  ProxyModeCapabilities,
  SlashCommand,
  SlashCommandSource,
  ThinkingEffort,
} from '@gian/shared';
import { loadProxyCapabilities, loadProxyModels, loadSlashCommands } from '../../api.js';

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

const modeCache = new Map<'claude' | 'codex', ProxyModeCapabilities[]>();
const modePromises = new Map<'claude' | 'codex', Promise<ProxyModeCapabilities[]>>();

export function getModesCached(executor: 'claude' | 'codex'): ProxyModeCapabilities[] | undefined {
  return modeCache.get(executor);
}

export function fetchModesCached(executor: 'claude' | 'codex'): Promise<ProxyModeCapabilities[]> {
  const hit = modeCache.get(executor);
  if (hit) return Promise.resolve(hit);
  const inflight = modePromises.get(executor);
  if (inflight) return inflight;
  // Defer the call so a missing/broken api export rejects instead of throwing
  // synchronously — callers treat either as "keep the built-in fallback".
  const request = Promise.resolve()
    .then(() => loadProxyCapabilities(executor))
    .then(capabilities => {
      const modes = capabilities.modes ?? [];
      modeCache.set(executor, modes);
      modePromises.delete(executor);
      return modes;
    })
    .catch(error => {
      modePromises.delete(executor);
      throw error;
    });
  modePromises.set(executor, request);
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

function slashCacheKey(executor: 'claude' | 'codex', workspaceId: string | undefined): string {
  return `${executor}:${workspaceId ?? '_'}`;
}

export function getSlashCached(
  executor: 'claude' | 'codex',
  workspaceId?: string,
): SlashCommand[] | undefined {
  return slashCache.get(slashCacheKey(executor, workspaceId));
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

export function fetchSlashCached(executor: 'claude' | 'codex', workspaceId?: string): Promise<SlashCommand[]> {
  const key = slashCacheKey(executor, workspaceId);
  const hit = slashCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = slashPromises.get(key);
  if (inflight) return inflight;
  let request: Promise<SlashCommand[]>;
  request = loadSlashCommands(executor, workspaceId)
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
  executor: 'claude' | 'codex',
  modes: ProxyModeCapabilities[] | undefined,
): ComposerModeOption[] {
  if (!modes || modes.length === 0) {
    return executor === 'codex' ? CODEX_APPROVALS : CLAUDE_MODES;
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
  executor: 'claude' | 'codex',
  mode: ApprovalMode,
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
    || category === 'reasoning_effort'
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'effort';
  if (category === 'mode' || id === 'mode' || id === 'permission_mode') return 'mode';
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
