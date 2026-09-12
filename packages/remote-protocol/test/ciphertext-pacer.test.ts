import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  MAX_CIPHERTEXT_BYTES_PER_SECOND,
  MAX_CONTROL_FRAMES_PER_SECOND,
  RELAY_FRAME_PACE_INTERVAL_MS,
  createCiphertextPacer,
  createRelayFramePacer,
} from '../src/index.js';

test('default sender pace is strictly below the Server ciphertext cap', () => {
  assert.ok(CIPHERTEXT_PACE_BYTES_PER_SECOND < MAX_CIPHERTEXT_BYTES_PER_SECOND);
  assert.ok(CIPHERTEXT_PACE_WINDOW_MS > 1000);
  assert.ok(Math.ceil(1000 / RELAY_FRAME_PACE_INTERVAL_MS) < MAX_CONTROL_FRAMES_PER_SECOND);
});

test('relay frame pacer spreads a concurrent burst across reserved send slots', async () => {
  const pacer = createRelayFramePacer(20);
  const started = Date.now();
  await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
  assert.ok(Date.now() - started >= 30);
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
