import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanAfterParent, validateDataDir } from './e2e-janitor.mjs';

test('validateDataDir only accepts isolated gian-e2e directories under the OS temp root', () => {
  assert.equal(
    validateDataDir(join(tmpdir(), 'gian-e2e-contract')),
    join(tmpdir(), 'gian-e2e-contract'),
  );
  assert.throws(() => validateDataDir(join(tmpdir(), 'not-gian-data')), /refusing to clean/);
  assert.throws(() => validateDataDir('/'), /refusing to clean/);
});

test('cleanAfterParent removes the isolated directory once its parent is gone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-e2e-janitor-test-'));
  const removed = await cleanAfterParent({
    dataDir,
    parentPid: 2_147_483_647,
    graceMs: 0,
    maxWaitMs: 10,
    pollMs: 1,
  });

  assert.equal(removed, true);
  await assert.rejects(stat(dataDir), error => error?.code === 'ENOENT');
});
