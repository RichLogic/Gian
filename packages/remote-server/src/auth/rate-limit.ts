import { type Clock } from '../clock.js';

export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly now: Clock,
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const next = (this.#hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (next.length >= this.limit) {
      this.#hits.set(key, next);
      return false;
    }
    next.push(now);
    this.#hits.set(key, next);
    return true;
  }
}
