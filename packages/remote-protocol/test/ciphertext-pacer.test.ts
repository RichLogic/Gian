import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  MAX_CIPHERTEXT_BYTES_PER_SECOND,
  MAX_CONTROL_FRAMES_PER_SECOND,
  RELAY_FRAME_BURST_CAPACITY,
  RELAY_FRAME_REFILL_PER_SECOND,
  createCiphertextPacer,
  createRelayFrameTokenBucket,
} from '../src/index.js';

test('default burst bucket stays below the Server rolling frame cap', () => {
  assert.ok(CIPHERTEXT_PACE_BYTES_PER_SECOND < MAX_CIPHERTEXT_BYTES_PER_SECOND);
  assert.ok(CIPHERTEXT_PACE_WINDOW_MS > 1000);
  assert.ok(RELAY_FRAME_BURST_CAPACITY + RELAY_FRAME_REFILL_PER_SECOND < MAX_CONTROL_FRAMES_PER_SECOND);
});

test('frame bucket releases a full burst immediately, then refills at the sustained rate', async () => {
  const bucket = createRelayFrameTokenBucket(3, 60);
  const started = Date.now();
  await Promise.all([bucket.wait(), bucket.wait(), bucket.wait()]);
  assert.ok(Date.now() - started < 20);
  await bucket.wait();
  const afterBurst = Date.now() - started;
  assert.ok(afterBurst >= 12, `fourth frame arrived too early: ${afterBurst}ms`);
  const fifth = bucket.wait();
  const sixth = bucket.wait();
  await Promise.all([fifth, sixth]);
  assert.ok(Date.now() - started >= 28, `six frames arrived too early: ${Date.now() - started}ms`);
});

test('waits when the next frame would exceed the ciphertext budget', async () => {
  const pacer = createCiphertextPacer(1_000, 1_000);
  await pacer.wait(800);
  pacer.note(800);
  const started = Date.now();
  await pacer.wait(800);
  assert.ok(Date.now() - started >= 40);
});

test('reserves bytes in wait so a delayed note cannot oversubscribe the window', async () => {
  const pacer = createCiphertextPacer(1_000, 1_000);
  await pacer.wait(800);
  const started = Date.now();
  const second = pacer.wait(800);
  await new Promise((resolve) => setTimeout(resolve, 30));
  pacer.note(800);
  await second;
  assert.ok(Date.now() - started >= 40);
});

test('lagging Server receive stamps stay under the 16 MiB cap', async () => {
  const pacer = createCiphertextPacer();
  const server: { at: number; bytes: number }[] = [];
  const skewMs = 80;
  const frame = 512 * 1024;
  const frames = 28;
  for (let i = 0; i < frames; i += 1) {
    await pacer.wait(frame);
    await new Promise((resolve) => setTimeout(resolve, 4));
    pacer.note(frame);
    server.push({ at: Date.now() + skewMs, bytes: frame });
    const now = Date.now() + skewMs;
    const used = server
      .filter((entry) => entry.at > now - 1000)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    assert.ok(
      used <= MAX_CIPHERTEXT_BYTES_PER_SECOND,
      `server window ${used} exceeded ${MAX_CIPHERTEXT_BYTES_PER_SECOND}`,
    );
  }
});
