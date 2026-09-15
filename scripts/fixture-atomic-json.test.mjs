import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFixtureJson } from '../packages/host/test/fixtures/atomic-json.mjs';

test('a restarted fake Proxy sees the previous complete snapshot until atomic publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-fixture-json-'));
  try {
    const path = join(root, 'state.json');
    const previous = { sessions: { parent: { state: 'idle' } } };
    const next = { sessions: { parent: { state: 'idle' }, child: { state: 'running' } } };
    writeFileSync(path, JSON.stringify(previous));
    let staged = false;
    writeFixtureJson(path, next, {
      writeFileSync(temporary, bytes) {
        assert.notEqual(temporary, path);
        writeFileSync(temporary, bytes);
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), previous);
        staged = true;
      },
      renameSync(temporary, destination) {
        assert.equal(staged, true);
        assert.equal(destination, path);
        renameSync(temporary, destination);
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), next);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
