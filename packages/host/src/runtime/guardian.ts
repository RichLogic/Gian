import { productExecutorForPluginId } from '@gian/shared';

import type { RuntimeReadinessCache } from './readiness-cache.js';
import type { RuntimeResolver } from './resolver.js';

export const DEFAULT_RUNTIME_GUARD_INTERVAL_MS = 5 * 60_000;

export interface RuntimeGuardianOptions {
  resolver: RuntimeResolver;
  readinessCache?: RuntimeReadinessCache;
  closeRuntimeOwner: (pluginId: string) => Promise<void>;
  intervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Periodically retires a Proxy whose externally managed CLI bytes changed in
 * place. Gian's own installer is serialized by the updater lease; this guard
 * covers manual/npm/vendor mutations that do not participate in that lock.
 *
 * Readiness is invalidated before owner shutdown is attempted. A close
 * failure must not leave Catalog projecting ready.
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
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const extra = this.options.readinessCache?.observations() ?? [];
    const changed = await this.options.resolver.detectExternalChanges(extra);
    const failures: unknown[] = [];
    for (const pluginId of [...new Set(changed)]) {
      this.options.log?.(`[runtime] ${pluginId} Runtime content changed; invalidating readiness`);
      this.options.readinessCache?.invalidate(pluginId);
      this.options.resolver.invalidate(pluginId);
      try {
        await this.options.closeRuntimeOwner(pluginId);
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

export function runtimeOwnerExecutorId(pluginId: string): string | null {
  return productExecutorForPluginId(pluginId);
}

/** Official reverse-domain aliases map to the current legacy owner.
 *  Unknown pluginIds keep their open owner key. */
export function runtimeOwnerCloseKey(pluginId: string): string {
  return productExecutorForPluginId(pluginId) ?? pluginId;
}

export function bindRuntimeOwnerCloser(
  closeByOwner: (owner: string) => Promise<void>,
): (pluginId: string) => Promise<void> {
  return async (pluginId) => {
    await closeByOwner(runtimeOwnerCloseKey(pluginId));
  };
}
