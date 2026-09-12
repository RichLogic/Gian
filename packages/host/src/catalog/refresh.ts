import type { CatalogSourceClient } from './source-client.js';

export const DEFAULT_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

export class CatalogRefreshController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly options: {
      sourceClient?: CatalogSourceClient;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (!this.options.sourceClient || this.timer) return;
    this.abort = new AbortController();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs ?? DEFAULT_CATALOG_REFRESH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  private tick(): Promise<void> {
    if (!this.options.sourceClient || this.abort?.signal.aborted) {
      return Promise.resolve();
    }
    if (this.inFlight) return this.inFlight;
    const client = this.options.sourceClient;
    const signal = this.abort?.signal;
    this.inFlight = client.sync(signal).then(() => undefined, () => undefined).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
