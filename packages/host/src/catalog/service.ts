import { createHash } from 'node:crypto';

import {
  assertCatalogImageMagic,
  CATALOG_DOCUMENT_KEYS,
  isApprovedRuntimeAssetUrl,
  type CompiledCatalogEntryV1,
} from '@gian/proxy-catalog-contract';
import type { ManifestV4 } from '@gian/proxy-protocol';
import {
  parseProxyPluginId,
  type ManagedRuntimeInstallPlan,
  type ManagedRuntimePlatform,
  type OfficialCatalogSourcePolicy,
  type ProxyCatalogItem,
  type ProxyCatalogList,
  type ProxyCatalogSourceState,
} from '@gian/shared';

import type { CatalogSourceClient } from './source-client.js';
import type { CatalogStore } from './store.js';
import type { CatalogSnapshot } from './types.js';
import { classifyCatalogCompatibility, hostProtocolVersions } from './compatibility.js';
import type { PluginInstallReceipt } from '../plugin-store/receipt.js';
import { compareSemver } from '../plugin-store/semver.js';
import type { PluginStore } from '../plugin-store/store.js';
import type { InstalledPackageView, PluginCurrentLaunch, PluginInstallCoordinate } from '../plugin-store/types.js';
import { PluginStoreError } from '../plugin-store/errors.js';
import type { RuntimeReadinessCache } from '../runtime/readiness-cache.js';
import type { OfficialPresence } from '../runtime/trusted-launch.js';
import type { RuntimeKind } from '../runtime/resolver.js';

export type OfficialBundledLaunch = OfficialPresence;

export class CatalogService {
  constructor(
    private readonly options: {
      store: CatalogStore;
      plugins: PluginStore;
      policy: OfficialCatalogSourcePolicy;
      sourceClient?: CatalogSourceClient;
      hostVersions?: readonly string[];
      platform?: string;
      readinessCache?: RuntimeReadinessCache;
      managedRuntimeStatus?: (pluginId: string) => Promise<import('@gian/shared').ManagedRuntimeStatus>;
      officialPresence?: (pluginId: string) => Promise<OfficialBundledLaunch | null>;
      onPluginGenerationChanged?: (pluginId: string) => void;
    },
  ) {}

  async list(): Promise<ProxyCatalogList> {
    const snapshot = this.options.store.snapshot();
    const installed = await this.options.plugins.listInstalled();
    const installedById = new Map(installed.map((item) => [item.pluginId, item]));
    const items: ProxyCatalogItem[] = [];
    const seen = new Set<string>();
    for (const entry of snapshot.index?.plugins ?? []) {
      items.push(await this.project(entry, installedById.get(entry.pluginId) ?? null));
      seen.add(entry.pluginId);
    }
    for (const local of installed) {
      if (seen.has(local.pluginId)) continue;
      items.push(await this.projectInstalledOnly(local));
    }
    return {
      source: sourceState(snapshot.state, snapshot.sequence, snapshot.error, this.options.policy.sourceId),
      items,
    };
  }

  async get(pluginId: string): Promise<ProxyCatalogItem | null> {
    const id = parseProxyPluginId(pluginId);
    const list = await this.list();
    return list.items.find((item) => item.pluginId === id) ?? null;
  }

  async sync(): Promise<ProxyCatalogList> {
    if (!this.options.sourceClient) {
      throw new PluginStoreError('CATALOG_SYNC_UNAVAILABLE', 'Catalog source client is not configured.');
    }
    await this.options.sourceClient.sync();
    return this.list();
  }

  async install(pluginId: string): Promise<PluginInstallReceipt> {
    const view = await this.captureView();
    const item = await this.requireProjectedFrom(view, pluginId);
    const legacy = item.installation.state === 'quarantined'
      || item.installation.state === 'invalid';
    if (
      item.compatibility.state !== 'compatible'
      || (item.installation.state !== 'not_installed' && !legacy)
    ) {
      throw new PluginStoreError(
        'CATALOG_INSTALL_FORBIDDEN',
        `${item.pluginId} can be installed only when compatible and not installed or legacy.`,
      );
    }
    const receipt = await this.options.plugins.install(
      this.coordinateFrom(view, pluginId),
      { replaceLegacyCurrent: legacy },
    );
    this.retirePluginGeneration(item.pluginId);
    return receipt;
  }

  async update(pluginId: string): Promise<PluginInstallReceipt> {
    const view = await this.captureView();
    const item = await this.requireProjectedFrom(view, pluginId);
    const installed = item.installation.installedVersion;
    const latest = item.installation.latestVersion;
    if (
      item.compatibility.state !== 'compatible'
      || item.installation.state !== 'installed'
      || !installed
      || !latest
      || compareSemver(latest, installed) <= 0
    ) {
      throw new PluginStoreError(
        'CATALOG_UPDATE_FORBIDDEN',
        `${item.pluginId} can be updated only when compatible, installed, and strictly newer.`,
      );
    }
    const receipt = await this.options.plugins.install(this.coordinateFrom(view, pluginId));
    this.retirePluginGeneration(item.pluginId);
    return receipt;
  }

  async rollback(pluginId: string, pluginVersion?: string): Promise<PluginInstallReceipt> {
    const id = parseProxyPluginId(pluginId);
    const receipt = await this.options.plugins.rollback(id, pluginVersion);
    this.retirePluginGeneration(id);
    return receipt;
  }

  async managedRuntimePlan(
    pluginId: string,
    externalEntryPath?: string,
  ): Promise<ManagedRuntimeInstallPlan> {
    const view = await this.captureView();
    const id = parseProxyPluginId(pluginId);
    const entry = view.snapshot.index?.plugins.find(item => item.pluginId === id) ?? null;
    const combination = entry?.stable.combination;
    if (!entry || !combination) {
      throw new PluginStoreError(
        'RUNTIME_COMBINATION_MISSING',
        `${id} has no certified Runtime combination in the trusted Catalog.`,
      );
    }
    const runtimePrefixes = this.options.policy.runtimeAssetPrefixes
      ?? this.options.policy.artifactRepositories.map(
        repository => `https://github.com/${repository}/releases/download/`,
      );
    const managedDistributions = [
      ...(combination.runtime?.kind === 'native-binary' ? [combination.runtime] : []),
      ...combination.companions.map(companion => companion.distribution),
    ];
    if (managedDistributions.some(distribution => (
      !isApprovedRuntimeAssetUrl(distribution.asset.url, runtimePrefixes)
    ))) {
      throw new PluginStoreError(
        'RUNTIME_SOURCE_FORBIDDEN',
        `${id} Runtime asset is outside the App-pinned official channels.`,
      );
    }
    const installed = view.installedById.get(id) ?? null;
    const current = installed?.versions.find(item => item.version === installed.currentVersion) ?? null;
    const receipt = current?.state === 'valid' ? current.receipt : null;
    const launch = receipt ? await this.options.plugins.currentLaunch(id) : null;
    const platform = this.platform();
    const archive = entry.stable.artifacts[platform as keyof typeof entry.stable.artifacts];
    if (
      !receipt
      || !launch
      || !entry.stable.manifest
      || !archive
      || launch.pluginVersion !== entry.stable.pluginVersion
      || receipt.manifestSha256 !== entry.stable.manifest.sha256
      || receipt.archiveSha256 !== archive.sha256
    ) {
      throw new PluginStoreError(
        'RUNTIME_PROXY_NOT_READY',
        `${id} must have the exact trusted Catalog Proxy installed before its Runtime.`,
      );
    }
    if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(platform)) {
      throw new PluginStoreError('RUNTIME_PLATFORM', `Managed Runtime platform is unsupported: ${platform}.`);
    }
    const runtime = combination.runtime?.kind === 'external-app'
      ? {
        ...combination.runtime,
        entryPath: externalEntryPath ?? (() => {
          throw new PluginStoreError(
            'RUNTIME_EXTERNAL_NOT_FOUND',
            `${id} external application Runtime was not found on this machine.`,
          );
        })(),
      }
      : combination.runtime;
    return {
      generationId: combination.generationId,
      pluginId: id,
      platform: platform as ManagedRuntimePlatform,
      proxy: {
        pluginVersion: launch.pluginVersion,
        manifestSha256: receipt.manifestSha256,
        artifactSha256: receipt.archiveSha256,
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        protocolRange: launch.protocolRange,
      },
      runtime,
      companions: combination.companions.map(companion => ({
        id: companion.id,
        distribution: { ...companion.distribution },
      })),
      certificate: { ...combination.certificate },
    };
  }

  managedRuntimeKind(pluginId: string): 'native-binary' | 'external-app' | null {
    const id = parseProxyPluginId(pluginId);
    return this.catalogEntry(id)?.stable.combination?.runtime?.kind ?? null;
  }

  private retirePluginGeneration(pluginId: string): void {
    this.options.readinessCache?.invalidate(pluginId);
    this.options.onPluginGenerationChanged?.(pluginId);
  }

  async logo(
    pluginId: string,
    variant: 'light' | 'dark',
  ): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/webp'; sha256: string } | null> {
    const id = parseProxyPluginId(pluginId);
    const entry = this.catalogEntry(id);
    if (!entry) return null;
    const ref = entry.branding[variant];
    const bytes = this.cachedAsset(ref.path, ref.sha256, ref.size);
    if (!bytes) return null;
    assertCatalogImageMagic(bytes, ref.mediaType);
    return { bytes, mediaType: ref.mediaType, sha256: ref.sha256 };
  }

  async documentation(
    pluginId: string,
    document: (typeof CATALOG_DOCUMENT_KEYS)[number],
  ): Promise<{ bytes: Buffer; mediaType: 'text/markdown; charset=utf-8' } | null> {
    const id = parseProxyPluginId(pluginId);
    const entry = this.catalogEntry(id);
    if (!entry) return null;
    const ref = entry.documentation[document];
    const bytes = this.cachedAsset(ref.path, ref.sha256, ref.size);
    if (!bytes) return null;
    return { bytes, mediaType: 'text/markdown; charset=utf-8' };
  }

  private async captureView(): Promise<CatalogActionView> {
    const snapshot = this.options.store.snapshot();
    const installed = await this.options.plugins.listInstalled();
    return {
      snapshot,
      installedById: new Map(installed.map((item) => [item.pluginId, item])),
    };
  }

  private async requireProjectedFrom(view: CatalogActionView, pluginId: string) {
    const id = parseProxyPluginId(pluginId);
    const entry = view.snapshot.index?.plugins.find((item) => item.pluginId === id) ?? null;
    if (!entry) {
      throw new PluginStoreError('CATALOG_ENTRY_MISSING', `${pluginId} is not present in the trusted Catalog.`);
    }
    return this.project(entry, view.installedById.get(id) ?? null);
  }

  private coordinateFrom(view: CatalogActionView, pluginId: string): PluginInstallCoordinate {
    const id = parseProxyPluginId(pluginId);
    const entry = view.snapshot.index?.plugins.find((item) => item.pluginId === id) ?? null;
    if (!entry) {
      throw new PluginStoreError('CATALOG_ENTRY_MISSING', `${id} is not present in the trusted Catalog.`);
    }
    const platform = this.platform();
    const archive = entry.stable.artifacts[platform as keyof typeof entry.stable.artifacts];
    if (!entry.stable.manifest || !archive) {
      throw new PluginStoreError('PLUGIN_PLATFORM', `${id} has no artifact for ${platform}.`);
    }
    return {
      pluginId: id,
      pluginVersion: entry.stable.pluginVersion,
      platform,
      manifest: entry.stable.manifest,
      archive,
      sourceId: this.options.policy.sourceId === 'giandev' ? 'giandev' : 'gian-official',
      catalogSequence: view.snapshot.sequence,
      protocolRange: entry.stable.protocolRange,
      processScope: entry.stable.processScope,
      runtime: entry.stable.runtime as ManifestV4['runtime'] | null,
    };
  }

  private catalogEntry(pluginId: string): CompiledCatalogEntryV1 | null {
    return this.options.store.snapshot().index?.plugins.find((item) => item.pluginId === pluginId) ?? null;
  }

  private cachedAsset(path: string, sha256: string, size: number): Buffer | null {
    const files = this.options.store.snapshot().files;
    const bytes = files?.get(path);
    if (!bytes || bytes.byteLength !== size) return null;
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    return bytes;
  }

  private async project(
    entry: CompiledCatalogEntryV1,
    installed: InstalledPackageView | null,
  ): Promise<ProxyCatalogItem> {
    const hostVersions = [...(this.options.hostVersions ?? hostProtocolVersions())];
    const compatibility = classifyCatalogCompatibility(entry.stable.protocolRange, hostVersions);
    const current = installed?.versions.find((item) => item.version === installed.currentVersion);
    const installationState = !installed || installed.currentPointer === 'absent'
      ? 'not_installed'
      : installed.currentPointer === 'unmanaged'
        ? 'quarantined'
        : current?.state === 'valid'
          ? 'installed'
          : 'quarantined';
    const installedVersion = installationState === 'installed' ? installed?.currentVersion ?? null : (
      installationState === 'quarantined' ? installed?.currentVersion ?? null : null
    );
    const latestVersion = entry.stable.pluginVersion;
    const updateAvailable = Boolean(
      installedVersion
      && latestVersion
      && compareSemver(latestVersion, installedVersion) > 0,
    );
    const bundled = await this.options.officialPresence?.(entry.pluginId) ?? null;
    const effectiveInstallation = bundled && installationState === 'not_installed'
      ? 'installed' as const
      : installationState;
    const effectiveInstalledVersion = bundled && !installedVersion
      ? bundled.pluginVersion
      : installedVersion;
    const currentLaunch = installationState === 'installed'
      ? await this.options.plugins.currentLaunch(entry.pluginId)
      : bundled;
    const runtime = await this.projectRuntime(
      entry.pluginId,
      entry.stable.runtime && entry.stable.runtime.kind === 'external'
        ? {
          kind: 'external',
          id: entry.stable.runtime.id,
          displayName: entry.stable.runtime.displayName,
          verifiedVersions: entry.stable.runtime.verifiedVersions,
        }
        : entry.stable.runtime?.kind === 'none'
          ? { kind: 'none' }
          : bundled?.runtime ?? { kind: 'none' },
      currentLaunch,
      effectiveInstallation,
    );
    return {
      pluginId: entry.pluginId,
      displayName: entry.displayName,
      tagline: entry.tagline,
      logo: {
        light: `/api/proxies/${entry.pluginId}/logo/light`,
        dark: `/api/proxies/${entry.pluginId}/logo/dark`,
      },
      documentation: {
        overview: `/api/proxies/${entry.pluginId}/docs/overview`,
        setup: `/api/proxies/${entry.pluginId}/docs/setup`,
        usage: `/api/proxies/${entry.pluginId}/docs/usage`,
        troubleshooting: `/api/proxies/${entry.pluginId}/docs/troubleshooting`,
      },
      compatibility: {
        state: compatibility.state,
        hostVersions,
        protocolRange: entry.stable.protocolRange,
        reason: compatibility.reason,
      },
      installation: {
        state: effectiveInstallation,
        installedVersion: effectiveInstalledVersion,
        latestVersion,
        updateAvailable: bundled ? false : updateAvailable,
        source: installed?.versions.find((item) => item.receipt)?.receipt?.sourceId
          ?? (bundled ? 'gian-official' : null),
      },
      runtime,
      availableActions: catalogProxyActions({
        compatibility: compatibility.state,
        installation: effectiveInstallation,
        updateAvailable: bundled ? false : updateAvailable,
        runtime: runtime.state,
        runtimeRepairable: runtime.state === 'invalid' && runtime.readinessIssue?.repairable === true,
        canRollback: Boolean(!bundled && installed && installed.versions.filter((item) => item.state === 'valid').length > 1),
        installable: !bundled && this.entryIsInstallable(entry),
        runtimeInstallable: Boolean(entry.stable.combination),
      }),
    };
  }

  private async projectInstalledOnly(installed: InstalledPackageView): Promise<ProxyCatalogItem> {
    const current = installed.versions.find((item) => item.version === installed.currentVersion);
    const receipt = current?.receipt;
    const hostVersions = [...(this.options.hostVersions ?? hostProtocolVersions())];
    const compatibility = receipt
      ? classifyCatalogCompatibility(`=${receipt.negotiatedProtocol}`, hostVersions)
      : { state: 'invalid' as const, reason: 'Installed package has no trusted Catalog projection.' };
    const launch = current?.state === 'valid'
      ? await this.options.plugins.currentLaunch(installed.pluginId)
      : null;
    const runtime = current?.state === 'valid'
      ? await this.projectRuntime(
        installed.pluginId,
        launch?.runtime ?? { kind: 'none' },
        launch,
        'installed',
      )
      : { state: 'setup_required' as const, displayName: null };
    return {
      pluginId: installed.pluginId,
      displayName: installed.pluginId,
      tagline: 'Installed locally without a trusted Catalog entry.',
      logo: {
        light: `/api/proxies/${installed.pluginId}/logo/light`,
        dark: `/api/proxies/${installed.pluginId}/logo/dark`,
      },
      documentation: {
        overview: `/api/proxies/${installed.pluginId}/docs/overview`,
        setup: `/api/proxies/${installed.pluginId}/docs/setup`,
        usage: `/api/proxies/${installed.pluginId}/docs/usage`,
        troubleshooting: `/api/proxies/${installed.pluginId}/docs/troubleshooting`,
      },
      compatibility: {
        state: compatibility.state,
        hostVersions,
        protocolRange: receipt?.negotiatedProtocol ?? '',
        reason: compatibility.reason,
      },
      installation: {
        state: current?.state === 'valid' ? 'installed' : 'quarantined',
        installedVersion: installed.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        source: receipt?.sourceId ?? null,
      },
      runtime,
      availableActions: current?.state === 'valid'
        ? catalogProxyActions({
          compatibility: compatibility.state,
          installation: 'installed',
          updateAvailable: false,
          runtime: runtime.state,
          runtimeRepairable: runtime.state === 'invalid' && runtime.readinessIssue?.repairable === true,
          canRollback: true,
          installable: false,
          runtimeInstallable: false,
          official: false,
        })
        : [],
    };
  }

  private async projectRuntime(
    pluginId: string,
    runtime: {
      kind: RuntimeKind;
      id?: string;
      displayName?: string;
      verifiedVersions?: readonly string[];
    },
    launch: PluginCurrentLaunch | OfficialBundledLaunch | null | undefined,
    installation: ProxyCatalogItem['installation']['state'],
  ): Promise<ProxyCatalogItem['runtime']> {
    const managed = await this.options.managedRuntimeStatus?.(pluginId);
    if (managed?.active) {
      return managed.active.runtime
        ? {
          state: 'ready',
          displayName: runtime.displayName
            ?? (launch?.runtime.kind === 'external' ? launch.runtime.displayName : null)
            ?? null,
        }
        : { state: 'not_required', displayName: null };
    }
    if (runtime.kind === 'none' || launch?.runtime.kind === 'none') {
      return { state: 'not_required', displayName: null };
    }
    const displayName = runtime.displayName
      ?? (launch?.runtime.kind === 'external' ? launch.runtime.displayName : null)
      ?? null;
    if (installation !== 'installed' || !launch) {
      return { state: 'setup_required', displayName };
    }
    const snapshot = this.options.readinessCache?.get(pluginId, launch.pluginVersion);
    if (!snapshot) {
      return { state: 'setup_required', displayName };
    }
    return {
      state: snapshot.state,
      displayName: snapshot.displayName ?? displayName,
      ...(snapshot.readinessIssue ? { readinessIssue: snapshot.readinessIssue } : {}),
    };
  }

  private entryIsInstallable(entry: CompiledCatalogEntryV1): boolean {
    return Boolean(entry.stable.manifest && entry.stable.artifacts[this.platform() as keyof typeof entry.stable.artifacts]);
  }

  private platform(): string {
    return this.options.platform
      ?? `${process.platform}-${process.arch}`;
  }
}

interface CatalogActionView {
  snapshot: CatalogSnapshot;
  installedById: Map<string, InstalledPackageView>;
}

function sourceState(
  state: ProxyCatalogSourceState['state'],
  sequence: number | null,
  error: { code: string; message: string } | null,
  sourceId: string,
): ProxyCatalogSourceState {
  return {
    id: sequence === null && state === 'empty' ? null : sourceId,
    sequence,
    state,
    error,
  };
}

export function catalogProxyActions(input: {
  compatibility: ProxyCatalogItem['compatibility']['state'];
  installation: ProxyCatalogItem['installation']['state'];
  updateAvailable: boolean;
  runtime: ProxyCatalogItem['runtime']['state'];
  runtimeRepairable?: boolean;
  canRollback: boolean;
  installable: boolean;
  runtimeInstallable?: boolean;
  official?: boolean;
}): ProxyCatalogItem['availableActions'] {
  const result: ProxyCatalogItem['availableActions'] = [];
  if (
    input.runtimeInstallable === true
    && input.compatibility === 'compatible'
    && (
      input.installation !== 'installed'
      || input.updateAvailable
      || (input.runtime !== 'ready' && input.runtime !== 'not_required')
    )
  ) {
    result.push('install_runtime');
  }
  if (
    input.installable
    && input.runtimeInstallable !== true
    && input.compatibility === 'compatible'
    && (
      input.installation === 'not_installed'
      || input.installation === 'quarantined'
      || input.installation === 'invalid'
    )
  ) {
    result.push('install_proxy');
  }
  if (
    input.installable
    && input.runtimeInstallable !== true
    && input.compatibility === 'compatible'
    && input.installation === 'installed'
    && input.updateAvailable
  ) {
    result.push('update_proxy');
  }
  if (input.canRollback && input.runtimeInstallable !== true) result.push('rollback_proxy');
  if (
    input.runtimeInstallable !== true
    && input.installation === 'installed'
    && input.runtime === 'setup_required'
  ) {
    result.push('open_setup', 'select_runtime');
  }
  if (
    input.runtimeInstallable !== true
    && input.installation === 'installed'
    && input.runtime === 'invalid'
    && input.runtimeRepairable === true
  ) {
    result.push('open_setup', 'select_runtime');
  }
  if (
    input.compatibility === 'compatible'
    && input.installation === 'installed'
    && (input.runtime === 'not_required' || input.runtime === 'ready' || input.runtime === 'unverified')
  ) {
    result.push('create_agent');
  }
  return result;
}

export function isCatalogDocumentKey(
  value: string,
): value is (typeof CATALOG_DOCUMENT_KEYS)[number] {
  return (CATALOG_DOCUMENT_KEYS as readonly string[]).includes(value);
}
