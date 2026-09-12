import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/storage/db.js';
import { SessionRepository } from '../src/session/repository.js';

test('migration 068 backfills official pluginId and leaves binding null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-proxy-id-'));
  try {
    const raw = new Database(join(dir, 'gian.db'));
    raw.exec(`
      CREATE TABLE migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        executor TEXT NOT NULL
      );
      INSERT INTO sessions (id, executor) VALUES
        ('s-claude', 'claude'),
        ('s-dsh', 'dsh'),
        ('s-zcode', 'zcode'),
        ('s-unknown', 'mystery');
    `);
    const migrationDir = new URL('../migrations/', import.meta.url);
    const insert = raw.prepare('INSERT INTO migrations (filename) VALUES (?)');
    for (const filename of readdirSync(migrationDir).filter(name => name.endsWith('.sql'))) {
      if (filename !== '068_session_proxy_identity.sql') insert.run(filename);
    }
    raw.close();

    const upgraded = openDatabase(dir);
    const rows = upgraded.prepare(
      'SELECT id, executor, proxy_plugin_id, proxy_binding_json FROM sessions ORDER BY id',
    ).all() as Array<{
      id: string;
      executor: string;
      proxy_plugin_id: string | null;
      proxy_binding_json: string | null;
    }>;
    assert.deepEqual(rows, [
      { id: 's-claude', executor: 'claude', proxy_plugin_id: 'claude', proxy_binding_json: null },
      { id: 's-dsh', executor: 'dsh', proxy_plugin_id: 'ai.deepseek.harness', proxy_binding_json: null },
      { id: 's-unknown', executor: 'mystery', proxy_plugin_id: null, proxy_binding_json: null },
      { id: 's-zcode', executor: 'zcode', proxy_plugin_id: 'com.zhipu.zcode', proxy_binding_json: null },
    ]);
    upgraded.prepare(
      `UPDATE sessions SET proxy_binding_json = ? WHERE id = 's-claude'`,
    ).run(JSON.stringify({
      schemaVersion: 1,
      pluginId: 'claude',
      pluginVersion: '0.0.0',
      manifestSha256: '',
      protocolVersion: '2.1',
      processScope: 'session',
      runtimeProfile: null,
    }));
    const sessions = new SessionRepository(upgraded);
    const claude = sessions.get('s-claude');
    assert.equal(claude.proxy_plugin_id, 'claude');
    assert.equal(claude.proxy_binding, null);
    assert.equal(claude.proxy_binding_error, 'PROXY_BINDING_INVALID');
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 070 unique-indexes native sessions by pluginId without fabricating bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-native-unique-'));
  try {
    const raw = new Database(join(dir, 'gian.db'));
    raw.exec(`
      CREATE TABLE migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        executor TEXT NOT NULL,
        proxy_plugin_id TEXT,
        proxy_binding_json TEXT,
        native_session_id TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_sessions_native_unique
        ON sessions(executor, native_session_id);
      INSERT INTO sessions (id, executor, proxy_plugin_id, proxy_binding_json, native_session_id)
      VALUES
        ('s-claude', 'claude', 'claude', NULL, 'native-shared'),
        ('s-legacy', 'mystery', NULL, NULL, 'native-legacy');
    `);
    const migrationDir = new URL('../migrations/', import.meta.url);
    const insert = raw.prepare('INSERT INTO migrations (filename) VALUES (?)');
    for (const filename of readdirSync(migrationDir).filter(name => name.endsWith('.sql'))) {
      if (filename !== '070_session_native_plugin_uniqueness.sql') insert.run(filename);
    }
    raw.close();

    const upgraded = openDatabase(dir);
    upgraded.exec(`
      INSERT INTO sessions (id, executor, proxy_plugin_id, proxy_binding_json, native_session_id)
      VALUES ('s-fixture', 'io.gian.fixture', 'io.gian.fixture', NULL, 'native-shared')
    `);
    const rows = upgraded.prepare(
      'SELECT id, proxy_plugin_id, native_session_id, proxy_binding_json FROM sessions ORDER BY id',
    ).all() as Array<{
      id: string;
      proxy_plugin_id: string | null;
      native_session_id: string;
      proxy_binding_json: string | null;
    }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.proxy_binding_json === null));
    assert.throws(
      () => upgraded.exec(`
        INSERT INTO sessions (id, executor, proxy_plugin_id, proxy_binding_json, native_session_id)
        VALUES ('s-dup', 'claude', 'claude', NULL, 'native-shared')
      `),
    );
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
