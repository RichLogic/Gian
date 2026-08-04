import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizedTestEnv } from './run-tests.mjs';

test('sanitizedTestEnv removes inherited Gian production configuration', () => {
  assert.deepEqual(sanitizedTestEnv({
    PATH: '/bin',
    CI: '1',
    GIAN_PORT: '8990',
    GIAN_DATA_DIR: '/Users/example/.gian',
    GIAN_DESKTOP_TOKEN: 'secret',
  }), {
    PATH: '/bin',
    CI: '1',
  });
});
