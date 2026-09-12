import { describe, expect, it } from 'vitest';

import {
  PAIRING_POLL_INITIAL_MS,
  nextPairingPollDelay,
} from '../src/controller/production.js';

describe('production pairing confirmation polling', () => {
  it('keeps at least one device-challenge request in reserve for login', () => {
    const calls = [0];
    let now = 0;
    let delayMs = PAIRING_POLL_INITIAL_MS;
    while (now < 120_000) {
      now += delayMs;
      calls.push(now);
      delayMs = nextPairingPollDelay(delayMs);
    }

    for (const call of calls) {
      const attemptsInWindow = calls.filter((value) => value > call - 60_000 && value <= call);
      expect(attemptsInWindow.length).toBeLessThanOrEqual(9);
    }
  });
});
