import type { ManagedRuntimeGeneration } from '@gian/shared';
import { parseProxyPluginId } from '@gian/shared';

import type { AgentManager } from '../agents/manager.js';
import type { CatalogService } from '../catalog/service.js';
import { ManagedRuntimeActivationService } from './activation-service.js';
import { ManagedRuntimeInstaller } from './installer.js';
import { RuntimeControlPlane } from './control-plane.js';
import { RuntimeResolver } from './resolver.js';

export class ManagedRuntimeDeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedRuntimeDeliveryError';
  }
}

/** Installs one complete certified Proxy + Runtime combination. Proxy bytes
 * come from the Catalog-bound Gian Release coordinate; managed CLI bytes are
 * written only below dataDir/runtimes by ManagedRuntimeInstaller. */
export class ManagedRuntimeDeliveryService {
  constructor(private readonly options: {
    agents: AgentManager;
    catalog: CatalogService;
    installer: ManagedRuntimeInstaller;
    activation: ManagedRuntimeActivationService;
    runtimeControl: RuntimeControlPlane;
    resolver: RuntimeResolver;
  }) {}

  async install(pluginId: string, agentId?: string): Promise<ManagedRuntimeGeneration> {
    const id = parseProxyPluginId(pluginId);
    if (agentId) {
      const agent = this.options.agents.getAgent(agentId);
      if (agent.pluginId !== id) {
        throw new ManagedRuntimeDeliveryError(
          'RUNTIME_AGENT_MISMATCH',
          'The Agent does not use the requested Proxy.',
        );
      }
    }

    let item = await this.options.catalog.get(id);
    if (!item) {
      // Startup refresh is intentionally asynchronous so an offline Catalog
      // never delays Host readiness. An explicit install, however, is a
      // network-authorized user action and must await one current signed
      // snapshot instead of racing the background refresh against an empty
      // fresh-profile store.
      await this.options.catalog.sync();
      item = await this.options.catalog.get(id);
    }
    if (!item) {
      throw new ManagedRuntimeDeliveryError(
        'RUNTIME_CATALOG_MISSING',
        `${id} is not present in the trusted Catalog.`,
      );
    }
    if (item.compatibility.state !== 'compatible') {
      throw new ManagedRuntimeDeliveryError(
        'RUNTIME_COMBINATION_INCOMPATIBLE',
        `${id} has no Runtime combination compatible with this Gian version.`,
      );
    }
    if (item.installation.state === 'not_installed'
      || item.installation.state === 'quarantined'
      || item.installation.state === 'invalid') {
      await this.options.catalog.install(id);
      item = await this.options.catalog.get(id);
    } else if (item.installation.state === 'installed' && item.installation.updateAvailable) {
      await this.options.catalog.update(id);
      item = await this.options.catalog.get(id);
    }
    if (item?.installation.state !== 'installed') {
      throw new ManagedRuntimeDeliveryError(
        'RUNTIME_PROXY_NOT_READY',
        `${id} Proxy could not be installed from its Gian Release.`,
      );
    }

    let externalEntryPath: string | undefined;
    if (this.options.catalog.managedRuntimeKind(id) === 'external-app') {
      const discovered = await this.options.runtimeControl.discover(id);
      externalEntryPath = discovered.candidates[0]?.path;
      if (!externalEntryPath) {
        throw new ManagedRuntimeDeliveryError(
          'RUNTIME_EXTERNAL_NOT_FOUND',
          `${discovered.runtime.displayName ?? id} is not installed on this machine.`,
        );
      }
    }

    const plan = await this.options.catalog.managedRuntimePlan(id, externalEntryPath);
    const status = await this.options.agents.managedRuntimeStatus(id);
    if (status.active) {
      if (status.active.generationId === plan.generationId) return status.active;
    }
    const staged = await this.options.installer.install(plan);

    if (staged.runtime) {
      const launch = await this.options.agents.trustedLaunch(id);
      if (!launch) {
        throw new ManagedRuntimeDeliveryError(
          'RUNTIME_PROXY_NOT_READY',
          `${id} Proxy disappeared before Runtime verification.`,
        );
      }
      const resolved = await this.options.resolver.resolve({
        pluginId: id,
        pluginVersion: launch.pluginVersion,
        agentId: agentId ?? 'runtime-install',
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        runtime: launch.runtime,
        selectedPath: staged.runtime.entryPath,
      });
      try {
        if (resolved.readinessIssue) {
          throw new ManagedRuntimeDeliveryError(
            resolved.readinessIssue.code,
            resolved.readinessIssue.message,
          );
        }
      } finally {
        await resolved.lease?.release();
      }
    }

    return this.options.activation.activate(id, staged.generationId);
  }
}
