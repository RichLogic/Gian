import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  migrateLegacyGrokProxyDefaults,
  usesNativeExecutorConfig,
} from '../dist/index.js';

test('usesNativeExecutorConfig is true only for kimi and grok', () => {
  assert.equal(usesNativeExecutorConfig('kimi'), true);
  assert.equal(usesNativeExecutorConfig('grok'), true);
  assert.equal(usesNativeExecutorConfig('claude'), false);
  assert.equal(usesNativeExecutorConfig('codex'), false);
});

test('migrateLegacyGrokProxyDefaults keeps default/auto/always_approve/empty mode', () => {
  for (const mode of ['default', 'auto', 'always_approve', '']) {
    const defaults = { model: 'grok-4', thinking: 'low', mode };
    assert.equal(migrateLegacyGrokProxyDefaults(defaults), defaults);
    assert.deepEqual(defaults, { model: 'grok-4', thinking: 'low', mode });
  }
});

test('migrateLegacyGrokProxyDefaults moves effort-like mode into thinking', () => {
  const migrated = migrateLegacyGrokProxyDefaults({
    model: 'grok-4',
    thinking: '',
    mode: 'high',
  });
  assert.deepEqual(migrated, { model: 'grok-4', thinking: 'high', mode: 'default' });
});

test('migrateLegacyGrokProxyDefaults keeps existing thinking when resetting unknown mode', () => {
  const migrated = migrateLegacyGrokProxyDefaults({
    model: 'grok-4',
    thinking: 'medium',
    mode: 'xhigh',
  });
  assert.deepEqual(migrated, { model: 'grok-4', thinking: 'medium', mode: 'default' });
});
