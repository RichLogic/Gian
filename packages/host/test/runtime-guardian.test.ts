import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeGuardian } from '../src/runtime/guardian.js';

test('runtime guardian single-flights checks and retires changed executors', async () => {
  let detectCalls = 0;
  let allowDetection!: () => void;
  const detectionGate = new Promise<void>(resolve => { allowDetection = resolve; });
  const closed: string[] = [];
  const invalidated: string[] = [];
  const runtimes = {
    async detectExternalChanges() {
      detectCalls += 1;
      await detectionGate;
      return ['codex'] as const;
    },
    invalidate(cli: string) {
      invalidated.push(cli);
      return true;
    },
  };
  const guardian = new RuntimeGuardian({
    runtimes: runtimes as never,
    closeRuntimeOwner: async cli => { closed.push(cli); },
  });

  const first = guardian.checkNow();
  const second = guardian.checkNow();
  assert.equal(first, second);
  allowDetection();
  await first;
  assert.equal(detectCalls, 1);
  assert.deepEqual(closed, ['codex']);
  assert.deepEqual(invalidated, ['codex']);
});

test('runtime guardian leaves a changed generation active when owner shutdown fails', async () => {
  let invalidations = 0;
  const guardian = new RuntimeGuardian({
    runtimes: {
      async detectExternalChanges() { return ['claude'] as const; },
      invalidate() { invalidations += 1; return true; },
    } as never,
    closeRuntimeOwner: async () => { throw new Error('controlled close failure'); },
  });

  await assert.rejects(
    guardian.checkNow(),
    error => error instanceof AggregateError
      && error.errors.some(cause => String(cause).includes('controlled close failure')),
  );
  assert.equal(invalidations, 0);
});

test('runtime guardian isolates owner shutdown failures between executors', async () => {
  const closed: string[] = [];
  const invalidated: string[] = [];
  const guardian = new RuntimeGuardian({
    runtimes: {
      async detectExternalChanges() { return ['claude', 'codex'] as const; },
      invalidate(cli: string) { invalidated.push(cli); return true; },
    } as never,
    closeRuntimeOwner: async cli => {
      closed.push(cli);
      if (cli === 'claude') throw new Error('claude close failed');
    },
  });

  await assert.rejects(guardian.checkNow(), AggregateError);
  assert.deepEqual(closed, ['claude', 'codex']);
  assert.deepEqual(invalidated, ['codex']);
});
