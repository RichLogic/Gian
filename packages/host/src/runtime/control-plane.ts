import { isCanonicalAbsolutePath, isReservedOfficialPluginId, parseProxyPluginId } from '@gian/shared';
import type { CatalogProxyAction, ProxyCatalogItem, RuntimeDiscoverResponse, RuntimeProbeResponse } from '@gian/shared';

import { catalogProxyActions } from '../catalog/service.js';
import { isGenericRuntimeProtocol } from './launch-mode.js';
import { RuntimeReadinessCache } from './readiness-cache.js';
import { RuntimeResolver, RuntimeResolverError, type RuntimeResolveInput } from './resolver.js';
import type { TrustedLaunch } from './trusted-launch.js';

export class RuntimeControlError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 502;

  constructor(code: string, message: string, status: 400 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = 'RuntimeControlError';
    this.code = code;
    this.status = status;
  }
}

function snapshotState(input: {
  kind: 'none' | 'external';
  readinessIssue?: { code: string; message: string; repairable: boolean };
  verification?: 'verified' | 'unverified' | 'incompatible';
  path?: string | null;
}): 'not_required' | 'setup_required' | 'ready' | 'unverified' | 'invalid' {
  if (input.kind === 'none') return 'not_required';
  if (input.readinessIssue) return 'invalid';
  if (!input.path) return 'setup_required';
  if (input.verification === 'incompatible') return 'invalid';
  if (input.verification === 'unverified') return 'unverified';
  return 'ready';
}

function actionsFromCatalog(
  item: ProxyCatalogItem | null,
  runtimeState: ProxyCatalogItem['runtime']['state'],
  runtimeRepairable = false,
): CatalogProxyAction[] {
  if (item) {
    return catalogProxyActions({
      compatibility: item.compatibility.state,
      installation: item.installation.state,
      updateAvailable: item.installation.updateAvailable,
      runtime: runtimeState,
      runtimeRepairable,
      canRollback: item.availableActions.includes('rollback_proxy'),
      installable: item.availableActions.includes('install_proxy')
        || item.availableActions.includes('update_proxy')
        || item.installation.state === 'not_installed',
      official: isReservedOfficialPluginId(item.pluginId),
    });
  }
  return catalogProxyActions({
    compatibility: 'compatible',
    installation: 'installed',
    updateAvailable: false,
    runtime: runtimeState,
    runtimeRepairable,
    canRollback: false,
    installable: false,
    official: true,
  });
}

export class RuntimeControlPlane {
  constructor(
    private readonly options: {
      resolver: RuntimeResolver;
      cache: RuntimeReadinessCache;
      resolveLaunch: (pluginId: string) => Promise<TrustedLaunch | null>;
      catalogItem?: (pluginId: string) => Promise<ProxyCatalogItem | null>;
      /** Test seam. Production construction always supplies catalogItem. */
      allowMissingCatalogPolicy?: boolean;
    },
  ) {
    if (!options.catalogItem && !options.allowMissingCatalogPolicy) {
      throw new RuntimeControlError(
        'RUNTIME_CATALOG_POLICY_REQUIRED',
        'RuntimeControlPlane requires a Catalog item policy.',
      );
    }
  }

  async discover(pluginId: string): Promise<RuntimeDiscoverResponse> {
    const id = parseProxyPluginId(pluginId);
    const launch = await this.requireLaunch(id);
    const item = await this.options.catalogItem?.(id) ?? null;
    const authorized = this.authorizeSpawn(item, launch);
    if (launch.runtime.kind === 'none') {
      return {
        pluginId: id,
        pluginVersion: launch.pluginVersion,
        runtime: { kind: 'none' },
        candidates: [],
        setupActions: [],
        availableActions: authorized.actions,
      };
    }
    if (!authorized.canSpawn) {
      return {
        pluginId: id,
        pluginVersion: launch.pluginVersion,
        runtime: {
          kind: 'external',
          id: launch.runtime.id,
          displayName: launch.runtime.displayName,
          verifiedVersions: [...(launch.runtime.verifiedVersions ?? [])],
        },
        candidates: [],
        setupActions: [],
        availableActions: authorized.actions,
      };
    }
    this.assertGeneric(launch);
    const result = await this.options.resolver.discover(this.resolveInput(id, launch, null));
    return {
      pluginId: id,
      pluginVersion: launch.pluginVersion,
      runtime: {
        kind: 'external',
        id: launch.runtime.id,
        displayName: launch.runtime.displayName,
        verifiedVersions: [...(launch.runtime.verifiedVersions ?? [])],
      },
      candidates: result.candidates,
      setupActions: result.setupActions,
      availableActions: actionsFromCatalog(item, 'setup_required'),
    };
  }

  async probe(pluginId: string, path: string, agentId = 'draft'): Promise<RuntimeProbeResponse> {
    const id = parseProxyPluginId(pluginId);
    if (!isCanonicalAbsolutePath(path)) {
      throw new RuntimeControlError(
        'RUNTIME_PATH_INVALID',
        'path must be a canonical absolute path.',
      );
    }
    const launch = await this.requireLaunch(id);
    const item = await this.options.catalogItem?.(id) ?? null;
    const authorized = this.authorizeSpawn(item, launch);
    if (!authorized.canSpawn) {
      throw new RuntimeControlError(
        'RUNTIME_PACKAGE_FORBIDDEN',
        'discover/probe require a compatible installed package.',
        409,
      );
    }
    if (launch.runtime.kind === 'none') {
      throw new RuntimeControlError(
        'RUNTIME_NONE_HAS_PATH',
        'A none Runtime cannot be probed with a path.',
      );
    }
    this.assertGeneric(launch);
    try {
      const resolved = await this.options.resolver.resolve(this.resolveInput(id, launch, path, agentId));
      await resolved.lease?.release();
      const state = snapshotState({
        kind: 'external',
        ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
        verification: resolved.profile.verification,
        path: resolved.profile.path,
      });
      this.options.cache.publish({
        pluginId: id,
        pluginVersion: launch.pluginVersion,
        selectedPath: path,
        profileIdentity: resolved.profile.id,
        state,
        displayName: launch.runtime.displayName ?? null,
        ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
        profile: resolved.profile,
        ...(resolved.observation ? { observation: resolved.observation } : {}),
      });
      return {
        pluginId: id,
        pluginVersion: launch.pluginVersion,
        selectedPath: path,
        profile: resolved.profile,
        ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
        availableActions: actionsFromCatalog(
          item,
          state,
          Boolean(resolved.readinessIssue?.repairable),
        ),
      };
    } catch (error) {
      this.options.cache.invalidate(id, launch.pluginVersion, path);
      if (error instanceof RuntimeResolverError) {
        throw new RuntimeControlError(error.code, error.message, 400);
      }
      throw error;
    }
  }

  private authorizeSpawn(
    item: ProxyCatalogItem | null,
    launch: TrustedLaunch,
  ): { canSpawn: boolean; actions: CatalogProxyAction[] } {
    if (item) {
      const quarantined = item.installation.state === 'quarantined';
      const compatible = item.compatibility.state === 'compatible';
      const installed = item.installation.state === 'installed';
      const canSpawn = installed && compatible && !quarantined;
      return {
        canSpawn,
        actions: item.availableActions,
      };
    }
    if (this.options.allowMissingCatalogPolicy) {
      return {
        canSpawn: true,
        actions: catalogProxyActions({
          compatibility: 'compatible',
          installation: 'installed',
          updateAvailable: false,
          runtime: launch.runtime.kind === 'none' ? 'not_required' : 'setup_required',
          canRollback: false,
          installable: false,
          official: true,
        }),
      };
    }
    return {
      canSpawn: false,
      actions: catalogProxyActions({
        compatibility: 'invalid',
        installation: 'not_installed',
        updateAvailable: false,
        runtime: 'invalid',
        canRollback: false,
        installable: false,
        official: true,
      }),
    };
  }

  private async requireLaunch(pluginId: string): Promise<TrustedLaunch> {
    const launch = await this.options.resolveLaunch(pluginId);
    if (!launch) {
      throw new RuntimeControlError(
        'RUNTIME_PACKAGE_MISSING',
        'No trusted active package is available for this pluginId.',
        404,
      );
    }
    return launch;
  }

  private assertGeneric(launch: TrustedLaunch): void {
    if (!isGenericRuntimeProtocol({
      schemaVersion: launch.schemaVersion,
      runtimeBootstrap: launch.schemaVersion === 4,
    })) {
      throw new RuntimeControlError(
        'RUNTIME_LEGACY_PACKAGE',
        'discover/probe require a trusted v4 Runtime package.',
      );
    }
  }

  private resolveInput(
    pluginId: ReturnType<typeof parseProxyPluginId>,
    launch: TrustedLaunch,
    selectedPath: string | null,
    agentId: string = pluginId,
  ): RuntimeResolveInput {
    if (launch.runtime.kind !== 'external' || !launch.runtime.id || !launch.runtime.displayName) {
      throw new RuntimeControlError(
        'RUNTIME_MANIFEST_INVALID',
        'Trusted Manifest Runtime facts are incomplete.',
      );
    }
    return {
      pluginId,
      pluginVersion: launch.pluginVersion,
      agentId,
      entryPath: launch.entryPath,
      processScope: launch.processScope,
      runtime: {
        kind: 'external',
        id: launch.runtime.id,
        displayName: launch.runtime.displayName,
        verifiedVersions: [...(launch.runtime.verifiedVersions ?? [])],
      },
      selectedPath,
    };
  }
}
