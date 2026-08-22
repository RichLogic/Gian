import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  fileReadFailure,
  isLikelyBinary,
  readBoundedFile,
} from '../src/workspace/bounded-file.js';

test('isLikelyBinary treats a NUL in the first 8KiB as binary', () => {
  assert.equal(isLikelyBinary(Buffer.from('hello')), false);
  assert.equal(isLikelyBinary(Buffer.from([0x68, 0x00, 0x69])), true);
});

test('fileReadFailure maps node and contract errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-bounded-'));
  try {
    const missing = fileReadFailure(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    assert.deepEqual(missing, { error: 'file not found', status: 404 });
    const denied = fileReadFailure(Object.assign(new Error('nope'), { code: 'EACCES' }));
    assert.deepEqual(denied, { error: 'file not readable', status: 403 });
    assert.deepEqual(fileReadFailure(new Error('boom')), {
      error: 'file read failed',
      status: 500,
    });

    try {
      await readBoundedFile(dir, 16);
      assert.fail('directory should not read as a file');
    } catch (error) {
      assert.deepEqual(fileReadFailure(error), { error: 'not a file', status: 400 });
    }

    const oversized = join(dir, 'big.txt');
    writeFileSync(oversized, 'abcdefghij');
    try {
      await readBoundedFile(oversized, 4);
      assert.fail('oversize file should reject');
    } catch (error) {
      assert.deepEqual(fileReadFailure(error), { error: 'file too large', status: 413 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBoundedFile returns bytes at or under the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-bounded-ok-'));
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'ok.txt');
    writeFileSync(path, 'abcd');
    assert.equal((await readBoundedFile(path, 4)).toString(), 'abcd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
