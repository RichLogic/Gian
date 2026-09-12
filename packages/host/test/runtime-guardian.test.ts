import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeGuardian } from '../src/runtime/guardian.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import type { RuntimeObservation } from '../src/runtime/resolver.js';

test('runtime guardian single-flights checks and invalidates before close', async () => {
  let detectCalls = 0;
  let allowDetection!: () => void;
  const detectionGate = new Promise<void>(resolve => { allowDetection = resolve; });
  const closed: string[] = [];
  const invalidated: string[] = [];
  const cache = new RuntimeReadinessCache();
  cache.publish({
    pluginId: 'codex',
    pluginVersion: '0.2.13',
    selectedPath: '/tmp/codex',
    profileIdentity: 'id',
    state: 'ready',
    displayName: 'Codex CLI',
  });
  const guardian = new RuntimeGuardian({
    resolver: {
      async detectExternalChanges() {
        detectCalls += 1;
        await detectionGate;
        return ['codex'];
      },
      invalidate(pluginId: string) {
        invalidated.push(`resolver:${pluginId}`);
        return true;
      },
    } as never,
    readinessCache: cache,
    closeRuntimeOwner: async pluginId => { closed.push(pluginId); },
  });

  const first = guardian.checkNow();
  const second = guardian.checkNow();
  assert.equal(first, second);
  allowDetection();
  await first;
  assert.equal(detectCalls, 1);
  assert.deepEqual(closed, ['codex']);
  assert.equal(cache.isInvalidated('codex', '0.2.13'), true);
  assert.deepEqual(invalidated, ['resolver:codex']);
});

test('runtime guardian invalidates readiness even when owner shutdown fails', async () => {
  const cache = new RuntimeReadinessCache();
  cache.publish({
    pluginId: 'claude',
    pluginVersion: '0.2.4',
    selectedPath: '/tmp/claude',
    profileIdentity: 'id',
    state: 'ready',
    displayName: 'Claude Code',
  });
  const guardian = new RuntimeGuardian({
    resolver: {
      async detectExternalChanges() { return ['claude']; },
      invalidate() { return true; },
    } as never,
    readinessCache: cache,
    closeRuntimeOwner: async () => { throw new Error('controlled close failure'); },
  });

  await assert.rejects(
    guardian.checkNow(),
    error => error instanceof AggregateError
      && error.errors.some(cause => String(cause).includes('controlled close failure')),
  );
  assert.equal(cache.isInvalidated('claude', '0.2.4'), true);
  assert.equal(cache.get('claude', '0.2.4')?.state, 'invalid');
});

test('runtime guardian maps DSH/ZCode owners and isolates close failures', async () => {
  const closed: string[] = [];
  const guardian = new RuntimeGuardian({
    resolver: {
      async detectExternalChanges(_extra?: readonly RuntimeObservation[]) {
        return ['ai.deepseek.harness', 'com.zhipu.zcode'];
      },
      invalidate() { return true; },
    } as never,
    closeRuntimeOwner: async pluginId => {
      closed.push(pluginId);
      if (pluginId === 'ai.deepseek.harness') throw new Error('dsh close failed');
    },
  });

  await assert.rejects(guardian.checkNow(), AggregateError);
  assert.deepEqual(closed, ['ai.deepseek.harness', 'com.zhipu.zcode']);
});
