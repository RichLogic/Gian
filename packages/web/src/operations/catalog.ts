/**
 * UI Operation Layer — Proxy Catalog domain (WP4, issue #146). Catalog
 * install/update/rollback mutate the Host PluginStore; sync refreshes the
 * signed remote Catalog. All PENDING REST operations keyed by
 * `catalog:<pluginId>` (`catalog:sync` for the source-level refresh) so the
 * Agents page can drive busy/disabled states from pending runs.
 */
import type {
  ManagedRuntimeGeneration,
  ManagedRuntimeInstallProgress,
  ProxyCatalogList,
  RuntimeDiscoverResponse,
  RuntimeProbeResponse,
} from '@gian/shared';

import {
  discoverProxyRuntime,
  installCatalogProxy,
  installManagedRuntime,
  probeProxyRuntime,
  rollbackCatalogProxy,
  syncProxyCatalog,
  updateCatalogProxy,
  type CatalogMutationReceipt,
} from '../api.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one Catalog entry's install/update/rollback operations. */
export function catalogEntityKey(pluginId: string): string {
  return `catalog:${pluginId}`;
}

/** Entity key for one Catalog entry's Runtime discover/probe operations —
 *  isolated per pluginId so concurrent setup on two Proxies never blocks
 *  each other and the duplicate-submission guard stays per-Proxy. */
export function runtimeEntityKey(pluginId: string): string {
  return `catalog:${pluginId}:runtime`;
}

export const CATALOG_SYNC_ENTITY_KEY = 'catalog:sync';

/** Installs download/verify bounded archives — same budget as Agent installs. */
const INSTALL_TIMEOUT_MS = 120_000;
const RUNTIME_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Conditional metadata sync is a plain REST round-trip. */
const REST_TIMEOUT_MS = 30_000;

interface CatalogPluginInput {
  pluginId: string;
  /** Ephemeral renderer callback; only the REST executor consumes it. It is
   * never serialized or sent to the Host as request data. */
  onProgress?: (progress: ManagedRuntimeInstallProgress) => void;
}

function reportCatalogProgress(
  input: CatalogPluginInput,
  progress: ManagedRuntimeInstallProgress,
): void {
  try { input.onProgress?.(progress); } catch { /* presentation callback */ }
}

const catalogSync: OperationDefinition<Record<string, never>, ProxyCatalogList> = {
  policy: 'pending',
  entityKey: () => CATALOG_SYNC_ENTITY_KEY,
  execute: () => syncProxyCatalog(),
  timeoutMs: REST_TIMEOUT_MS,
};

const catalogInstallProxy: OperationDefinition<CatalogPluginInput, CatalogMutationReceipt> = {
  policy: 'pending',
  entityKey: input => catalogEntityKey(input.pluginId),
  execute: async input => {
    reportCatalogProgress(input, { stage: 'proxy', status: 'started' });
    const receipt = await installCatalogProxy(input.pluginId);
    reportCatalogProgress(input, { stage: 'proxy', status: 'completed' });
    return receipt;
  },
  timeoutMs: INSTALL_TIMEOUT_MS,
};

interface CatalogRuntimeInstallInput extends CatalogPluginInput {
  agentId?: string;
}

const catalogInstallRuntime: OperationDefinition<CatalogRuntimeInstallInput, ManagedRuntimeGeneration> = {
  policy: 'pending',
  entityKey: input => runtimeEntityKey(input.pluginId),
  execute: input => input.onProgress
    ? installManagedRuntime(input.pluginId, input.agentId, input.onProgress)
    : installManagedRuntime(input.pluginId, input.agentId),
  timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS,
};

const catalogUpdateProxy: OperationDefinition<CatalogPluginInput, CatalogMutationReceipt> = {
  policy: 'pending',
  entityKey: input => catalogEntityKey(input.pluginId),
  execute: async input => {
    reportCatalogProgress(input, { stage: 'proxy', status: 'started' });
    const receipt = await updateCatalogProxy(input.pluginId);
    reportCatalogProgress(input, { stage: 'proxy', status: 'completed' });
    return receipt;
  },
  timeoutMs: INSTALL_TIMEOUT_MS,
};

const catalogRollbackProxy: OperationDefinition<CatalogPluginInput, CatalogMutationReceipt> = {
  policy: 'pending',
  entityKey: input => catalogEntityKey(input.pluginId),
  execute: input => rollbackCatalogProxy(input.pluginId),
  timeoutMs: INSTALL_TIMEOUT_MS,
};

interface RuntimeProbeInput extends CatalogPluginInput {
  /** Raw absolute path as typed/picked by the user. The Host canonicalizes
   *  and validates it; Web never pre-judges the filesystem. */
  path: string;
}

const catalogDiscoverRuntime: OperationDefinition<CatalogPluginInput, RuntimeDiscoverResponse> = {
  policy: 'pending',
  entityKey: input => runtimeEntityKey(input.pluginId),
  execute: input => discoverProxyRuntime(input.pluginId),
  timeoutMs: REST_TIMEOUT_MS,
};

const catalogProbeRuntime: OperationDefinition<RuntimeProbeInput, RuntimeProbeResponse> = {
  policy: 'pending',
  entityKey: input => runtimeEntityKey(input.pluginId),
  execute: input => probeProxyRuntime(input.pluginId, input.path),
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('catalog.sync', catalogSync);
registry.register('catalog.installProxy', catalogInstallProxy);
registry.register('catalog.installRuntime', catalogInstallRuntime);
registry.register('catalog.updateProxy', catalogUpdateProxy);
registry.register('catalog.rollbackProxy', catalogRollbackProxy);
registry.register('catalog.discoverRuntime', catalogDiscoverRuntime);
registry.register('catalog.probeRuntime', catalogProbeRuntime);
