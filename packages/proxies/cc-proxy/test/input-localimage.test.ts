import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputItems } from '../src/core/input.js';

test('cc-proxy normalizeInputItems accepts a localImage with absolute path', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: '/tmp/foo.png' }],
    '/workdir',
  );
  assert.deepEqual(out, [{ type: 'localImage', path: '/tmp/foo.png' }]);
});

test('cc-proxy normalizeInputItems resolves a relative localImage path against cwd', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: 'rel.png' }],
    '/workdir',
  );
  assert.deepEqual(out, [{ type: 'localImage', path: '/workdir/rel.png' }]);
});

test('cc-proxy normalizeInputItems rejects empty localImage path', () => {
  assert.throws(
    () => normalizeInputItems([{ type: 'localImage', path: '   ' }], '/workdir'),
    /path/,
  );
});
