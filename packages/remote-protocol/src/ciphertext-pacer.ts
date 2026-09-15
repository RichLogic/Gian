import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  RELAY_FRAME_BURST_CAPACITY,
  RELAY_FRAME_REFILL_PER_SECOND,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';

/** Keep one relay connection under the Server ciphertext byte rate. */
export function createCiphertextPacer(
  limit = CIPHERTEXT_PACE_BYTES_PER_SECOND,
  windowMs = CIPHERTEXT_PACE_WINDOW_MS,
) {
  let stamps: { at: number; bytes: number }[] = [];
  let reserved = 0;
  return {
    async wait(nextBytes: number): Promise<void> {
      const started = Date.now();
      for (;;) {
        const now = Date.now();
        stamps = stamps.filter((entry) => entry.at > now - windowMs);
        const used = stamps.reduce((sum, entry) => sum + entry.bytes, 0);
        if (used + reserved + nextBytes <= limit) {
          reserved += nextBytes;
          return;
        }
        if (now - started > 30_000) {
          throw new RemoteProtocolError('RATE_LIMITED', 'ciphertext pacing timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    note(bytes: number): void {
      reserved = Math.max(0, reserved - bytes);
      stamps.push({ at: Date.now(), bytes });
    },
  };
}

/** Token bucket for frame sends. Absorbs bursts up to the bucket capacity,
 *  then refills at a sustained rate that stays below the Relay's rolling
 *  frame-count limit. Callers reserve slots in arrival order. */
export function createRelayFrameTokenBucket(
  capacity = RELAY_FRAME_BURST_CAPACITY,
  refillPerSecond = RELAY_FRAME_REFILL_PER_SECOND,
) {
  let tokens = capacity;
  let last = Date.now();
  return {
    async wait(): Promise<void> {
      for (;;) {
        const now = Date.now();
        tokens = Math.min(capacity, tokens + ((now - last) * refillPerSecond) / 1000);
        last = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const deficitMs = Math.ceil(((1 - tokens) * 1000) / refillPerSecond);
        await new Promise((resolve) => setTimeout(resolve, Math.max(deficitMs, 5)));
      }
    },
  };
}
