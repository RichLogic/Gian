import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { test } from 'node:test';

import { listColumns, listTables, openRemoteDatabase } from '../src/index.js';
import { RemoteRepositories } from '../src/storage/repositories.js';
import { runMigrations } from '../src/storage/db.js';
import { hashSecret } from '../src/crypto-hash.js';

test('upgrade invalidates old unbound unused tokens and preserves used enrollment history', () => {
  const db = new Database(':memory:');
  try {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    db.exec('CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '006').sort()) {
      db.exec(readFileSync(join(migrations, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 'fixture');
    }
    const insert = db.prepare('INSERT INTO host_enrollments(id, token_hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('unused', hashSecret('old-unused-token'), 900_000, 1, null);
    insert.run('used', hashSecret('old-used-token'), 900_000, 1, 2);
    runMigrations(db);
    assert.equal((db.prepare('SELECT expires_at FROM host_enrollments WHERE id = ?').get('unused') as { expires_at: number }).expires_at, 0);
    assert.equal((db.prepare('SELECT used_at FROM host_enrollments WHERE id = ?').get('used') as { used_at: number }).used_at, 2);
    const repos = new RemoteRepositories(db, () => 10);
    assert.equal(repos.claimEnrollment('old-unused-token', { name: 'Mac', public_key_jwk: '{}' }, '42'), null);
    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM host_enrollments').get() as { n: number }).n, 2);
  } finally { db.close(); }
});

test('migrations create only identity/relay tables and survive reopen', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  const db = openRemoteDatabase(dataDir);
  const tables = listTables(db);
  assert.deepEqual(tables, [
    'account_challenges',
    'account_peers',
    'browser_installations',
    'connector_challenges',
    'device_challenges',
    'device_host_pairings',
    'device_sessions',
    'enrollment_sessions',
    'host_credentials',
    'host_enrollments',
    'hosts',
    'pairing_grants',
    'presence_leases',
    'relay_outbox',
    'revocation_tombstones',
    'revoked_pairing_keys',
    'schema_migrations',
    'ws_tickets',
  ]);
  assert.ok(listColumns(db, 'host_credentials').includes('previous_refresh_secret_hash'));
  assert.equal(listColumns(db, 'host_credentials').includes('issued_refresh_secret'), false);
  assert.ok(listColumns(db, 'revocation_tombstones').includes('public_key_jwk'));
  for (const table of tables) {
    const columns = listColumns(db, table).join(',');
    assert.doesNotMatch(columns, /prompt|transcript|session_title|queue_text|workspace_path/);
  }
  assert.ok(listColumns(db, 'device_host_pairings').includes('crypto_connection_id'));
  assert.ok(listColumns(db, 'host_enrollments').includes('github_account_id'));
  assert.ok(listColumns(db, 'account_peers').includes('delegated_host_id'));
  db.close();
  const reopened = openRemoteDatabase(dataDir);
  assert.ok(listTables(reopened).includes('schema_migrations'));
  reopened.close();
});

test('cleanup removes expired unused grants and tickets without business tables', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  let now = Date.UTC(2026, 8, 1);
  const db = openRemoteDatabase(dataDir);
  const repos = new RemoteRepositories(db, () => now);
  const tables = listTables(db);
  for (const forbidden of ['sessions', 'tasks', 'queue', 'transcripts', 'messages', 'attachments', 'commands']) {
    assert.equal(tables.includes(forbidden), false);
  }
  assert.throws(() => {
    db.prepare(`
      INSERT INTO device_host_pairings(
        id, browser_installation_id, host_id, public_key_jwk, platform, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('id', 'missing-browser', 'missing-host', '{}', 'macOS', 'x', now);
  });
  now += 1;
  repos.cleanupExpired();
  db.close();
});
