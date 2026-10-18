/**
 * Static settings/commands search registry (Issue #168 / 0.6.7, proposal
 * §6.3): UI-only search kinds (`setting`, `command`) are matched client-side
 * against this catalog — keyed by the REAL Settings section anchor (and, for
 * control entries, the REAL `settings-control-*` DOM id rendered with the
 * control) and the REAL keymap command id. Titles match in BOTH locales
 * regardless of the active one, plus manual aliases. Commands reuse the
 * App's keymap command dispatcher; availability is a predicate over the
 * palette context, so an unavailable command is never offered. Only commands
 * the shared dispatcher actually executes are listed.
 */
import { KEYMAP_COMMANDS, type KeymapCommand } from '@gian/shared';
import type { NavKey } from '../components/SettingsBody.js';

export interface SearchPaletteContext {
  hasActiveSession: boolean;
  workbenchActive: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  inspectorAvailable: boolean;
  browserAvailable: boolean;
}

export interface SettingSearchEntry {
  /** Stable registry id (`navKey` for sections, `section.control` for controls). */
  id: string;
  /** Real Settings section the entry deep-links into. */
  navKey: NavKey;
  /** Control-level DOM anchor (`settings-control-<control>`), rendered with
   *  the control itself. Absent → the section anchor is the target. */
  control?: string;
  /** i18n key of the section/control's own label. */
  titleKey: string;
  /** Extra manual aliases (either language), matched case-insensitively. */
  aliases: string[];
}

const SECTION_ENTRIES: readonly SettingSearchEntry[] = [
  { id: 'appearance', navKey: 'appearance', titleKey: 'settings.section.appearance', aliases: ['外观'] },
  { id: 'layout', navKey: 'layout', titleKey: 'settings.section.layout', aliases: ['布局'] },
  { id: 'keymap', navKey: 'keymap', titleKey: 'settings.section.keymap', aliases: ['shortcuts', 'hotkey', '快捷键'] },
  { id: 'executors', navKey: 'executors', titleKey: 'settings.section.executor', aliases: ['providers', 'cli', '执行器'] },
  { id: 'chat', navKey: 'chat', titleKey: 'settings.section.chat', aliases: ['聊天'] },
  { id: 'translation', navKey: 'translation', titleKey: 'translation.title', aliases: ['translate', '翻译'] },
  { id: 'files', navKey: 'files', titleKey: 'settings.section.files', aliases: ['文件'] },
  { id: 'diffs', navKey: 'diffs', titleKey: 'settings.section.diffs', aliases: ['diff', '差异'] },
  { id: 'history', navKey: 'history', titleKey: 'settings.section.history', aliases: ['git history', 'commits', '历史'] },
  { id: 'sidechat', navKey: 'sidechat', titleKey: 'settings.section.sidechat', aliases: ['side chat'] },
  { id: 'browser', navKey: 'browser', titleKey: 'settings.section.browser', aliases: ['web', '浏览器'] },
  { id: 'terminal', navKey: 'terminal', titleKey: 'settings.section.terminal', aliases: ['shell', '终端'] },
  { id: 'openwith', navKey: 'openwith', titleKey: 'settings.section.openwith', aliases: ['open with', 'editors', '打开方式', '编辑器'] },
  { id: 'archive', navKey: 'archive', titleKey: 'settings.section.archive', aliases: ['归档'] },
  { id: 'adopt', navKey: 'adopt', titleKey: 'settings.section.adopt', aliases: ['native session', '接管'] },
  { id: 'notifications', navKey: 'notifications', titleKey: 'settings.section.notifications', aliases: ['alerts', '通知', '提醒'] },
  { id: 'updates', navKey: 'updates', titleKey: 'settings.section.updates', aliases: ['upgrade', '更新', '升级'] },
  { id: 'account', navKey: 'account', titleKey: 'settings.section.account', aliases: ['sign in', 'login', '账户', '账号', '登录'] },
  { id: 'remote', navKey: 'remote', titleKey: 'settings.section.remote', aliases: ['devices', 'pairing', '远程', '设备', '配对'] },
];

/** Control-level entries: every `control` is a real `settings-control-*`
 *  anchor rendered with the control (SettingsBody / SettingsPreferencePages)
 *  — never an i18n-dictionary guess. */
const CONTROL_ENTRIES: readonly SettingSearchEntry[] = [
  { id: 'appearance.theme', navKey: 'appearance', control: 'appearance.theme', titleKey: 'settings.appearance.theme', aliases: ['theme', 'dark mode', 'light mode', '主题', '深色', '浅色'] },
  { id: 'appearance.accent', navKey: 'appearance', control: 'appearance.accent', titleKey: 'settings.appearance.accent', aliases: ['accent color', '强调色'] },
  { id: 'appearance.language', navKey: 'appearance', control: 'appearance.language', titleKey: 'settings.appearance.language', aliases: ['language', 'locale', '语言'] },
  { id: 'appearance.zoom', navKey: 'appearance', control: 'appearance.zoom', titleKey: 'settings.appearance.zoom', aliases: ['zoom', 'scale', '缩放'] },
  { id: 'appearance.frameOpacity', navKey: 'appearance', control: 'appearance.frameOpacity', titleKey: 'settings.appearance.frameOpacity', aliases: ['transparency', 'opacity', '透明度'] },
  { id: 'chat.fontSize', navKey: 'chat', control: 'chat.fontSize', titleKey: 'settings.chat.fontSize', aliases: ['font size', '字号', '字体大小'] },
  { id: 'chat.fontFamily', navKey: 'chat', control: 'chat.fontFamily', titleKey: 'settings.chat.fontFamily', aliases: ['font family', '字体'] },
  { id: 'chat.minimap', navKey: 'chat', control: 'chat.minimap', titleKey: 'settings.display.minimap.hint', aliases: ['minimap', '缩略图'] },
  { id: 'files.openOn', navKey: 'files', control: 'files.openOn', titleKey: 'settings.tool.files.openOn', aliases: ['open files in', '文件打开方式'] },
  { id: 'diffs.layout', navKey: 'diffs', control: 'diffs.layout', titleKey: 'settings.tool.diffs.layout', aliases: ['diff layout', 'split diff', '差异布局'] },
];

export const SETTINGS_SEARCH_REGISTRY: readonly SettingSearchEntry[] = [
  ...SECTION_ENTRIES,
  ...CONTROL_ENTRIES,
];

/** The DOM anchor a settings deep link scrolls to. `null` for standalone
 *  sections (archive/adopt render their own page — no scroll target). */
export function settingAnchorId(entry: SettingSearchEntry): string | null {
  if (entry.control) return `settings-control-${entry.control}`;
  return `settings-section-${entry.navKey}`;
}

export interface CommandSearchEntry {
  /** Real keymap command id — execution goes through the App dispatcher. */
  command: KeymapCommand;
  titleKey: string;
  aliases: string[];
  available: (context: SearchPaletteContext) => boolean;
}

const always = () => true;
const needsSession = (context: SearchPaletteContext) => context.hasActiveSession;

const COMMAND_AVAILABILITY: Partial<Record<KeymapCommand, (context: SearchPaletteContext) => boolean>> = {
  'layout.togglePanel3': context => context.inspectorAvailable,
  'tool.browser': context => context.browserAvailable,
  'workbench.previousTab': context => context.workbenchActive,
  'workbench.nextTab': context => context.workbenchActive,
  'workbench.closeTab': context => context.workbenchActive,
  'navigation.back': context => context.canGoBack,
  'navigation.forward': context => context.canGoForward,
  'session.sendOrSteer': needsSession,
  'session.previous': needsSession,
  'session.next': needsSession,
  'session.rename': needsSession,
  'session.later': needsSession,
  'session.archive': needsSession,
};

const COMMAND_ALIASES: Partial<Record<KeymapCommand, string[]>> = {
  'app.settings': ['preferences', 'config', '设置', '偏好'],
  'session.new': ['new conversation', '新建会话', '新会话'],
  'task.new': ['new task', '新建任务'],
  'layout.toggleSidebar': ['sidebar', '侧栏'],
  'layout.togglePanel2': ['panel', 'workbench', '面板'],
  'layout.togglePanel3': ['inspector', '检查器'],
  'tool.files': ['files', '文件'],
  'tool.diffs': ['changes', 'diff', '变更'],
  'tool.history': ['git history', 'commits', '历史'],
  'tool.sideChat': ['side chat'],
  'tool.browser': ['web', '浏览器'],
  'tool.terminal': ['shell', '终端'],
  'session.sendOrSteer': ['send', 'steer', '发送'],
  'session.previous': ['previous conversation', '上一个会话'],
  'session.next': ['next conversation', '下一个会话'],
  'navigation.back': ['back', '后退', '返回'],
  'navigation.forward': ['forward', '前进'],
  'session.rename': ['rename', '重命名'],
  'session.later': ['later', 'unread', '稍后', '未读'],
  'session.archive': ['archive', '归档'],
};

/** The palette's command catalog follows the real keymap list; the quick
 *  switcher opens this palette itself and is never a row. Every listed
 *  command is executable through the shared dispatcher
 *  (App.handleKeymapCommand) — commands only handled inside the keydown
 *  path are wired there too. */
export const COMMANDS_SEARCH_REGISTRY: readonly CommandSearchEntry[] = KEYMAP_COMMANDS
  .filter(command => command !== 'app.quickSwitcher')
  .map(command => ({
    command,
    titleKey: `settings.keymap.command.${command}`,
    aliases: COMMAND_ALIASES[command] ?? [],
    available: COMMAND_AVAILABILITY[command] ?? always,
  }));

export type RegistryMatch<T> = { entry: T; rank: number };

/**
 * Case-insensitive literal matching over EVERY locale title plus aliases —
 * a zh UI still answers to "Notifications". Rank: exact title < title
 * prefix < title substring < alias hit. Best-first. Chinese short terms
 * match by plain substring — no tokenization.
 */
export function matchRegistryEntries<T extends { titleKey: string; aliases: string[] }>(
  entries: readonly T[],
  query: string,
  titles: (entry: T) => string[],
): Array<RegistryMatch<T>> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<RegistryMatch<T>> = [];
  for (const entry of entries) {
    let rank = -1;
    for (const title of titles(entry)) {
      const titleText = title.toLowerCase();
      if (titleText === needle) rank = rank === -1 ? 0 : Math.min(rank, 0);
      else if (titleText.startsWith(needle)) rank = rank === -1 ? 1 : Math.min(rank, 1);
      else if (titleText.includes(needle)) rank = rank === -1 ? 2 : Math.min(rank, 2);
    }
    if (rank === -1 && entry.aliases.some(alias => alias.toLowerCase().includes(needle))) rank = 3;
    if (rank >= 0) matches.push({ entry, rank });
  }
  matches.sort((a, b) => a.rank - b.rank);
  return matches;
}
