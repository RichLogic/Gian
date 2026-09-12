import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { AUTH_PROTOCOL } from '@gian/remote-protocol';

import { listColumns, listTables } from '../src/index.js';
import { enrollHost, makeRemoteTestApp, pairDevice, signChallenge } from './fixture.js';

const SECRET_MARKERS = [
  'admin-test-token',
  'supersecrettokenvalue-0123456789abcdef0123456789abcdef',
  'gian_remote_refresh=stolen.family',
  'gian_remote_refresh=abc',
  'pairing_code: ABCD-EFGH',
  'ciphertext: QmFk',
  'ABCD-EFGH',
];

test('logs and database stay free of secrets and business plaintext', async () => {
  const logs: string[] = [];
  const { fetch, handle } = await makeRemoteTestApp({ logs });
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: { cookie: 'gian_remote_refresh=stolen.family', 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: {
      authorization: 'Bearer supersecrettokenvalue-0123456789abcdef0123456789abcdef',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, extra: true }),
  });
  handle.services.config.logger.error(
    'Authorization: Bearer supersecrettokenvalue-0123456789abcdef0123456789abcdef Cookie: gian_remote_refresh=abc pairing_code: ABCD-EFGH ciphertext: QmFk',
  );
  const joined = logs.join('\n');
  for (const marker of SECRET_MARKERS) {
    assert.equal(joined.includes(marker), false, `log leaked ${marker}`);
  }
  assert.match(joined, /\[REDACTED\]/);

  const tables = listTables(handle.services.db);
  for (const forbidden of ['sessions', 'tasks', 'queue', 'transcripts', 'messages', 'attachments', 'commands']) {
    assert.equal(tables.includes(forbidden), false);
  }
  for (const table of tables) {
    const columns = listColumns(handle.services.db, table).join(',');
    assert.doesNotMatch(columns, /prompt|transcript|command_plaintext|workspace_path|attachment_bytes/);
  }
  const challenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { challenge_id: string };
  const rotated = await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      challenge_id: challenge.challenge_id,
      signature: await signChallenge(host.keys.privateKey, challenge.challenge_id),
      refresh_secret: host.refreshSecret,
    }),
  });
  assert.equal(rotated.status, 200);
  const issued = (await rotated.json() as { refresh_secret: string }).refresh_secret;
  assert.notEqual(listColumns(handle.services.db, 'host_credentials').includes('issued_refresh_secret'), true);
  for (const table of tables) {
    const rows = handle.services.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') {
          assert.notEqual(value, issued, `${table} stored refresh secret plaintext`);
          assert.notEqual(value, host.refreshSecret, `${table} stored previous refresh secret plaintext`);
        }
      }
    }
  }
  const manifest = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8',
  )) as { dependencies: Record<string, string> };
  assert.equal('@gian/host' in manifest.dependencies, false);
  assert.equal('@gian/web' in manifest.dependencies, false);
  assert.ok(device.accessToken);
  assert.ok(host.hostId);
  handle.shutdown();
});
