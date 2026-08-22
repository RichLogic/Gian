import { dirname, join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EVENT_STORAGE_V3_LOCK_FILENAME, maintenanceLockPathForDb } from '../src/storage/maintenance-lock.js';

test('maintenanceLockPathForDb sits next to the resolved database file', () => {
  const db = '/tmp/gian-data/gian.db';
  assert.equal(
    maintenanceLockPathForDb(db),
    join(dirname(resolve(db)), EVENT_STORAGE_V3_LOCK_FILENAME),
  );
  assert.equal(maintenanceLockPathForDb(db).endsWith(EVENT_STORAGE_V3_LOCK_FILENAME), true);
});

test('maintenanceLockPathForDb resolves a relative database path', () => {
  const path = maintenanceLockPathForDb('data/gian.db');
  assert.equal(path, join(dirname(resolve('data/gian.db')), EVENT_STORAGE_V3_LOCK_FILENAME));
  assert.match(path, /event-storage-v3\.lock$/);
});
