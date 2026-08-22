import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AgentInstallStatus } from '@gian/shared';
import { hasReadyAgent, resolveOnboardingProjectRoot } from '../src/onboarding/state.js';

function status(ready: boolean): AgentInstallStatus {
  return {
    id: 'grok',
    name: 'Grok',
    ready,
    cli: { state: ready ? 'ready' : 'missing', path: null, version: null, source: null },
    proxy: {
      state: ready ? 'ready' : 'missing',
      path: null,
      version: null,
      source: null,
      defaults: { model: '', thinking: '', mode: '' },
    },
    officialInstallUrl: 'https://example.test/install',
  };
}

test('hasReadyAgent is true when any agent is ready', () => {
  assert.equal(hasReadyAgent([status(false), status(false)]), false);
  assert.equal(hasReadyAgent([status(false), status(true)]), true);
  assert.equal(hasReadyAgent([status(true)]), true);
});

test('resolveOnboardingProjectRoot expands ~ against an injected home', () => {
  assert.deepEqual(resolveOnboardingProjectRoot('~', '/home/unit'), { projectRoot: '~' });
  assert.deepEqual(resolveOnboardingProjectRoot('~/apps/demo', '/home/unit'), { projectRoot: '~/apps/demo' });
  assert.deepEqual(
    resolveOnboardingProjectRoot('  /opt/unit-proj  ', '/home/unit'),
    { projectRoot: '/opt/unit-proj' },
  );
});

test('resolveOnboardingProjectRoot rejects empty and relative roots', () => {
  assert.throws(() => resolveOnboardingProjectRoot('   ', '/home/unit'), /required/);
  assert.throws(() => resolveOnboardingProjectRoot('rel/path', '/home/unit'), /absolute/);
});
