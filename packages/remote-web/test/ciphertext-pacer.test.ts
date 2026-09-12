import { describe, expect, it } from 'vitest';
import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  MAX_CIPHERTEXT_BYTES_PER_SECOND,
} from '@gian/remote-protocol';
import { createCiphertextPacer } from '../src/transport/ciphertext-pacer.js';

describe('createCiphertextPacer', () => {
  it('waits when the next frame would exceed the Server ciphertext budget', async () => {
    const pacer = createCiphertextPacer(1_000, 1_000);
    await pacer.wait(800);
    pacer.note(800);
    const started = Date.now();
    await pacer.wait(800);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(CIPHERTEXT_PACE_BYTES_PER_SECOND).toBeLessThan(MAX_CIPHERTEXT_BYTES_PER_SECOND);
  });

  it('reserves the next frame before note so delayed sends cannot stack', async () => {
    const pacer = createCiphertextPacer(1_000, 1_000);
    await pacer.wait(800);
    const started = Date.now();
    const second = pacer.wait(800);
    await new Promise((resolve) => setTimeout(resolve, 20));
    pacer.note(800);
    await second;
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});
