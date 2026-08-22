import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dbPath, resolveDataDir } from '../src/storage/paths.js';

test('dbPath joins gian.db onto the given data dir', () => {
  assert.equal(dbPath('/tmp/gian-data'), join('/tmp/gian-data', 'gian.db'));
  assert.equal(dbPath('/var/folders/xx/data'), join('/var/folders/xx/data', 'gian.db'));
});

test('resolveDataDir uses GIAN_DATA_DIR and does not touch ~/.gian', () => {
  const previous = process.env.GIAN_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'gian-unit-data-'));
  try {
    process.env.GIAN_DATA_DIR = dir;
    assert.equal(resolveDataDir(), dir);
    assert.equal(dbPath(resolveDataDir()), join(dir, 'gian.db'));
  } finally {
    if (previous === undefined) delete process.env.GIAN_DATA_DIR;
    else process.env.GIAN_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
