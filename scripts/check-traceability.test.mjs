import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('retired checker cannot certify coverage or require a repository/ledger', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'gian-retired-traceability-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(
    promisify(execFile)(process.execPath, [fileURLToPath(new URL('./check-traceability.js', import.meta.url))], {
      cwd, env: { PATH: '', TRACEABILITY_BASE: 'missing-revision' },
    }),
    error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /RETIRED/);
      assert.match(error.stderr, /no coverage was verified/);
      assert.doesNotMatch(error.stdout, /PASS|checked/);
      return true;
    },
  );
  assert.deepEqual(await readdir(cwd), []);
});
