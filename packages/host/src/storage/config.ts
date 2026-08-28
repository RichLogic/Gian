import type {
  Accent,
  ExternalEditor,
  KeymapPreferences,
  LayoutPreferences,
  ShortcutMap,
  SystemConfig,
  TerminalPreferences,
  ToolPreferences,
} from '@gian/shared';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
  KEYMAP_COMMANDS,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  SHORTCUT_ACTIONS,
  THEME_DEFAULT_ACCENT,
  isValidKeymapBinding,
  isValidShortcutCombo,
} from '@gian/shared';
import type { Db } from './db.js';

const EXTERNAL_EDITORS_KEY = 'external_editors';
const OPEN_APPS_KEY = 'open_apps';
const TERMINAL_KEY = 'terminal';
const SHORTCUTS_KEY = 'shortcuts';
const KEYMAP_KEY = 'keymap';
const LAYOUT_KEY = 'layout';
const TOOLS_KEY = 'tools';
const OPEN_APP_CATEGORIES = ['code', 'web', 'images', 'pdf', 'other'] as const;

const SETTINGS_FILE_SCHEMA_VERSION = 1;
let userSettingsPath: string | null = null;
let lastValidFile: Partial<SystemConfig> | null = null;

/** Host bootstrap sets the resolved data directory once. Tests that exercise
 *  config in isolation intentionally leave this unset and remain DB-only. */
export function configureUserSettingsFile(dataDir: string): void {
  userSettingsPath = join(dataDir, 'settings.json');
  lastValidFile = null;
}

const VALID_CHAT_FONT_FAMILIES: ReadonlySet<SystemConfig['chat_font_family']> = new Set([
  'system', 'manrope', 'serif', 'mono',
]);
const SHORTCUT_ACTION_SET: ReadonlySet<string> = new Set(SHORTCUT_ACTIONS);
const KEYMAP_COMMAND_SET: ReadonlySet<string> = new Set(KEYMAP_COMMANDS);

const VALID_ACCENTS: ReadonlySet<Accent> = new Set([
  'rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum',
]);
const VALID_THEMES: ReadonlySet<SystemConfig['theme']> = new Set(['light', 'warm', 'dark']);
const VALID_TERMINAL_FONT_FAMILIES = new Set<TerminalPreferences['font_family']>([
  'jetbrains-mono', 'system-mono', 'sf-mono', 'menlo',
]);
const VALID_TERMINAL_CURSOR_STYLES = new Set<TerminalPreferences['cursor_style']>([
  'block', 'bar', 'underline',
]);
const VALID_TERMINAL_SCROLLBACK = new Set<TerminalPreferences['scrollback_lines']>([
  1_000, 5_000, 10_000, 50_000,
]);
const VALID_TERMINAL_START_DIRECTORIES = new Set<TerminalPreferences['start_directory']>([
  'context', 'home',
]);

function sanitizeChatFontSize(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= MIN_CHAT_FONT_SIZE && value <= MAX_CHAT_FONT_SIZE
    ? value
    : DEFAULT_CHAT_FONT_SIZE;
}

function sanitizeChatFontFamily(raw: string | undefined): SystemConfig['chat_font_family'] {
  return raw && VALID_CHAT_FONT_FAMILIES.has(raw as SystemConfig['chat_font_family'])
    ? (raw as SystemConfig['chat_font_family'])
    : 'system';
}

/** Keep only known actions with valid combo strings. Mirrors the load-side
 *  validation so save and load agree on the shape. */
export function sanitizeShortcuts(raw: unknown): ShortcutMap {
  const out: ShortcutMap = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [action, combo] of Object.entries(raw as Record<string, unknown>)) {
      if (!SHORTCUT_ACTION_SET.has(action)) continue;
      if (!isValidShortcutCombo(combo)) continue;
      out[action as keyof ShortcutMap] = combo;
    }
  }
  return out;
}

export function sanitizeKeymap(raw: unknown): KeymapPreferences {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const bindingsRaw = record.bindings && typeof record.bindings === 'object'
    && !Array.isArray(record.bindings)
    ? record.bindings as Record<string, unknown>
    : {};
  const bindings: KeymapPreferences['bindings'] = {};
  for (const [command, binding] of Object.entries(bindingsRaw)) {
    if (!KEYMAP_COMMAND_SET.has(command)) continue;
    if (binding === null || isValidKeymapBinding(binding)) {
      bindings[command as keyof KeymapPreferences['bindings']] = binding;
    }
  }
  return { preset: 'default', bindings };
}

function finiteNumber(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(min, Math.min(max, raw))
    : fallback;
}

export function sanitizeLayoutPreferences(raw: unknown): LayoutPreferences {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const defaults = DEFAULT_LAYOUT_PREFERENCES;
  return {
    sidebar_width: finiteNumber(record.sidebar_width, defaults.sidebar_width, 200, 480),
    sidebar_start_collapsed: typeof record.sidebar_start_collapsed === 'boolean'
      ? record.sidebar_start_collapsed
      : defaults.sidebar_start_collapsed,
    main_panel_ratio: finiteNumber(record.main_panel_ratio, defaults.main_panel_ratio, 0.25, 0.75),
    inspector_width: finiteNumber(record.inspector_width, defaults.inspector_width, 220, 500),
    inspector_auto_open: typeof record.inspector_auto_open === 'boolean'
      ? record.inspector_auto_open
      : defaults.inspector_auto_open,
    remember_sizes: typeof record.remember_sizes === 'boolean'
      ? record.remember_sizes
      : defaults.remember_sizes,
  };
}

function objectRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], fallback: T): T {
  return typeof raw === 'string' && values.includes(raw as T) ? raw as T : fallback;
}

export function sanitizeToolPreferences(raw: unknown): ToolPreferences {
  const record = objectRecord(raw);
  const files = objectRecord(record.files);
  const diffs = objectRecord(record.diffs);
  const history = objectRecord(record.history);
  const sideChat = objectRecord(record.side_chat);
  const browser = objectRecord(record.browser);
  const terminal = objectRecord(record.terminal);
  const defaults = DEFAULT_TOOL_PREFERENCES;
  return {
    files: {
      compact_folders: bool(files.compact_folders, defaults.files.compact_folders),
      show_hidden_files: bool(files.show_hidden_files, defaults.files.show_hidden_files),
      show_ignored_files: bool(files.show_ignored_files, defaults.files.show_ignored_files),
      reveal_active_file: bool(files.reveal_active_file, defaults.files.reveal_active_file),
      open_on: oneOf(files.open_on, ['single-click', 'double-click'], defaults.files.open_on),
      word_wrap: bool(files.word_wrap, defaults.files.word_wrap),
    },
    diffs: {
      layout: oneOf(diffs.layout, ['split', 'stacked'], defaults.diffs.layout),
      word_wrap: bool(diffs.word_wrap, defaults.diffs.word_wrap),
      default_scope: oneOf(diffs.default_scope, ['all', 'last-turn'], defaults.diffs.default_scope),
    },
    history: {
      show_graph: bool(history.show_graph, defaults.history.show_graph),
      default_ref: oneOf(history.default_ref, ['current', 'all'], defaults.history.default_ref),
      date_format: oneOf(history.date_format, ['relative', 'absolute'], defaults.history.date_format),
      single_click_preview: bool(history.single_click_preview, defaults.history.single_click_preview),
    },
    side_chat: {
      open_after_create: bool(sideChat.open_after_create, defaults.side_chat.open_after_create),
      confirm_before_close: bool(sideChat.confirm_before_close, defaults.side_chat.confirm_before_close),
    },
    browser: {
      home_page: typeof browser.home_page === 'string'
        ? browser.home_page.slice(0, 4_096)
        : defaults.browser.home_page,
      restore_last_page: bool(browser.restore_last_page, defaults.browser.restore_last_page),
      external_links: oneOf(browser.external_links, ['gian', 'system'], defaults.browser.external_links),
    },
    terminal: {
      option_as_meta: bool(terminal.option_as_meta, defaults.terminal.option_as_meta),
      copy_on_selection: bool(terminal.copy_on_selection, defaults.terminal.copy_on_selection),
      bell: bool(terminal.bell, defaults.terminal.bell),
      shell_integration: bool(terminal.shell_integration, defaults.terminal.shell_integration),
    },
  };
}

function parseUserSettingsFile(): Partial<SystemConfig> {
  if (!userSettingsPath || !existsSync(userSettingsPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(userSettingsPath, 'utf8')) as Record<string, unknown>;
    const parsed: Partial<SystemConfig> = {};
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== SETTINGS_FILE_SCHEMA_VERSION) {
      throw new Error(`unsupported settings schemaVersion: ${String(raw.schemaVersion)}`);
    }
    if (typeof raw.workspace_root === 'string' && raw.workspace_root.trim()) {
      parsed.workspace_root = raw.workspace_root;
    }
    if (typeof raw.theme === 'string' && VALID_THEMES.has(raw.theme as SystemConfig['theme'])) {
      parsed.theme = raw.theme as SystemConfig['theme'];
    }
    if (typeof raw.accent === 'string' && VALID_ACCENTS.has(raw.accent as Accent)) {
      parsed.accent = raw.accent as Accent;
    }
    if (raw.chat_font_size !== undefined) {
      parsed.chat_font_size = sanitizeChatFontSize(String(raw.chat_font_size));
    }
    if (raw.chat_font_family !== undefined) {
      parsed.chat_font_family = sanitizeChatFontFamily(String(raw.chat_font_family));
    }
    if (raw.locale === 'zh-CN' || raw.locale === 'en') parsed.locale = raw.locale;
    if (raw.keymap !== undefined) parsed.keymap = sanitizeKeymap(raw.keymap);
    if (raw.layout !== undefined) parsed.layout = sanitizeLayoutPreferences(raw.layout);
    if (raw.tools !== undefined) parsed.tools = sanitizeToolPreferences(raw.tools);
    if (raw.terminal !== undefined) parsed.terminal = sanitizeTerminalPreferences(raw.terminal);
    if (raw.external_editors !== undefined) parsed.external_editors = sanitizeEditors(raw.external_editors);
    if (raw.open_apps !== undefined) parsed.open_apps = sanitizeOpenApps(raw.open_apps);
    lastValidFile = parsed;
    return parsed;
  } catch (error) {
    console.warn('[gian] settings.json is invalid; keeping the last valid settings:',
      error instanceof Error ? error.message : String(error));
    return lastValidFile ?? {};
  }
}

function userSettingsDocument(config: SystemConfig): Record<string, unknown> {
  return {
    schemaVersion: SETTINGS_FILE_SCHEMA_VERSION,
    workspace_root: config.workspace_root,
    theme: config.theme,
    accent: config.accent,
    locale: config.locale,
    chat_font_size: config.chat_font_size,
    chat_font_family: config.chat_font_family,
    keymap: config.keymap ?? sanitizeKeymap(undefined),
    layout: config.layout ?? { ...DEFAULT_LAYOUT_PREFERENCES },
    tools: config.tools ?? structuredClone(DEFAULT_TOOL_PREFERENCES),
    terminal: config.terminal,
    external_editors: config.external_editors,
    open_apps: config.open_apps ?? {},
  };
}

function writeUserSettingsFile(config: SystemConfig): void {
  if (!userSettingsPath) return;
  const temporary = `${userSettingsPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(userSettingsDocument(config), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, userSettingsPath);
  lastValidFile = {
    keymap: config.keymap,
    layout: config.layout,
    tools: config.tools,
    terminal: config.terminal,
  };
}

export function ensureUserSettingsFile(config: SystemConfig): void {
  if (userSettingsPath && !existsSync(userSettingsPath)) writeUserSettingsFile(config);
}

export function loadPasswordHash(db: Db): string {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auth_password_hash') as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

export function savePasswordHash(db: Db, hash: string): void {
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('auth_password_hash', ?)`).run(hash);
}

function isValidEditor(e: unknown): e is ExternalEditor {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return false;
  if (typeof o.command !== 'string' || o.command.length === 0) return false;
  if (!Array.isArray(o.args)) return false;
  if (!o.args.every(a => typeof a === 'string')) return false;
  return true;
}

function sanitizeEditors(raw: unknown): ExternalEditor[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ExternalEditor[] = [];
  for (const e of raw) {
    if (!isValidEditor(e)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      name: e.name.trim().slice(0, 64),
      command: e.command,
      args: e.args,
    });
  }
  return out;
}

/** Keep only the five known categories with non-empty string values. Mirrors
 *  the load-side validation so save and load agree on the shape. */
function sanitizeOpenApps(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const k of OPEN_APP_CATEGORIES) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
  }
  return out;
}

export function sanitizeTerminalPreferences(raw: unknown): TerminalPreferences {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const defaults = DEFAULT_TERMINAL_PREFERENCES;
  const fontSize = record.font_size;
  const lineHeight = record.line_height;
  const shell = record.shell;
  return {
    font_family: VALID_TERMINAL_FONT_FAMILIES.has(
      record.font_family as TerminalPreferences['font_family'],
    )
      ? record.font_family as TerminalPreferences['font_family']
      : defaults.font_family,
    font_size: typeof fontSize === 'number'
      && Number.isInteger(fontSize)
      && fontSize >= 10
      && fontSize <= 22
      ? fontSize
      : defaults.font_size,
    line_height: typeof lineHeight === 'number'
      && Number.isFinite(lineHeight)
      && lineHeight >= 1
      && lineHeight <= 1.6
      ? lineHeight
      : defaults.line_height,
    cursor_style: VALID_TERMINAL_CURSOR_STYLES.has(
      record.cursor_style as TerminalPreferences['cursor_style'],
    )
      ? record.cursor_style as TerminalPreferences['cursor_style']
      : defaults.cursor_style,
    cursor_blink: typeof record.cursor_blink === 'boolean'
      ? record.cursor_blink
      : defaults.cursor_blink,
    scrollback_lines: VALID_TERMINAL_SCROLLBACK.has(
      record.scrollback_lines as TerminalPreferences['scrollback_lines'],
    )
      ? record.scrollback_lines as TerminalPreferences['scrollback_lines']
      : defaults.scrollback_lines,
    shell: typeof shell === 'string' && shell.length <= 4_096 ? shell : defaults.shell,
    start_directory: VALID_TERMINAL_START_DIRECTORIES.has(
      record.start_directory as TerminalPreferences['start_directory'],
    )
      ? record.start_directory as TerminalPreferences['start_directory']
      : defaults.start_directory,
  };
}

export function saveConfig(db: Db, partial: Partial<SystemConfig>): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(partial) as [keyof SystemConfig, SystemConfig[keyof SystemConfig]][]) {
    // Kept in the wire model for backward compatibility, but these appearance
    // choices were retired in 0.3.0. Ignore stale clients and always render
    // Cozy with MD interface/code text. `font_scale_chat` joined them when the
    // chat font became a concrete px size (`chat_font_size`).
    if (key === 'density' || key === 'font_scale_chrome' || key === 'font_scale_code'
      || key === 'font_scale_chat') {
      continue;
    }
    if (key === EXTERNAL_EDITORS_KEY) {
      const cleaned = sanitizeEditors(value);
      stmt.run(key, JSON.stringify(cleaned));
      continue;
    }
    if (key === OPEN_APPS_KEY) {
      // open_apps is an object — it MUST be JSON-serialized, not coerced via
      // String() (which yields "[object Object]" and then fails JSON.parse on
      // load, silently resetting the user's choice to {}).
      stmt.run(key, JSON.stringify(sanitizeOpenApps(value)));
      continue;
    }
    if (key === TERMINAL_KEY) {
      stmt.run(key, JSON.stringify(sanitizeTerminalPreferences(value)));
      continue;
    }
    if (key === SHORTCUTS_KEY) {
      stmt.run(key, JSON.stringify(sanitizeShortcuts(value)));
      continue;
    }
    if (key === KEYMAP_KEY) {
      stmt.run(key, JSON.stringify(sanitizeKeymap(value)));
      continue;
    }
    if (key === LAYOUT_KEY) {
      stmt.run(key, JSON.stringify(sanitizeLayoutPreferences(value)));
      continue;
    }
    if (key === TOOLS_KEY) {
      stmt.run(key, JSON.stringify(sanitizeToolPreferences(value)));
      continue;
    }
    stmt.run(key, String(value));
  }
  if (userSettingsPath) writeUserSettingsFile({ ...loadConfig(db), ...partial });
}

export function loadConfig(db: Db): SystemConfig {
  const rows = db.prepare('SELECT key, value FROM config').all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map(r => [r.key, r.value]));

  let externalEditors: ExternalEditor[] = [];
  const rawEditors = map.get(EXTERNAL_EDITORS_KEY);
  if (rawEditors) {
    try {
      externalEditors = sanitizeEditors(JSON.parse(rawEditors));
    } catch {
      externalEditors = [];
    }
  }

  let openApps: SystemConfig['open_apps'] = {};
  const rawOpenApps = map.get(OPEN_APPS_KEY);
  if (rawOpenApps) {
    try {
      openApps = sanitizeOpenApps(JSON.parse(rawOpenApps));
    } catch {
      openApps = {};
    }
  }

  let terminal = { ...DEFAULT_TERMINAL_PREFERENCES };
  const rawTerminal = map.get(TERMINAL_KEY);
  if (rawTerminal) {
    try {
      terminal = sanitizeTerminalPreferences(JSON.parse(rawTerminal));
    } catch {
      terminal = { ...DEFAULT_TERMINAL_PREFERENCES };
    }
  }

  let shortcuts: ShortcutMap = {};
  const rawShortcuts = map.get(SHORTCUTS_KEY);
  if (rawShortcuts) {
    try {
      shortcuts = sanitizeShortcuts(JSON.parse(rawShortcuts));
    } catch {
      shortcuts = {};
    }
  }

  let keymap = sanitizeKeymap(undefined);
  const rawKeymap = map.get(KEYMAP_KEY);
  if (rawKeymap) {
    try {
      keymap = sanitizeKeymap(JSON.parse(rawKeymap));
    } catch {
      keymap = sanitizeKeymap(undefined);
    }
  } else if (Object.keys(shortcuts).length > 0) {
    // One-way compatibility bridge from the retired provider-specific map.
    keymap = {
      preset: 'default',
      bindings: {
        ...(shortcuts.commandPalette ? { 'app.quickSwitcher': shortcuts.commandPalette } : {}),
        ...(shortcuts.steerOrSendNow ? { 'session.sendOrSteer': shortcuts.steerOrSendNow } : {}),
        ...(shortcuts.markUnread ? { 'session.later': shortcuts.markUnread } : {}),
      },
    };
  }

  let layout = { ...DEFAULT_LAYOUT_PREFERENCES };
  const rawLayout = map.get(LAYOUT_KEY);
  if (rawLayout) {
    try { layout = sanitizeLayoutPreferences(JSON.parse(rawLayout)); } catch { /* defaults */ }
  }

  let tools = structuredClone(DEFAULT_TOOL_PREFERENCES) as ToolPreferences;
  const rawTools = map.get(TOOLS_KEY);
  if (rawTools) {
    try { tools = sanitizeToolPreferences(JSON.parse(rawTools)); } catch { /* defaults */ }
  }

  const rawTheme = map.get('theme') ?? '';
  const theme: SystemConfig['theme'] = VALID_THEMES.has(rawTheme as SystemConfig['theme'])
    ? (rawTheme as SystemConfig['theme'])
    : 'warm';
  const rawAccent = map.get('accent') ?? '';
  const accent: Accent = VALID_ACCENTS.has(rawAccent as Accent)
    ? (rawAccent as Accent)
    : THEME_DEFAULT_ACCENT[theme];

  const stored: SystemConfig = {
    host: process.env.GIAN_HOST ?? map.get('host') ?? '127.0.0.1',
    port: Number(process.env.GIAN_PORT ?? map.get('port') ?? 8990),
    workspace_root: map.get('workspace_root') ?? '~/Coding',
    theme,
    accent,
    density: 'cozy',
    font_scale_chrome: 'md',
    font_scale_chat: 'md',
    font_scale_code: 'md',
    chat_font_size: sanitizeChatFontSize(map.get('chat_font_size')),
    chat_font_family: sanitizeChatFontFamily(map.get('chat_font_family')),
    shortcuts,
    keymap,
    layout,
    tools,
    terminal,
    locale: (map.get('locale') ?? 'zh-CN') as SystemConfig['locale'],
    default_claude_model: map.get('default_claude_model') ?? '',
    default_claude_effort: map.get('default_claude_effort') ?? '',
    default_codex_model: map.get('default_codex_model') ?? '',
    default_codex_effort: map.get('default_codex_effort') ?? '',
    auth_username: map.get('auth_username') ?? '',
    external_editors: externalEditors,
    open_apps: openApps,
  };
  const file = parseUserSettingsFile();
  const effectiveTheme = file.theme ?? stored.theme;
  return {
    ...stored,
    ...file,
    theme: effectiveTheme,
    accent: file.accent ?? (file.theme ? THEME_DEFAULT_ACCENT[effectiveTheme] : stored.accent),
  };
}
