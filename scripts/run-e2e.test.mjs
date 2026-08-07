import assert from 'node:assert/strict';
import test from 'node:test';
import { createE2eEnvironment } from './run-e2e.mjs';

test('createE2eEnvironment replaces inherited Gian runtime configuration', () => {
  const env = createE2eEnvironment({
    FORCE_COLOR: '1',
    NO_COLOR: '0',
    PATH: '/bin',
    GIAN_DATA_DIR: '/Users/example/.gian',
    GIAN_DESKTOP_TOKEN: 'production-token',
    GIAN_PARENT_MANAGED: '1',
    GIAN_PORT: '8990',
  }, {
    dataDir: '/tmp/gian-e2e-test',
    hostPort: 41234,
    webPort: 41235,
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIAN_DATA_DIR, '/tmp/gian-e2e-test');
  assert.equal(env.GIAN_E2E_DATA_DIR, '/tmp/gian-e2e-test');
  assert.equal(env.GIAN_E2E_ISOLATED, '1');
  assert.equal(env.GIAN_HOST_PORT, '41234');
  assert.equal(env.GIAN_PORT, '41234');
  assert.equal(env.GIAN_WEB_PORT, '41235');
  assert.equal(env.GIAN_DESKTOP_TOKEN, undefined);
  assert.equal(env.GIAN_PARENT_MANAGED, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.NO_COLOR, '1');
});
