import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { parseGitHubReleaseAssetUrl } from '@gian/proxy-catalog-contract';
import { SUPPORTED_PROTOCOL_VERSIONS, type ManifestV4 } from '@gian/proxy-protocol';
import {
  isProxyPluginId,
  parseProxyPluginId,
  type ProxyPluginId,
} from '@gian/shared';

import { acquireAgentProxyUpdateLock, type AgentUpdateLease } from '../agents/update-lock.js';
import { shutdownProxyProcess } from '../proxy/process-shutdown.js';
import { downloadVerifiedAsset } from './download.js';
import { PluginReferencedError, PluginStoreError, PluginVersionConflictError } from './errors.js';
import { initializeCatalogPackage, offeredProtocolVersionsForInstall } from './initialize.js';
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_MANIFEST_BYTES,
  MAX_PLUGIN_RECEIPT_BYTES,
} from './limits.js';
import { validateCatalogPackage } from './package-validate.js';
import {
  inventoriesEqual,
  parsePluginInstallReceipt,
  PLUGIN_INSTALL_RECEIPT_FILE,
  receiptFileInventory,
  type PluginInstallReceipt,
} from './receipt.js';
import { extractGzipUstar } from './safe-extract.js';
import { compareSemver, sortSemverDescending } from './semver.js';
import { runCatalogProxySelfTest } from './self-test.js';
import { readContainedRegularFile, readPackageInventory } from './containment.js';
import type {
  InstalledPackageView,
  InstalledVersionView,
  PluginArtifactNetwork,
  PluginBindingReference,
  PluginCurrentLaunch,
  PluginExactLaunch,
  PluginInstallCoordinate,
  PluginVersionReferenceReport,
} from './types.js';

const CURRENT = 'current';
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PluginStoreHooks {
  afterCandidateValidated?: (directory: string) => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
  beforeRestore?: () => Promise<void>;
}

export interface PluginInstallOptions {
  /** One-way migration seam for a pre-PluginStore `current -> <semver>`
   * pointer. The old version directory is retained, but only a fully
   * Catalog-validated candidate may replace the pointer. Arbitrary files,
   * directories, escaped links, and concurrent pointer changes still fail
   * closed. */
  replaceLegacyCurrent?: boolean;
}

export class PluginStore {
  private readonly inFlight = new Set<string>();
  private readonly hostVersions: readonly string[];

  constructor(
    private readonly options: {
      dataDir: string;
      pluginsDir: string;
      network: PluginArtifactNetwork;
      allowedArtifactRepositories: readonly string[];
      hostVersion: string;
      hostVersions?: readonly string[];
      updateLockDataDir?: string;
      listBindingReferences?: () => readonly PluginBindingReference[];
      shutdownProcess?: typeof shutdownProxyProcess;
      hooks?: PluginStoreHooks;
    },
  ) {
    this.hostVersions = options.hostVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
  }

  async listInstalled(): Promise<InstalledPackageView[]> {
    await mkdir(this.options.pluginsDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.options.pluginsDir, { withFileTypes: true });
    const views: InstalledPackageView[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isProxyPluginId(entry.name)) continue;
      views.push(await this.inspect(entry.name));
    }
    return views.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  async currentLaunch(pluginId: string): Promise<PluginCurrentLaunch | null> {
    const installed = await this.inspect(pluginId);
    if (installed.currentPointer !== 'valid' || !installed.currentVersion) return null;
    const loaded = await this.loadValidatedRetainedPackage(
      parseProxyPluginId(pluginId),
      installed.currentVersion,
    );
    if (!loaded) return null;
    const entryRel = loaded.manifest.entry;
    const entryPath = await realpath(join(loaded.directory, ...entryRel.split('/')));
    if (relative(loaded.directory, entryPath).split(sep).join('/') !== entryRel) {
      return null;
    }
    return {
      pluginId: loaded.receipt.pluginId,
      displayName: loaded.manifest.displayName,
      pluginVersion: loaded.manifest.pluginVersion,
      manifestSha256: loaded.receipt.manifestSha256,
      entryPath,
      processScope: loaded.manifest.process.scope,
      schemaVersion: 4,
      runtime: loaded.manifest.runtime,
      protocolRange: loaded.manifest.protocol.range,
    };
  }

  async inspect(pluginId: string): Promise<InstalledPackageView> {
    const id = parseProxyPluginId(pluginId);
    const root = this.pluginRoot(id);
    const versions: InstalledVersionView[] = [];
    let listing: string[] = [];
    try {
      listing = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { pluginId: id, currentVersion: null, currentPointer: 'absent', versions };
    }
    for (const name of listing) {
      if (name === CURRENT || name.startsWith('.')) continue;
      if (!SEMVER.test(name)) continue;
      versions.push(await this.inspectVersion(id, name));
    }
    versions.sort((left, right) => compareSemver(right.version, left.version));
    const pointer = await this.inspectCurrentPointer(id);
    return {
      pluginId: id,
      currentVersion: pointer.kind === 'valid' ? pointer.version : null,
      currentPointer: pointer.kind,
      versions,
    };
  }

  async resolveExactLaunch(input: {
    pluginId: string;
    pluginVersion: string;
    expectedManifestSha256: string;
  }): Promise<PluginExactLaunch> {
    const id = parseProxyPluginId(input.pluginId);
    if (!SEMVER.test(input.pluginVersion)) {
      throw new PluginStoreError('PLUGIN_VERSION_INVALID', 'pluginVersion must be SemVer.');
    }
    if (!/^[0-9a-f]{64}$/.test(input.expectedManifestSha256)) {
      throw new PluginStoreError(
        'PLUGIN_DIGEST_MISMATCH',
        'expectedManifestSha256 must be the bound lowercase SHA-256 digest.',
      );
    }
    const directory = join(this.pluginRoot(id), input.pluginVersion);
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginStoreError(
          'PLUGIN_NOT_FOUND',
          `${id}@${input.pluginVersion} is not installed.`,
        );
      }
      throw error;
    }
    const loaded = await this.loadValidatedRetainedPackage(id, input.pluginVersion);
    if (!loaded) {
      throw new PluginStoreError(
        'PLUGIN_QUARANTINED',
        `${id}@${input.pluginVersion} failed revalidation.`,
      );
    }
    if (loaded.receipt.manifestSha256 !== input.expectedManifestSha256) {
      throw new PluginStoreError(
        'PLUGIN_DIGEST_MISMATCH',
        `${id}@${input.pluginVersion} does not match the bound manifest digest.`,
      );
    }
    const entryRel = loaded.manifest.entry;
    const entryBytes = await readContainedRegularFile(
      loaded.directory,
      entryRel,
      MAX_PLUGIN_FILE_BYTES,
    );
    const again = await this.loadValidatedRetainedPackage(id, input.pluginVersion);
    if (
      !again
      || again.receipt.manifestSha256 !== input.expectedManifestSha256
      || again.manifest.entry !== entryRel
    ) {
      throw new PluginStoreError(
        'PLUGIN_QUARANTINED',
        `${id}@${input.pluginVersion} failed revalidation.`,
      );
    }
    const entryMeta = again.receipt.files.find((file) => file.path === entryRel);
    const entrySha256 = createHash('sha256').update(entryBytes).digest('hex');
    if (!entryMeta || entryMeta.sha256 !== entrySha256) {
      throw new PluginStoreError(
        'PLUGIN_QUARANTINED',
        `${id}@${input.pluginVersion} entry changed after validation.`,
      );
    }
    const entryPath = await realpath(join(loaded.directory, ...entryRel.split('/')));
    if (relative(again.directory, entryPath).split(sep).join('/') !== entryRel) {
      throw new PluginStoreError('PLUGIN_PATH_UNSAFE', 'Resolved entry escaped the package.');
    }
    return {
      pluginId: again.receipt.pluginId,
      displayName: again.manifest.displayName,
      pluginVersion: again.receipt.pluginVersion,
      manifestSha256: again.receipt.manifestSha256,
      entryPath,
      processScope: again.receipt.processScope,
      protocolVersion: again.receipt.negotiatedProtocol,
      schemaVersion: 4,
      runtime: again.manifest.runtime,
      protocolRange: again.manifest.protocol.range,
    };
  }

  async removeVersion(pluginId: string, pluginVersion: string): Promise<void> {
    const refs = await this.reportReferences(pluginId, pluginVersion);
    if (refs.current || refs.sessionBindings > 0 || refs.inFlight) {
      throw new PluginReferencedError(refs.pluginId, refs.pluginVersion);
    }
    const directory = join(this.pluginRoot(parseProxyPluginId(pluginId)), pluginVersion);
    await rm(directory, { recursive: true, force: false });
  }

  async reportReferences(pluginId: string, pluginVersion: string): Promise<PluginVersionReferenceReport> {
    const id = parseProxyPluginId(pluginId);
    const installed = await this.inspect(id);
    const bindings = (this.options.listBindingReferences?.() ?? [])
      .filter((item) => item.pluginId === id && item.pluginVersion === pluginVersion);
    return {
      pluginId: id,
      pluginVersion,
      current: installed.currentVersion === pluginVersion,
      sessionBindings: bindings.length,
      inFlight: this.inFlight.has(flightKey(id, pluginVersion)),
    };
  }

  async install(
    coordinate: PluginInstallCoordinate,
    options: PluginInstallOptions = {},
  ): Promise<PluginInstallReceipt> {
    const pluginId = parseProxyPluginId(coordinate.pluginId);
    if (!SEMVER.test(coordinate.pluginVersion)) {
      throw new PluginStoreError('PLUGIN_VERSION_INVALID', 'pluginVersion must be SemVer.');
    }
    offeredProtocolVersionsForInstall(coordinate.protocolRange, this.hostVersions);
    const lease = await acquireAgentProxyUpdateLock(
      this.options.updateLockDataDir ?? this.options.dataDir,
      pluginId,
      `catalog-install:${pluginId}`,
    );
    const key = flightKey(pluginId, coordinate.pluginVersion);
    this.inFlight.add(key);
    let operationError: unknown;
    try {
      return await this.installLocked(pluginId, coordinate, lease, options);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      this.inFlight.delete(key);
      try {
        await lease.release();
      } catch (releaseError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, releaseError],
            `${pluginId} catalog install failed and its update claim could not be released.`,
          );
        }
        throw releaseError;
      }
    }
  }

  async rollback(pluginId: string, pluginVersion?: string): Promise<PluginInstallReceipt> {
    const id = parseProxyPluginId(pluginId);
    const lease = await acquireAgentProxyUpdateLock(
      this.options.updateLockDataDir ?? this.options.dataDir,
      id,
      `catalog-rollback:${id}`,
    );
    let operationError: unknown;
    try {
      const installed = await this.inspect(id);
      if (installed.currentPointer === 'unmanaged') {
        throw new PluginStoreError(
          'PLUGIN_CURRENT_UNMANAGED',
          `${id} current is not a PluginStore-owned symlink.`,
        );
      }
      const valid = installed.versions.filter((item) => item.state === 'valid' && item.receipt);
      if (valid.length === 0) {
        throw new PluginStoreError('PLUGIN_ROLLBACK_EMPTY', `${id} has no validated package to roll back to.`);
      }
      const ordered = sortSemverDescending(valid.map((item) => item.version));
      const selected = pluginVersion
        ?? ordered.find((version) => version !== installed.currentVersion);
      const target = valid.find((item) => item.version === selected);
      if (!target?.receipt) {
        throw new PluginStoreError('PLUGIN_ROLLBACK_MISSING', `${id} rollback target is not a validated generation.`);
      }
      if (installed.currentVersion === target.version) {
        return target.receipt;
      }
      const receipt = await this.revalidateVersion(id, target.version);
      if (!receipt) {
        throw new PluginStoreError('PLUGIN_QUARANTINED', `${id}@${target.version} failed revalidation.`);
      }
      await this.activateCurrent(id, target.version);
      return receipt;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await lease.release();
      } catch (releaseError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, releaseError],
            `${id} catalog rollback failed and its update claim could not be released.`,
          );
        }
        throw releaseError;
      }
    }
  }

  private async installLocked(
    pluginId: ProxyPluginId,
    coordinate: PluginInstallCoordinate,
    lease: AgentUpdateLease,
    options: PluginInstallOptions,
  ): Promise<PluginInstallReceipt> {
    const legacyCurrentVersion = await this.assertCurrentManagedOrAbsent(
      pluginId,
      options.replaceLegacyCurrent === true,
    );
    const offered = offeredProtocolVersionsForInstall(coordinate.protocolRange, this.hostVersions);
    if (parseGitHubReleaseAssetUrl(coordinate.manifest.url, this.options.allowedArtifactRepositories) === null
      || parseGitHubReleaseAssetUrl(coordinate.archive.url, this.options.allowedArtifactRepositories) === null) {
      throw new PluginStoreError('PLUGIN_URL_REJECTED', 'Install URLs are not approved GitHub release assets.');
    }
    const [, archive] = await Promise.all([
      downloadVerifiedAsset(
        this.options.network,
        coordinate.manifest,
        this.options.allowedArtifactRepositories,
        MAX_PLUGIN_MANIFEST_BYTES,
      ),
      downloadVerifiedAsset(
        this.options.network,
        coordinate.archive,
        this.options.allowedArtifactRepositories,
        MAX_PLUGIN_ARCHIVE_BYTES,
      ),
    ]);

    const root = this.pluginRoot(pluginId);
    const staging = join(root, `.staging-${randomUUID()}`);
    const extracted = join(staging, 'package');
    await mkdir(extracted, { recursive: true, mode: 0o700 });
    try {
      await extractGzipUstar(archive, extracted);
      const validated = await validateCatalogPackage(extracted, {
        pluginId,
        pluginVersion: coordinate.pluginVersion,
        protocolRange: coordinate.protocolRange,
        processScope: coordinate.processScope,
        runtime: coordinate.runtime,
      });
      if (validated.manifestSha256 !== coordinate.manifest.sha256) {
        throw new PluginStoreError(
          'PLUGIN_MANIFEST_DIGEST',
          'Extracted manifest digest does not match the Catalog coordinate.',
        );
      }
      const handshakeOffer = offeredProtocolVersionsForInstall(
        validated.manifest.protocol.range,
        this.hostVersions,
      );
      if (handshakeOffer.join(',') !== offered.join(',')) {
        throw new PluginStoreError(
          'PLUGIN_PROTOCOL_INCOMPATIBLE',
          'Extracted protocol range no longer intersects the Host offer set.',
        );
      }
      await runCatalogProxySelfTest(
        extracted,
        validated.manifest,
        handshakeOffer,
        lease,
        this.options.shutdownProcess,
      );
      const negotiatedProtocol = await initializeCatalogPackage({
        directory: extracted,
        manifest: validated.manifest,
        dataDir: this.options.dataDir,
        hostVersion: this.options.hostVersion,
        hostVersions: handshakeOffer,
        protector: lease,
        shutdownProcess: this.options.shutdownProcess,
      });
      const inventory = receiptFileInventory(await readPackageInventory(extracted));
      const receipt: PluginInstallReceipt = {
        schemaVersion: 1,
        sourceId: coordinate.sourceId,
        catalogSequence: coordinate.catalogSequence,
        pluginId,
        pluginVersion: coordinate.pluginVersion,
        platform: coordinate.platform,
        manifestSha256: coordinate.manifest.sha256,
        archiveSha256: coordinate.archive.sha256,
        negotiatedProtocol,
        processScope: validated.manifest.process.scope,
        installedAt: new Date().toISOString(),
        files: inventory,
      };
      const finalDir = join(root, coordinate.pluginVersion);
      if (await exists(finalDir)) {
        const existing = await this.revalidateVersion(pluginId, coordinate.pluginVersion);
        if (!existing || !inventoriesEqual(existing.files, receipt.files)
          || existing.archiveSha256 !== receipt.archiveSha256
          || existing.manifestSha256 !== receipt.manifestSha256) {
          throw new PluginVersionConflictError(pluginId, coordinate.pluginVersion);
        }
        await this.activateCurrent(pluginId, coordinate.pluginVersion, legacyCurrentVersion);
        return existing;
      }
      await writeFile(
        join(extracted, PLUGIN_INSTALL_RECEIPT_FILE),
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 },
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      await rename(extracted, finalDir);
      const verifiedCandidate = await this.revalidateVersion(pluginId, coordinate.pluginVersion);
      if (!verifiedCandidate) {
        throw new PluginStoreError('PLUGIN_QUARANTINED', `${pluginId} failed candidate revalidation.`);
      }
      await this.options.hooks?.afterCandidateValidated?.(finalDir);
      await this.activateCurrent(pluginId, coordinate.pluginVersion, legacyCurrentVersion);
      return verifiedCandidate;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async inspectVersion(pluginId: ProxyPluginId, version: string): Promise<InstalledVersionView> {
    const receipt = await this.revalidateVersion(pluginId, version);
    if (receipt) return { version, state: 'valid', receipt };
    const directory = join(this.pluginRoot(pluginId), version);
    try {
      await this.assertDirectVersionDirectory(pluginId, directory);
      const raw = await readFile(join(directory, PLUGIN_INSTALL_RECEIPT_FILE), 'utf8');
      const parsed = parsePluginInstallReceipt(JSON.parse(raw));
      if (parsed.ok) return { version, state: 'quarantined', receipt: parsed.receipt };
      return { version, state: 'quarantined', receipt: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version, state: 'legacy', receipt: null };
      }
      return { version, state: 'quarantined', receipt: null };
    }
  }

  async revalidateVersion(
    pluginId: string,
    version: string,
  ): Promise<PluginInstallReceipt | null> {
    const loaded = await this.loadValidatedRetainedPackage(parseProxyPluginId(pluginId), version);
    return loaded?.receipt ?? null;
  }

  private async loadValidatedRetainedPackage(
    id: ProxyPluginId,
    version: string,
  ): Promise<{
    receipt: PluginInstallReceipt;
    manifest: ManifestV4;
    directory: string;
  } | null> {
    try {
      const directory = await this.assertDirectVersionDirectory(id, join(this.pluginRoot(id), version));
      const receiptInfo = await lstat(join(directory, PLUGIN_INSTALL_RECEIPT_FILE));
      if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > MAX_PLUGIN_RECEIPT_BYTES) {
        return null;
      }
      const raw = await readFile(join(directory, PLUGIN_INSTALL_RECEIPT_FILE), 'utf8');
      const parsed = parsePluginInstallReceipt(JSON.parse(raw));
      if (!parsed.ok) return null;
      const receipt = parsed.receipt;
      if (receipt.pluginId !== id || receipt.pluginVersion !== version) return null;
      const manifestBytes = await readContainedRegularFile(directory, 'manifest.json', MAX_PLUGIN_MANIFEST_BYTES);
      if (createHash('sha256').update(manifestBytes).digest('hex') !== receipt.manifestSha256) {
        return null;
      }
      const parsedManifest = JSON.parse(manifestBytes.toString('utf8')) as { protocol?: { range?: string } };
      const validated = await validateCatalogPackage(directory, {
        pluginId: receipt.pluginId,
        pluginVersion: receipt.pluginVersion,
        protocolRange: parsedManifest.protocol?.range ?? '',
        processScope: receipt.processScope,
        runtime: null,
      });
      if (validated.manifestSha256 !== receipt.manifestSha256) return null;
      const inventory = receiptFileInventory(await readPackageInventory(directory));
      if (!inventoriesEqual(inventory, receipt.files)) return null;
      return { receipt, manifest: validated.manifest, directory };
    } catch {
      return null;
    }
  }

  private async assertCurrentManagedOrAbsent(
    pluginId: ProxyPluginId,
    replaceLegacyCurrent = false,
  ): Promise<string | null> {
    const pointer = await this.inspectCurrentPointer(pluginId);
    if (pointer.kind === 'absent') return null;
    if (pointer.kind === 'unmanaged') {
      throw new PluginStoreError(
        'PLUGIN_CURRENT_UNMANAGED',
        `${pluginId} current is not a PluginStore-owned symlink.`,
      );
    }
    const receipt = await this.revalidateVersion(pluginId, pointer.version);
    if (!receipt) {
      if (replaceLegacyCurrent) return pointer.version;
      throw new PluginStoreError(
        'PLUGIN_CURRENT_UNMANAGED',
        `${pluginId} current points at a package PluginStore does not own.`,
      );
    }
    return null;
  }

  private async activateCurrent(
    pluginId: ProxyPluginId,
    version: string,
    replaceLegacyCurrentVersion: string | null = null,
  ): Promise<void> {
    const previous = await this.inspectCurrentPointer(pluginId);
    if (previous.kind === 'unmanaged') {
      throw new PluginStoreError(
        'PLUGIN_CURRENT_UNMANAGED',
        `${pluginId} current is not a PluginStore-owned symlink.`,
      );
    }
    const receipt = await this.revalidateVersion(pluginId, version);
    if (!receipt) {
      throw new PluginStoreError('PLUGIN_QUARANTINED', `${pluginId}@${version} failed pre-publish revalidation.`);
    }
    await this.options.hooks?.beforePublish?.();
    if (previous.kind === 'valid') {
      const previousReceipt = await this.revalidateVersion(pluginId, previous.version);
      if (!previousReceipt && previous.version !== replaceLegacyCurrentVersion) {
        throw new PluginStoreError(
          'PLUGIN_CURRENT_UNMANAGED',
          `${pluginId}@${previous.version} is no longer PluginStore-owned and valid.`,
        );
      }
    }
    await this.publishCurrentPointer(pluginId, version);
    try {
      await this.options.hooks?.afterPublish?.();
      const published = await this.inspectCurrentPointer(pluginId);
      const verified = await this.revalidateVersion(pluginId, version);
      if (published.kind !== 'valid' || published.version !== version || !verified) {
        throw new PluginStoreError('PLUGIN_QUARANTINED', `${pluginId} failed post-publish revalidation.`);
      }
    } catch (error) {
      try {
        await this.restoreCurrentPointer(
          pluginId,
          previous,
          previous.kind === 'valid' && previous.version === replaceLegacyCurrentVersion,
        );
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `${pluginId} activation failed and current pointer restoration failed.`,
        );
      }
      throw error;
    }
  }

  private async publishCurrentPointer(pluginId: ProxyPluginId, version: string): Promise<void> {
    const root = this.pluginRoot(pluginId);
    await this.assertDirectVersionDirectory(pluginId, join(root, version));
    const current = join(root, CURRENT);
    const temporary = join(root, `.current-${randomUUID()}`);
    try {
      await symlink(version, temporary);
      await rename(temporary, current);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError(
            [
              error instanceof PluginStoreError
                ? error
                : new PluginStoreError(
                  'PLUGIN_CURRENT_PUBLISH',
                  `${pluginId} current pointer could not be published.`,
                ),
              cleanupError,
            ],
            `${pluginId} current pointer could not be published and the temporary symlink could not be removed.`,
          );
        }
      }
      if (error instanceof PluginStoreError) throw error;
      throw new PluginStoreError(
        'PLUGIN_CURRENT_PUBLISH',
        `${pluginId} current pointer could not be published.`,
      );
    }
  }

  private async restoreCurrentPointer(
    pluginId: ProxyPluginId,
    previous: CurrentPointer,
    allowLegacy = false,
  ): Promise<void> {
    await this.options.hooks?.beforeRestore?.();
    const current = join(this.pluginRoot(pluginId), CURRENT);
    if (previous.kind === 'absent') {
      try {
        await unlink(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new PluginStoreError(
            'PLUGIN_CURRENT_RESTORE',
            `${pluginId} rejected current pointer could not be removed.`,
          );
        }
      }
      try {
        await lstat(current);
        throw new PluginStoreError(
          'PLUGIN_CURRENT_RESTORE',
          `${pluginId} current pointer is still present after restore unlink.`,
        );
      } catch (error) {
        if (error instanceof PluginStoreError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new PluginStoreError(
            'PLUGIN_CURRENT_RESTORE',
            `${pluginId} current pointer restoration could not be verified.`,
          );
        }
      }
      return;
    }
    if (previous.kind === 'valid') {
      await this.publishCurrentPointer(pluginId, previous.version);
      const restored = await this.inspectCurrentPointer(pluginId);
      const verified = await this.revalidateVersion(pluginId, previous.version);
      if (
        restored.kind !== 'valid'
        || restored.version !== previous.version
        || (!allowLegacy && !verified)
      ) {
        throw new PluginStoreError(
          'PLUGIN_CURRENT_RESTORE',
          `${pluginId} previous current pointer could not be restored.`,
        );
      }
    }
  }

  private async inspectCurrentPointer(pluginId: ProxyPluginId): Promise<CurrentPointer> {
    const current = join(this.pluginRoot(pluginId), CURRENT);
    try {
      const info = await lstat(current);
      if (!info.isSymbolicLink()) return { kind: 'unmanaged' };
      const target = await readlink(current);
      if (target.includes('/') || target.includes('\\') || target.includes('..') || !SEMVER.test(target)) {
        return { kind: 'unmanaged' };
      }
      const resolved = await realpath(current);
      await this.assertDirectVersionDirectory(pluginId, resolved);
      if (basename(resolved) !== target) return { kind: 'unmanaged' };
      return { kind: 'valid', version: target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
      return { kind: 'unmanaged' };
    }
  }

  private async assertDirectVersionDirectory(
    pluginId: ProxyPluginId,
    directory: string,
  ): Promise<string> {
    const root = await realpath(this.pluginRoot(pluginId)).catch(async () => {
      await mkdir(this.pluginRoot(pluginId), { recursive: true, mode: 0o700 });
      return realpath(this.pluginRoot(pluginId));
    });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PluginStoreError('PLUGIN_PATH_UNSAFE', 'Version directory must be a regular directory.');
    }
    const resolved = await realpath(directory);
    const rel = relative(root, resolved);
    if (rel.includes('..') || basename(rel) !== rel) {
      throw new PluginStoreError('PLUGIN_PATH_UNSAFE', 'Version directory must be a direct plugin child.');
    }
    return resolved;
  }

  private pluginRoot(pluginId: ProxyPluginId): string {
    return join(this.options.pluginsDir, pluginId);
  }
}

type CurrentPointer =
  | { kind: 'absent' }
  | { kind: 'valid'; version: string }
  | { kind: 'unmanaged' };

function flightKey(pluginId: string, version: string): string {
  return `${pluginId}@${version}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function pluginStoreGcDeferredReason(): string {
  return 'Broad PluginStore GC is deferred. Current, live/resumable Session bindings, and in-flight operations keep versions; reportReferences is the deletion gate.';
}
