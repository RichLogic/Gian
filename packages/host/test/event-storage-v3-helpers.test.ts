import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, resolve } from 'node:path';

import {
  createConfirmationToken,
  describeRun,
  maintenanceLockForDatabase,
  migrationRunFiles,
  type RunManifest,
} from '../src/storage/event-storage-v3-migrator.js';
import { EVENT_STORAGE_V3_LOCK_FILENAME } from '../src/storage/maintenance-lock.js';

const sha = 'a'.repeat(64);

test('createConfirmationToken is stable after path normalization', () => {
  const first = createConfirmationToken('gian.db', sha, '0.5.0');
  const second = createConfirmationToken(resolve('gian.db'), sha, '0.5.0');
  assert.match(first, /^GIAN-EVENT-V3-[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(createConfirmationToken('gian.db', 'b'.repeat(64), '0.5.0'), first);
  assert.notEqual(createConfirmationToken('gian.db', sha, '0.5.1'), first);
});

test('migrationRunFiles and lock path stay next to the database', () => {
  assert.deepEqual(migrationRunFiles('/tmp/run-1'), {
    manifest: join('/tmp/run-1', 'manifest.before.json'),
    progress: join('/tmp/run-1', 'progress.jsonl'),
    verification: join('/tmp/run-1', 'verify.after.json'),
    vacuum: join('/tmp/run-1', 'vacuum.after.json'),
  });
  assert.equal(
    maintenanceLockForDatabase('/tmp/data/gian.db'),
    join('/tmp/data', EVENT_STORAGE_V3_LOCK_FILENAME),
  );
  assert.equal(
    maintenanceLockForDatabase('gian.db'),
    join(resolve('gian.db'), '..', EVENT_STORAGE_V3_LOCK_FILENAME),
  );
});

test('describeRun names the database basename and release', () => {
  const manifest = {
    runId: 'run-9',
    databasePath: '/tmp/data/gian.db',
    releaseVersion: '0.5.0',
  } as RunManifest;
  assert.equal(describeRun(manifest), 'run-9 (gian.db, release 0.5.0)');
});
