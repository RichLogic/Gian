import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeInstallPlanResultSchema, type RuntimeInstallPlanParams, type RuntimeInstallPlanResult } from '@gian/proxy-protocol';
import {
  isCanonicalAbsolutePath,
  parseProxyPluginId,
  type ManagedRuntimeInstallProgress,
  type ManagedRuntimeDistribution,
  type ManagedRuntimeGeneration,
  type ManagedRuntimeInstallPlan,
} from '@gian/shared';

import { fsyncDirectory } from '../catalog/atomic.js';
import { ManagedRuntimeInstallError } from './errors.js';
import { ManagedRuntimeGenerationStore } from './generation-store.js';
import { extractManagedRuntimeArchive } from './safe-extract.js';
import { runRuntimeBootstrap } from './bootstrap.js';
import { acquireAgentUpdateLock } from '../agents/update-lock.js';
import { ownedRuntimeDirectory, recordRuntimeArtifact, runtimeFileInventory, sameRuntimeTree, verifiedRuntimeReuse } from './artifact-reuse.js';

export { ManagedRuntimeInstallError } from './errors.js';

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ProgressReporter = (progress: ManagedRuntimeInstallProgress) => void;

function reportProgress(
  reporter: ProgressReporter | undefined,
  progress: ManagedRuntimeInstallProgress,
): void {
  try {
    reporter?.(progress);
  } catch {
    // Progress is observational. Losing its consumer must not corrupt or
    // cancel a Host-owned install that may already have changed disk state.
  }
}

function canonicalRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateDistribution(value: ManagedRuntimeDistribution): void {
  if (!COMPONENT_ID.test(value.runtimeId) || !SEMVER.test(value.version)) {
    throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Runtime id or version is invalid.');
  }
  if (value.kind === 'native-binary') {
    if (
      !httpsUrl(value.asset.url)
      || !SHA256.test(value.asset.sha256)
      || !Number.isSafeInteger(value.asset.size)
      || value.asset.size <= 0
      || value.asset.size > MAX_ARTIFACT_BYTES
      || (value.format !== 'raw' && value.format !== 'tar.gz')
      || !canonicalRelativePath(value.entryRelativePath)
    ) {
      throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Native Runtime coordinate is invalid.');
    }
    return;
  }
  if (!isCanonicalAbsolutePath(value.entryPath) || !SHA256.test(value.artifactSha256)) {
    throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'External-App Runtime coordinate is invalid.');
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export class ManagedRuntimeInstaller {
  private readonly runtimeRoot: string;

  constructor(private readonly options: {
    dataDir: string;
    store: ManagedRuntimeGenerationStore;
    hostVersion?: string;
    planInstallation?: (plan: ManagedRuntimeInstallPlan, input: RuntimeInstallPlanParams) => Promise<RuntimeInstallPlanResult>;
    download: (
      asset: Extract<ManagedRuntimeDistribution, { kind: 'native-binary' }>['asset'],
      signal?: AbortSignal,
      onProgress?: (receivedBytes: number, totalBytes: number) => void,
    ) => Promise<Buffer>;
    probeVersion: (input: {
      executable: string;
      expectedVersion: string;
      pluginId: string;
      runtimeId: string;
    }) => Promise<string>;
  }) {
    this.runtimeRoot = join(options.dataDir, 'runtimes');
  }

  async install(
    plan: ManagedRuntimeInstallPlan,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
  ): Promise<ManagedRuntimeGeneration> {
    const lease = await acquireAgentUpdateLock(
      this.options.dataDir, `runtime-install-${parseProxyPluginId(plan.pluginId)}`, 'Runtime installation',
    );
    try {
      return await this.installWithClaim(plan, signal, onProgress);
    } finally {
      await lease.release();
    }
  }

  private async installWithClaim(
    plan: ManagedRuntimeInstallPlan,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
  ): Promise<ManagedRuntimeGeneration> {
    const pluginId = parseProxyPluginId(plan.pluginId);
    if (!COMPONENT_ID.test(plan.generationId)) {
      throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Runtime generation id is invalid.');
    }
    await this.assertProxy(plan.proxy.entryPath);
    if (plan.runtime) validateDistribution(plan.runtime);
    for (const companion of plan.companions) {
      if (!COMPONENT_ID.test(companion.id)) {
        throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Runtime companion id is invalid.');
      }
      validateDistribution(companion.distribution);
    }
    const existing = await this.options.store.get(pluginId, plan.generationId);
    if (existing) {
      const runtimeMatches = plan.runtime === null
        ? existing.runtime === null
        : existing.runtime?.runtimeId === plan.runtime.runtimeId
          && existing.runtime.version === plan.runtime.version
          && existing.runtime.artifactSha256 === (
            plan.runtime.kind === 'native-binary'
              ? plan.runtime.asset.sha256
              : plan.runtime.artifactSha256
          );
      const companionsMatch = existing.companions.length === plan.companions.length
        && plan.companions.every((companion, index) => (
          existing.companions[index]?.id === companion.id
          && existing.companions[index]?.version === companion.distribution.version
          && existing.companions[index]?.artifactSha256 === companion.distribution.asset.sha256
        ));
      if (!(
        existing.proxy.pluginVersion === plan.proxy.pluginVersion
        && existing.proxy.manifestSha256 === plan.proxy.manifestSha256
        && existing.proxy.artifactSha256 === plan.proxy.artifactSha256
        && existing.proxy.entryPath === plan.proxy.entryPath
        && existing.proxy.processScope === plan.proxy.processScope
        && existing.proxy.protocolRange === plan.proxy.protocolRange
        && existing.certificate.id === plan.certificate.id
        && existing.certificate.sha256 === plan.certificate.sha256
        && runtimeMatches
        && companionsMatch
      )) throw new ManagedRuntimeInstallError(
        'RUNTIME_GENERATION_CONFLICT',
        'Runtime generation id already belongs to a different certified plan.',
      );
    }

    const runtime = plan.runtime
      ? await this.installDistribution(plan, plan.runtime, signal, onProgress)
      : null;
    const companions = [];
    for (const companion of plan.companions) {
      const installed = await this.installDistribution(
        plan,
        companion.distribution,
        signal,
        onProgress,
      );
      if (installed.ownership !== 'managed') {
        throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Runtime companions must be Gian-managed.');
      }
      companions.push({
        id: companion.id,
        version: installed.version,
        artifactSha256: installed.artifactSha256,
        entryPath: installed.entryPath,
      });
    }
    const generation: ManagedRuntimeGeneration = {
      schemaVersion: 1,
      generationId: plan.generationId,
      pluginId,
      platform: plan.platform,
      proxy: { ...plan.proxy },
      runtime,
      companions,
      certificate: { ...plan.certificate },
      state: 'staged',
      installedAt: new Date().toISOString(),
      activatedAt: null,
    };
    if (existing) {
      if (!isDeepStrictEqual(existing.runtime, runtime) || !isDeepStrictEqual(existing.companions, companions)) {
        throw new ManagedRuntimeInstallError('RUNTIME_GENERATION_CONFLICT', 'Existing generation paths differ from the verified installation.');
      }
      return existing;
    }
    return this.options.store.stage(generation);
  }

  private async installDistribution(
    plan: ManagedRuntimeInstallPlan,
    distribution: ManagedRuntimeDistribution,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
  ): Promise<NonNullable<ManagedRuntimeGeneration['runtime']>> {
    const pluginId = plan.pluginId;
    reportProgress(onProgress, { stage: 'runtime-plan', status: 'started', componentId: distribution.runtimeId, version: distribution.version });
    const input: RuntimeInstallPlanParams = {
      installerVersion: 1,
      runtimeId: distribution.runtimeId,
      version: distribution.version,
      artifactSha256: distribution.kind === 'native-binary' ? distribution.asset.sha256 : distribution.artifactSha256,
      platform: plan.platform,
      distribution: distribution.kind === 'native-binary'
        ? { kind: 'managed', format: distribution.format, entryRelativePath: distribution.entryRelativePath }
        : { kind: 'external-app', entryPath: distribution.entryPath },
    };
    const proposed = this.options.planInstallation
      ? await this.options.planInstallation(plan, input)
      : await runRuntimeBootstrap({
          entryPath: plan.proxy.entryPath, pluginId, pluginVersion: plan.proxy.pluginVersion,
          processScope: plan.proxy.processScope, dataDir: join(this.options.dataDir, 'runtime-install-probes'),
          hostVersion: this.options.hostVersion ?? '0.0.0',
        }, async client => {
          const initialized = await client.initialize();
          if (initialized.capabilities['runtime.install.plan'] !== 1) {
            throw new ManagedRuntimeInstallError(
              'RUNTIME_INSTALLER_UNSUPPORTED', 'This Proxy does not support Runtime installer v1. Update the Proxy before installing its Runtime.',
            );
          }
          return client.request<RuntimeInstallPlanResult>('runtime.install.plan', input);
        });
    const recipe = runtimeInstallPlanResultSchema.parse(proposed);
    if (recipe.runtimeId !== input.runtimeId || recipe.version !== input.version
      || recipe.artifactSha256 !== input.artifactSha256) {
      throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Proxy changed the certified Runtime identity.');
    }
    reportProgress(onProgress, { stage: 'runtime-plan', status: 'completed', componentId: distribution.runtimeId, version: distribution.version });
    if (distribution.kind === 'external-app') {
      if (recipe.operation.kind !== 'external-app' || recipe.operation.entryPath !== distribution.entryPath) {
        throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Proxy changed the external Runtime entry.');
      }
      reportProgress(onProgress, {
        stage: 'runtime-verify',
        status: 'started',
        componentId: distribution.runtimeId,
        version: distribution.version,
      });
      const metadata = await lstat(distribution.entryPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new ManagedRuntimeInstallError('RUNTIME_EXTERNAL_INVALID', 'External Runtime is not a regular file.');
      }
      const digest = await sha256(distribution.entryPath);
      if (digest !== distribution.artifactSha256) {
        throw new ManagedRuntimeInstallError('RUNTIME_DIGEST_MISMATCH', 'External Runtime digest does not match its certificate.');
      }
      const observed = await this.options.probeVersion({
        executable: distribution.entryPath,
        expectedVersion: distribution.version,
        pluginId,
        runtimeId: distribution.runtimeId,
      });
      if (observed !== distribution.version) {
        throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', 'External Runtime reported a different version.');
      }
      if (await sha256(distribution.entryPath) !== digest) {
        throw new ManagedRuntimeInstallError('RUNTIME_MUTATED', 'External Runtime changed during its version probe.');
      }
      reportProgress(onProgress, {
        stage: 'runtime-verify',
        status: 'completed',
        componentId: distribution.runtimeId,
        version: distribution.version,
      });
      return {
        runtimeId: distribution.runtimeId,
        version: distribution.version,
        artifactSha256: digest,
        entryPath: distribution.entryPath,
        ownership: 'external-app',
      };
    }

    const operation = recipe.operation;
    if (operation.kind !== 'managed' || operation.format !== distribution.format
      || operation.entryRelativePath !== distribution.entryRelativePath) {
      throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Proxy changed the certified artifact layout.');
    }
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const versionRoot = join(this.runtimeRoot, operation.directory);
    const candidates = [...new Set([versionRoot, ...operation.candidates.map(path => join(this.runtimeRoot, path))])];
    const reference = (directory: string) => ({
      runtimeId: distribution.runtimeId, version: distribution.version,
      artifactSha256: distribution.asset.sha256,
      entryPath: join(directory, distribution.entryRelativePath), ownership: 'managed' as const,
    });
    for (const directory of candidates) {
      if (await verifiedRuntimeReuse(this.runtimeRoot, directory, distribution.asset.sha256, distribution.entryRelativePath)) {
        const ref = reference(directory);
        const observed = await this.options.probeVersion({
          executable: ref.entryPath, expectedVersion: distribution.version, pluginId, runtimeId: distribution.runtimeId,
        });
        if (observed !== distribution.version) throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', 'Installed Runtime reported a different version.');
        if (!await verifiedRuntimeReuse(this.runtimeRoot, directory, distribution.asset.sha256, distribution.entryRelativePath)) {
          throw new ManagedRuntimeInstallError('RUNTIME_MUTATED', 'Installed Runtime changed during its version probe.');
        }
        reportProgress(onProgress, {
          stage: 'runtime-verify', status: 'completed', componentId: distribution.runtimeId, version: distribution.version,
        });
        return ref;
      }
    }
    signal?.throwIfAborted();
    reportProgress(onProgress, {
      stage: 'runtime-download',
      status: 'started',
      componentId: distribution.runtimeId,
      version: distribution.version,
      receivedBytes: 0,
      totalBytes: distribution.asset.size,
    });
    const bytes = await this.options.download(distribution.asset, signal, (receivedBytes, totalBytes) => {
      reportProgress(onProgress, {
        stage: 'runtime-download',
        status: 'progress',
        componentId: distribution.runtimeId,
        version: distribution.version,
        receivedBytes,
        totalBytes,
      });
    });
    signal?.throwIfAborted();
    if (bytes.length !== distribution.asset.size || bytes.length > MAX_ARTIFACT_BYTES) {
      throw new ManagedRuntimeInstallError('RUNTIME_SIZE_MISMATCH', 'Runtime artifact size does not match its coordinate.');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== distribution.asset.sha256) {
      throw new ManagedRuntimeInstallError('RUNTIME_DIGEST_MISMATCH', 'Runtime artifact digest does not match its coordinate.');
    }
    reportProgress(onProgress, {
      stage: 'runtime-download',
      status: 'completed',
      componentId: distribution.runtimeId,
      version: distribution.version,
      receivedBytes: bytes.length,
      totalBytes: distribution.asset.size,
    });
    reportProgress(onProgress, {
      stage: 'runtime-verify',
      status: 'started',
      componentId: distribution.runtimeId,
      version: distribution.version,
    });

    const entryPath = join(versionRoot, distribution.entryRelativePath);
    // Staging is not placed under a provider-named path that might be a
    // retained legacy launcher. Never remove or rename such launchers.
    const staging = join(this.runtimeRoot, `.staging-${randomUUID()}`);
    const stagedEntry = join(staging, distribution.entryRelativePath);
    try {
      if (distribution.format === 'raw') {
        await mkdir(dirname(stagedEntry), { recursive: true, mode: 0o700 });
        await writeFile(stagedEntry, bytes, { flag: 'wx', mode: 0o700 });
      } else {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        await extractManagedRuntimeArchive(bytes, staging);
      }
      const stagedMetadata = await lstat(stagedEntry);
      if (stagedMetadata.isSymbolicLink() || !stagedMetadata.isFile()) {
        throw new ManagedRuntimeInstallError(
          'RUNTIME_ARCHIVE_ENTRY',
          'Runtime entry is not a regular file in the downloaded artifact.',
        );
      }
      await chmod(stagedEntry, 0o700);
      const inventory = await runtimeFileInventory(staging);
      const observed = await this.options.probeVersion({
        executable: stagedEntry,
        expectedVersion: distribution.version,
        pluginId,
        runtimeId: distribution.runtimeId,
      });
      if (observed !== distribution.version) {
        throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', 'Runtime artifact reported a different version.');
      }
      if (!await sameRuntimeTree(staging, inventory)) {
        throw new ManagedRuntimeInstallError('RUNTIME_MUTATED', 'Runtime changed during its version probe.');
      }
      for (const directory of candidates) {
        if (await ownedRuntimeDirectory(this.runtimeRoot, directory) && await sameRuntimeTree(directory, inventory)) {
          const ref = reference(directory);
          const reusedVersion = await this.options.probeVersion({
            executable: ref.entryPath, expectedVersion: distribution.version, pluginId, runtimeId: distribution.runtimeId,
          });
          if (reusedVersion !== distribution.version) {
            throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', 'Legacy Runtime reported a different version.');
          }
          if (!await sameRuntimeTree(directory, inventory)) {
            throw new ManagedRuntimeInstallError('RUNTIME_MUTATED', 'Legacy Runtime changed during its version probe.');
          }
          await recordRuntimeArtifact(this.runtimeRoot, directory, digest, distribution.entryRelativePath, inventory);
          reportProgress(onProgress, { stage: 'runtime-verify', status: 'completed', componentId: distribution.runtimeId, version: distribution.version });
          return ref;
        }
      }
      const parent = dirname(versionRoot);
      // Validate every existing ancestor before recursive mkdir can follow a
      // symlink. New directories are created one component at a time.
      let current = this.runtimeRoot;
      for (const part of relative(this.runtimeRoot, parent).split(sep).filter(Boolean)) {
        current = join(current, part);
        try { await mkdir(current, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (!await ownedRuntimeDirectory(this.runtimeRoot, current)) {
          throw new ManagedRuntimeInstallError('RUNTIME_PATH_OUTSIDE_STORE', 'Runtime installation parent is not an owned directory.');
        }
      }
      try {
        await rename(staging, versionRoot);
        await fsyncDirectory(dirname(versionRoot));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw error;
        }
        throw new ManagedRuntimeInstallError(
          'RUNTIME_VERSION_CONFLICT',
          'An unmanaged or concurrent Runtime version directory already exists.',
        );
      }
      await recordRuntimeArtifact(this.runtimeRoot, versionRoot, digest, distribution.entryRelativePath, inventory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    reportProgress(onProgress, {
      stage: 'runtime-verify',
      status: 'completed',
      componentId: distribution.runtimeId,
      version: distribution.version,
    });
    return {
      runtimeId: distribution.runtimeId,
      version: distribution.version,
      artifactSha256: digest,
      entryPath,
      ownership: 'managed',
    };
  }

  private async assertProxy(path: string): Promise<void> {
    if (!isCanonicalAbsolutePath(path)) {
      throw new ManagedRuntimeInstallError('RUNTIME_PLAN_INVALID', 'Proxy entry path is invalid.');
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ManagedRuntimeInstallError('RUNTIME_PROXY_INVALID', 'Proxy entry is not a regular file.');
    }
    const root = await realpath(join(this.options.dataDir, 'plugins'));
    const canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new ManagedRuntimeInstallError('RUNTIME_PROXY_INVALID', 'Proxy entry escaped the Gian plugin root.');
    }
  }
}
