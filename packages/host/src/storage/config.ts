import type { SystemConfig } from '@gian/shared';
import type { Db } from './db.js';

export function loadPasswordHash(db: Db): string {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auth_password_hash') as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

export function savePasswordHash(db: Db, hash: string): void {
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('auth_password_hash', ?)`).run(hash);
}

export function saveConfig(db: Db, partial: Partial<SystemConfig>): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(partial) as [keyof SystemConfig, SystemConfig[keyof SystemConfig]][]) {
    stmt.run(key, String(value));
  }
}

export function loadConfig(db: Db): SystemConfig {
  const rows = db.prepare('SELECT key, value FROM config').all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map(r => [r.key, r.value]));

  return {
    host: map.get('host') ?? '127.0.0.1',
    port: Number(map.get('port') ?? 8990),
    workspace_root: map.get('workspace_root') ?? '~/Coding',
    public_url: map.get('public_url') ?? '',
    tunnel_mode: (map.get('tunnel_mode') ?? 'none') as SystemConfig['tunnel_mode'],
    tunnel_id: map.get('tunnel_id') ?? '',
    force_https: map.get('force_https') === 'true',
    theme: (map.get('theme') ?? 'warm') as SystemConfig['theme'],
    accent: map.get('accent') ?? 'plum',
    density: (map.get('density') ?? 'cozy') as SystemConfig['density'],
    locale: (map.get('locale') ?? 'zh-CN') as SystemConfig['locale'],
    default_claude_model: map.get('default_claude_model') ?? '',
    default_claude_effort: map.get('default_claude_effort') ?? '',
    default_codex_model: map.get('default_codex_model') ?? '',
    default_codex_effort: map.get('default_codex_effort') ?? '',
    auth_username: map.get('auth_username') ?? '',
  };
}
