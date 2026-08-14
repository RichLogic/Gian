import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  grokPermissionSpec,
  migrateLegacyGrokMode,
  parseGrokPermissionMode,
} from '../src/core/permissions.js';

test('permission modes stay in workspace-write and never become full access', () => {
  for (const id of ['default', 'auto', 'always_approve'] as const) {
    const spec = grokPermissionSpec(id);
    assert.equal(spec.workspace, 'workspace-write');
    assert.equal(spec.network, 'allow');
  }
  assert.deepEqual(grokPermissionSpec('always_approve').createMeta, {
    yoloMode: true,
    autoMode: false,
  });
  assert.equal(parseGrokPermissionMode('plan'), null);
  assert.equal(parseGrokPermissionMode('ask'), null);
});

test('legacy Grok mode values that were actually effort migrate to thinking', () => {
  assert.deepEqual(migrateLegacyGrokMode('high', ''), {
    mode: 'default',
    thinking: 'high',
  });
  assert.deepEqual(migrateLegacyGrokMode('always_approve', 'low'), {
    mode: 'always_approve',
    thinking: 'low',
  });
});
