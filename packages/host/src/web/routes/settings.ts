import type { Hono } from 'hono';
import type {
  ExternalEditor,
  OpenAppPrefs,
  ShortcutMap,
  SystemConfig,
  TerminalPreferences,
} from '@gian/shared';
import {
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  SHORTCUT_ACTIONS,
  isValidShortcutCombo,
} from '@gian/shared';
import { loadConfig, saveConfig } from '../../storage/config.js';
import type { Db } from '../../storage/db.js';
import { isAvailableTerminalShell, terminalOptions } from '../../term/manager.js';

type EditableSettingsKey =
  | 'port'
  | 'theme'
  | 'accent'
  | 'density'
  | 'font_scale_chrome'
  | 'font_scale_chat'
  | 'font_scale_code'
  | 'chat_font_size'
  | 'chat_font_family'
  | 'shortcuts'
  | 'terminal'
  | 'locale'
  | 'external_editors'
  | 'open_apps';

type EditableSettingsPatch = Partial<Pick<SystemConfig, EditableSettingsKey>>;
type FieldParser = (value: unknown, field: string) => unknown;

const MAX_EDITORS = 64;
const MAX_EDITOR_ID_LENGTH = 128;
const MAX_EDITOR_NAME_LENGTH = 64;
const MAX_EDITOR_COMMAND_LENGTH = 4_096;
const MAX_EDITOR_ARGS = 128;
const MAX_EDITOR_ARG_LENGTH = 4_096;
const MAX_OPEN_APP_LENGTH = 256;
const MAX_TERMINAL_SHELL_LENGTH = 4_096;

const EDITOR_FIELDS = new Set(['id', 'name', 'command', 'args']);
const OPEN_APP_CATEGORIES = new Set(['code', 'web', 'images', 'pdf', 'other']);
const SHORTCUT_ACTION_SET = new Set<string>(SHORTCUT_ACTIONS);
const TERMINAL_FIELDS = new Set([
  'font_family',
  'font_size',
  'line_height',
  'cursor_style',
  'cursor_blink',
  'scrollback_lines',
  'shell',
  'start_directory',
]);

function parseString(
  value: unknown,
  field: string,
  options: { maxLength: number; allowEmpty?: boolean },
): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (value.length > options.maxLength) {
    throw new Error(`${field} must be at most ${options.maxLength} characters`);
  }
  return value;
}

function parseEnum(value: unknown, field: string, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function parseEditors(value: unknown): ExternalEditor[] {
  if (!Array.isArray(value)) throw new Error('external_editors must be an array');
  if (value.length > MAX_EDITORS) {
    throw new Error(`external_editors must contain at most ${MAX_EDITORS} entries`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const field = `external_editors[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${field} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const unknownField = Object.keys(record).find(key => !EDITOR_FIELDS.has(key));
    if (unknownField) throw new Error(`${field}.${unknownField} is not allowed`);

    const id = parseString(record.id, `${field}.id`, { maxLength: MAX_EDITOR_ID_LENGTH });
    const name = parseString(record.name, `${field}.name`, { maxLength: MAX_EDITOR_NAME_LENGTH });
    const command = parseString(record.command, `${field}.command`, {
      maxLength: MAX_EDITOR_COMMAND_LENGTH,
    });
    if (!Array.isArray(record.args)) throw new Error(`${field}.args must be an array`);
    if (record.args.length > MAX_EDITOR_ARGS) {
      throw new Error(`${field}.args must contain at most ${MAX_EDITOR_ARGS} entries`);
    }
    const args = record.args.map((arg, argIndex) => parseString(
      arg,
      `${field}.args[${argIndex}]`,
      { maxLength: MAX_EDITOR_ARG_LENGTH, allowEmpty: true },
    ));
    if (seen.has(id)) throw new Error(`${field}.id must be unique`);
    seen.add(id);
    return { id, name, command, args };
  });
}

function parseShortcuts(value: unknown): ShortcutMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('shortcuts must be an object');
  }
  const parsed: ShortcutMap = {};
  for (const [action, combo] of Object.entries(value)) {
    if (!SHORTCUT_ACTION_SET.has(action)) {
      throw new Error(`shortcuts.${action} is not a remappable action`);
    }
    if (!isValidShortcutCombo(combo)) {
      throw new Error(`shortcuts.${action} is not a valid key combo`);
    }
    parsed[action as keyof ShortcutMap] = combo;
  }
  return parsed;
}

function parseOpenApps(value: unknown): OpenAppPrefs {  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('open_apps must be an object');
  }
  const parsed: Record<string, string> = {};
  for (const [category, target] of Object.entries(value)) {
    if (!OPEN_APP_CATEGORIES.has(category)) {
      throw new Error(`open_apps.${category} is not allowed`);
    }
    parsed[category] = parseString(target, `open_apps.${category}`, {
      maxLength: MAX_OPEN_APP_LENGTH,
      allowEmpty: true,
    });
  }
  return parsed as OpenAppPrefs;
}

function parseTerminalPreferences(value: unknown): TerminalPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('terminal must be an object');
  }
  const record = value as Record<string, unknown>;
  const unknownField = Object.keys(record).find(key => !TERMINAL_FIELDS.has(key));
  if (unknownField) throw new Error(`terminal.${unknownField} is not allowed`);
  const missingField = [...TERMINAL_FIELDS].find(key => !Object.hasOwn(record, key));
  if (missingField) throw new Error(`terminal.${missingField} is required`);

  if (typeof record.font_size !== 'number'
    || !Number.isInteger(record.font_size)
    || record.font_size < 10
    || record.font_size > 22) {
    throw new Error('terminal.font_size must be an integer between 10 and 22');
  }
  if (typeof record.line_height !== 'number'
    || !Number.isFinite(record.line_height)
    || record.line_height < 1
    || record.line_height > 1.6) {
    throw new Error('terminal.line_height must be between 1 and 1.6');
  }
  if (typeof record.cursor_blink !== 'boolean') {
    throw new Error('terminal.cursor_blink must be a boolean');
  }
  if (typeof record.scrollback_lines !== 'number'
    || ![1_000, 5_000, 10_000, 50_000].includes(record.scrollback_lines)) {
    throw new Error('terminal.scrollback_lines must be one of: 1000, 5000, 10000, 50000');
  }
  const shell = parseString(record.shell, 'terminal.shell', {
    maxLength: MAX_TERMINAL_SHELL_LENGTH,
    allowEmpty: true,
  }).trim();
  if (shell && !isAvailableTerminalShell(shell)) {
    throw new Error('terminal.shell must be an available login shell');
  }

  return {
    font_family: parseEnum(record.font_family, 'terminal.font_family', [
      'jetbrains-mono', 'system-mono', 'sf-mono', 'menlo',
    ]) as TerminalPreferences['font_family'],
    font_size: record.font_size,
    line_height: record.line_height,
    cursor_style: parseEnum(record.cursor_style, 'terminal.cursor_style', [
      'block', 'bar', 'underline',
    ]) as TerminalPreferences['cursor_style'],
    cursor_blink: record.cursor_blink,
    scrollback_lines: record.scrollback_lines as TerminalPreferences['scrollback_lines'],
    shell,
    start_directory: parseEnum(record.start_directory, 'terminal.start_directory', [
      'context', 'home',
    ]) as TerminalPreferences['start_directory'],
  };
}

const SETTINGS_PATCH_SCHEMA = {
  port(value: unknown) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error('port must be an integer between 1 and 65535');
    }
    return value;
  },
  theme: (value: unknown, field: string) => parseEnum(value, field, ['light', 'warm', 'dark']),
  accent: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum'],
  ),
  density: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['compact', 'cozy', 'roomy'],
  ),
  font_scale_chrome: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['sm', 'md', 'lg', 'xl'],
  ),
  font_scale_chat: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['sm', 'md', 'lg', 'xl'],
  ),
  chat_font_size(value: unknown) {
    if (typeof value !== 'number' || !Number.isInteger(value)
      || value < MIN_CHAT_FONT_SIZE || value > MAX_CHAT_FONT_SIZE) {
      throw new Error(
        `chat_font_size must be an integer between ${MIN_CHAT_FONT_SIZE} and ${MAX_CHAT_FONT_SIZE}`,
      );
    }
    return value;
  },
  chat_font_family: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['system', 'manrope', 'serif', 'mono'],
  ),
  shortcuts: parseShortcuts,
  font_scale_code: (value: unknown, field: string) => parseEnum(
    value,
    field,
    ['sm', 'md', 'lg', 'xl'],
  ),
  terminal: parseTerminalPreferences,
  locale: (value: unknown, field: string) => parseEnum(value, field, ['zh-CN', 'en']),
  external_editors: parseEditors,
  open_apps: parseOpenApps,
} satisfies Record<EditableSettingsKey, FieldParser>;

function parseSettingsPatch(value: unknown): EditableSettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('settings patch must be an object');
  }

  // Validate the complete body into a separate object before saving anything.
  // This makes a mixed valid + malicious payload an atomic rejection.
  const parsed: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!Object.hasOwn(SETTINGS_PATCH_SCHEMA, field)) {
      throw new Error(`setting ${field} is not editable`);
    }
    const parser = SETTINGS_PATCH_SCHEMA[field as EditableSettingsKey];
    parsed[field] = parser(fieldValue, field);
  }
  return parsed as EditableSettingsPatch;
}

export function registerSettingsRoutes(app: Hono, db: Db): void {
  app.get('/api/settings/terminal-options', c => c.json(terminalOptions()));
  app.get('/api/settings', c => c.json(loadConfig(db)));
  app.patch('/api/settings', async c => {
    let body: unknown;
    try {
      body = await c.req.json<unknown>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    let patch: EditableSettingsPatch;
    try {
      patch = parseSettingsPatch(body);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid settings patch' }, 400);
    }
    saveConfig(db, patch);
    return c.json(loadConfig(db));
  });
}
