import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthPayload } from '../src/web/health.js';

test('health payload exposes runtime ownership only for a managed dev stack', () => {
  assert.deepEqual(buildHealthPayload({}), {
    ok: true,
    version: '0.1.0',
  });
  assert.deepEqual(buildHealthPayload({
    GIAN_RELEASE_VERSION: '0.3.0',
    GIAN_DESKTOP_INSTANCE_ID: 'packaged-instance',
    GIAN_DEV_RUNTIME_ID: 'gian-0.3.0-abcd1234',
    GIAN_DEV_WORKTREE: '/tmp/gian-0.3.0',
  }), {
    ok: true,
    version: '0.3.0',
    instanceId: 'packaged-instance',
    devRuntimeId: 'gian-0.3.0-abcd1234',
    devWorktree: '/tmp/gian-0.3.0',
  });
});
