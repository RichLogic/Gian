import type {
  Accent,
  ExternalEditor,
  ShortcutMap,
  SystemConfig,
  TerminalPreferences,
} from '@gian/shared';
import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_TERMINAL_PREFERENCES,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  SHORTCUT_ACTIONS,
  THEME_DEFAULT_ACCENT,
  isValidShortcutCombo,
} from '@gian/shared';
import type { Db } from './db.js';

const EXTERNAL_EDITORS_KEY = 'external_editors';
const OPEN_APPS_KEY = 'open_apps';
const TERMINAL_KEY = 'terminal';
const SHORTCUTS_KEY = 'shortcuts';
const OPEN_APP_CATEGORIES = ['code', 'web', 'images', 'pdf', 'other'] as const;

const VALID_CHAT_FONT_FAMILIES: ReadonlySet<SystemConfig['chat_font_family']> = new Set([
  'system', 'manrope', 'serif', 'mono',
]);
const SHORTCUT_ACTION_SET: ReadonlySet<string> = new Set(SHORTCUT_ACTIONS);

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
    stmt.run(key, String(value));
  }
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

  const rawTheme = map.get('theme') ?? '';
  const theme: SystemConfig['theme'] = VALID_THEMES.has(rawTheme as SystemConfig['theme'])
    ? (rawTheme as SystemConfig['theme'])
    : 'warm';
  const rawAccent = map.get('accent') ?? '';
  const accent: Accent = VALID_ACCENTS.has(rawAccent as Accent)
    ? (rawAccent as Accent)
    : THEME_DEFAULT_ACCENT[theme];

  return {
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
}
