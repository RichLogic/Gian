import type { Executor } from '@gian/shared';
import type { CliRuntimeManager } from './manager.js';

export const DEFAULT_RUNTIME_GUARD_INTERVAL_MS = 5 * 60_000;

export interface RuntimeGuardianOptions {
  runtimes: CliRuntimeManager;
  closeRuntimeOwner: (cli: Executor) => Promise<void>;
  intervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Periodically retires a Proxy whose externally managed CLI bytes changed in
 * place. Gian's own installer is serialized by the updater lease; this guard
 * covers manual/npm/vendor mutations that do not participate in that lock.
 */
export class RuntimeGuardian {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly options: RuntimeGuardianOptions) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_RUNTIME_GUARD_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('Runtime guardian interval must be a positive integer.');
    }
    this.timer = setInterval(() => {
      void this.checkNow().catch(error => {
        this.options.log?.('[runtime] scheduled guardian check failed', error);
      });
    }, intervalMs);
    this.timer.unref();
  }

  checkNow(): Promise<void> {
    if (this.running) return this.running;
    const running = this.run().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Scheduled checks already report their own failure. Shutdown must still
    // reach ProxyManager.closeAll(), which is the final cleanup barrier.
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const changed = await this.options.runtimes.detectExternalChanges();
    const failures: unknown[] = [];
    for (const cli of changed) {
      this.options.log?.(`[runtime] ${cli} CLI content changed; retiring its active Proxy`);
      try {
        await this.options.closeRuntimeOwner(cli);
        this.options.runtimes.invalidate(cli);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more externally changed CLI runtimes could not be retired.',
      );
    }
  }
}
