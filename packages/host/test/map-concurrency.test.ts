import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapWithConcurrency } from '../src/workspace/async-command.js';

test('mapWithConcurrency preserves input order', async () => {
  const out = await mapWithConcurrency([3, 2, 1], 2, async (value) => value * 10);
  assert.deepEqual(out, [30, 20, 10]);
});

test('mapWithConcurrency rejects a non-positive limit', async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async (value) => value), TypeError);
  await assert.rejects(() => mapWithConcurrency([1], 1.5, async (value) => value), TypeError);
});

test('mapWithConcurrency returns [] for an empty input', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (value) => value), []);
});

test('mapWithConcurrency caps in-flight work at the limit', async () => {
  let inflight = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await Promise.resolve();
    inflight -= 1;
    return inflight;
  });
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});
