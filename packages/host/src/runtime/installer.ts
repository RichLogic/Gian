import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  isCanonicalAbsolutePath,
  parseProxyPluginId,
  type ManagedRuntimeDistribution,
  type ManagedRuntimeGeneration,
  type ManagedRuntimeInstallPlan,
} from '@gian/shared';

import { fsyncDirectory } from '../catalog/atomic.js';
import { ManagedRuntimeGenerationStore } from './generation-store.js';

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ManagedRuntimeInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedRuntimeInstallError';
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
    download: (
      asset: Extract<ManagedRuntimeDistribution, { kind: 'native-binary' }>['asset'],
      signal?: AbortSignal,
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
      if (
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
      ) return existing;
      throw new ManagedRuntimeInstallError(
        'RUNTIME_GENERATION_CONFLICT',
        'Runtime generation id already belongs to a different certified plan.',
      );
    }

    const runtime = plan.runtime
      ? await this.installDistribution(pluginId, plan.runtime, signal)
      : null;
    const companions = [];
    for (const companion of plan.companions) {
      const installed = await this.installDistribution(pluginId, companion.distribution, signal);
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
    return this.options.store.stage(generation);
  }

  private async installDistribution(
    pluginId: string,
    distribution: ManagedRuntimeDistribution,
    signal?: AbortSignal,
  ): Promise<NonNullable<ManagedRuntimeGeneration['runtime']>> {
    if (distribution.kind === 'external-app') {
      if (pluginId !== 'zcode' && pluginId !== 'com.zhipu.zcode') {
        throw new ManagedRuntimeInstallError(
          'RUNTIME_EXTERNAL_FORBIDDEN',
          'Only the ZCode external-App adapter may stage an external Runtime.',
        );
      }
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
      return {
        runtimeId: distribution.runtimeId,
        version: distribution.version,
        artifactSha256: digest,
        entryPath: distribution.entryPath,
        ownership: 'external-app',
      };
    }

    signal?.throwIfAborted();
    const bytes = await this.options.download(distribution.asset, signal);
    signal?.throwIfAborted();
    if (bytes.length !== distribution.asset.size || bytes.length > MAX_ARTIFACT_BYTES) {
      throw new ManagedRuntimeInstallError('RUNTIME_SIZE_MISMATCH', 'Runtime artifact size does not match its coordinate.');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== distribution.asset.sha256) {
      throw new ManagedRuntimeInstallError('RUNTIME_DIGEST_MISMATCH', 'Runtime artifact digest does not match its coordinate.');
    }

    const versionRoot = join(this.runtimeRoot, distribution.runtimeId, distribution.version);
    const entryPath = join(versionRoot, distribution.entryRelativePath);
    const staging = join(this.runtimeRoot, distribution.runtimeId, `.staging-${randomUUID()}`);
    const stagedEntry = join(staging, distribution.entryRelativePath);
    await mkdir(dirname(stagedEntry), { recursive: true, mode: 0o700 });
    try {
      await writeFile(stagedEntry, bytes, { flag: 'wx', mode: 0o700 });
      await chmod(stagedEntry, 0o700);
      const observed = await this.options.probeVersion({
        executable: stagedEntry,
        expectedVersion: distribution.version,
        pluginId,
        runtimeId: distribution.runtimeId,
      });
      if (observed !== distribution.version) {
        throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', 'Runtime artifact reported a different version.');
      }
      try {
        await rename(staging, versionRoot);
        await fsyncDirectory(dirname(versionRoot));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw error;
        }
        const existing = await realpath(entryPath);
        const metadata = await lstat(entryPath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || await sha256(existing) !== digest) {
          throw new ManagedRuntimeInstallError(
            'RUNTIME_VERSION_CONFLICT',
            'An immutable Runtime version already exists with different content.',
          );
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
