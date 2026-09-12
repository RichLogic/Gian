import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listColumns, listTables, openRemoteDatabase } from '../src/index.js';
import { RemoteRepositories } from '../src/storage/repositories.js';

test('migrations create only identity/relay tables and survive reopen', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  const db = openRemoteDatabase(dataDir);
  const tables = listTables(db);
  assert.deepEqual(tables, [
    'browser_installations',
    'connector_challenges',
    'device_challenges',
    'device_host_pairings',
    'device_sessions',
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
