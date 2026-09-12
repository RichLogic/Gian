import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  RELAY_FRAME_PACE_INTERVAL_MS,
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

/** Reserve evenly spaced send slots so a burst cannot trip the Relay's
 *  rolling frame-count limit. Concurrent callers retain reservation order. */
export function createRelayFramePacer(intervalMs = RELAY_FRAME_PACE_INTERVAL_MS) {
  let nextAt = 0;
  return {
    async wait(): Promise<void> {
      const now = Date.now();
      const sendAt = Math.max(now, nextAt);
      nextAt = sendAt + intervalMs;
      const delay = sendAt - now;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    },
  };
}
