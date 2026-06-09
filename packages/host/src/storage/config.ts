import type { ExternalEditor, SystemConfig, Accent, FontScale } from '@gian/shared';
import { THEME_DEFAULT_ACCENT } from '@gian/shared';
import type { Db } from './db.js';

const EXTERNAL_EDITORS_KEY = 'external_editors';
const OPEN_APPS_KEY = 'open_apps';
const OPEN_APP_CATEGORIES = ['code', 'web', 'images', 'pdf', 'other'] as const;

const VALID_ACCENTS: ReadonlySet<Accent> = new Set([
  'rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum',
]);
const VALID_SCALES: ReadonlySet<FontScale> = new Set(['sm', 'md', 'lg', 'xl']);
const VALID_THEMES: ReadonlySet<SystemConfig['theme']> = new Set(['light', 'warm', 'dark']);

function sanitizeScale(raw: string | undefined): FontScale {
  return raw && VALID_SCALES.has(raw as FontScale) ? (raw as FontScale) : 'md';
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

export function saveConfig(db: Db, partial: Partial<SystemConfig>): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(partial) as [keyof SystemConfig, SystemConfig[keyof SystemConfig]][]) {
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
    public_url: map.get('public_url') ?? '',
    tunnel_mode: (map.get('tunnel_mode') ?? 'none') as SystemConfig['tunnel_mode'],
    tunnel_id: map.get('tunnel_id') ?? '',
    force_https: map.get('force_https') === 'true',
    theme,
    accent,
    density: (map.get('density') ?? 'cozy') as SystemConfig['density'],
    font_scale_chrome: sanitizeScale(map.get('font_scale_chrome')),
    font_scale_chat: sanitizeScale(map.get('font_scale_chat')),
    font_scale_code: sanitizeScale(map.get('font_scale_code')),
    locale: (map.get('locale') ?? 'zh-CN') as SystemConfig['locale'],
    default_claude_model: map.get('default_claude_model') ?? '',
    default_claude_effort: map.get('default_claude_effort') ?? '',
    default_codex_model: map.get('default_codex_model') ?? '',
    default_codex_effort: map.get('default_codex_effort') ?? '',
    auth_username: map.get('auth_username') ?? '',
    external_editors: externalEditors,
    open_apps: openApps,
    claude_chat_surface: map.get('claude_chat_surface') === 'structured' ? 'structured' : 'tty',
    claude_chat_cli: map.has('claude_chat_cli') ? map.get('claude_chat_cli') === 'true' : true,
    codex_chat_cli: map.get('codex_chat_cli') === 'true',
  };
}
