import type { ManagedRuntimeGeneration, ProxyPluginId } from '@gian/shared';
import { parseProxyPluginId } from '@gian/shared';

import {
  acquireAgentUpdateLock,
  type AgentUpdateLease,
} from '../agents/update-lock.js';
import { ManagedRuntimeGenerationStore } from './generation-store.js';

export interface RuntimeActivationBlocker {
  kind: 'turn' | 'interaction';
  id: string;
}

export class ManagedRuntimeActivationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedRuntimeActivationError';
  }
}

export class ManagedRuntimeActivationService {
  constructor(private readonly options: {
    store: ManagedRuntimeGenerationStore;
    lockDataDir: string;
    blockers: (pluginId: ProxyPluginId) => Promise<RuntimeActivationBlocker[]>;
    closeProxy: (pluginId: ProxyPluginId) => Promise<void>;
    drainRuntime: (pluginId: ProxyPluginId) => Promise<void>;
    advanceSessions: (
      pluginId: ProxyPluginId,
      active: ManagedRuntimeGeneration,
      previous: ManagedRuntimeGeneration | null,
    ) => Promise<void>;
    onActivated?: (pluginId: ProxyPluginId) => Promise<void> | void;
    acquireLock?: (
      dataDir: string,
      pluginId: string,
      operation: string,
    ) => Promise<AgentUpdateLease>;
    now?: () => Date;
  }) {}

  async activate(pluginId: string, generationId: string): Promise<ManagedRuntimeGeneration> {
    const id = parseProxyPluginId(pluginId);
    return this.withExclusiveLease(id, 'Runtime activation', async () => {
      await this.assertIdle(id);
      await this.options.closeProxy(id);
      await this.options.drainRuntime(id);
      const active = await this.options.store.activate(
        id,
        generationId,
        this.options.now?.() ?? new Date(),
        (candidate, previous) => this.options.advanceSessions(id, candidate, previous),
      );
      await this.options.onActivated?.(id);
      return active;
    });
  }

  async recover(pluginId: string): Promise<void> {
    const id = parseProxyPluginId(pluginId);
    if (!this.options.store.hasPendingActivation(id)) return;
    await this.withExclusiveLease(id, 'Runtime activation recovery', async () => {
      await this.assertIdle(id);
      await this.options.closeProxy(id);
      await this.options.drainRuntime(id);
      await this.options.store.recover(
        id,
        (candidate, previous) => this.options.advanceSessions(id, candidate, previous),
      );
      await this.options.onActivated?.(id);
    });
  }

  private async assertIdle(pluginId: ProxyPluginId): Promise<void> {
    const blockers = await this.options.blockers(pluginId);
    if (blockers.length === 0) return;
    throw new ManagedRuntimeActivationError(
      'RUNTIME_UPDATE_BUSY',
      `Runtime update is waiting for ${blockers.length} active Turn or Interaction blocker(s).`,
    );
  }

  private async withExclusiveLease<T>(
    pluginId: ProxyPluginId,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const acquire = this.options.acquireLock ?? acquireAgentUpdateLock;
    const lease = await acquire(this.options.lockDataDir, pluginId, operation);
    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await run();
    } catch (error) {
      operationError = error;
    }
    try {
      await lease.release();
    } catch (releaseError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, releaseError],
          `${operation} failed and its exclusive lease could not be released.`,
        );
      }
      throw releaseError;
    }
    if (operationError) throw operationError;
    return value as T;
  }
}
