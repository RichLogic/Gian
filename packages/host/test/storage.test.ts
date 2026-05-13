import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/db.js';
import { loadConfig } from '../src/storage/config.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gian-test-'));
}

test('openDatabase runs migrations and creates expected tables', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    for (const expected of [
      'workspaces',
      'sessions',
      'turns',
      'events',
      'approvals',
      'queue',
      'bots',
      'config',
      'migrations',
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are idempotent across reopens', () => {
  const dir = makeTempDir();
  try {
    const db1 = openDatabase(dir);
    const before = db1.prepare('SELECT COUNT(*) AS c FROM migrations').get() as { c: number };
    db1.close();

    const db2 = openDatabase(dir);
    const after = db2.prepare('SELECT COUNT(*) AS c FROM migrations').get() as { c: number };
    assert.equal(after.c, before.c, 'migrations re-applied unexpectedly');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig returns defaults from seeded config rows', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const cfg = loadConfig(db);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 8990);
    assert.equal(cfg.theme, 'warm');
    assert.equal(cfg.density, 'cozy');
    assert.equal(cfg.locale, 'zh-CN');
    assert.equal(cfg.force_https, false);
    assert.equal(cfg.tunnel_mode, 'none');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads overridden values', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    db.prepare('UPDATE config SET value = ? WHERE key = ?').run('0.0.0.0', 'host');
    db.prepare('UPDATE config SET value = ? WHERE key = ?').run('9999', 'port');
    db.prepare('UPDATE config SET value = ? WHERE key = ?').run('true', 'force_https');
    const cfg = loadConfig(db);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.force_https, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
