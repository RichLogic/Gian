import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  parseProxyPluginId,
  type ManagedRuntimeInstallPlan,
  type ManagedRuntimeInstallProgress,
} from '@gian/shared';

import { ManagedRuntimeActivationService } from '../src/runtime/activation-service.js';
import { ManagedRuntimeDeliveryService } from '../src/runtime/delivery-service.js';
import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { ManagedRuntimeInstaller } from '../src/runtime/installer.js';
import { fixtureInstallPlan } from './runtime-install-fixtures.js';

test('fresh delivery installs certified bytes before Agent HOME setup and owns the CLI below dataDir/runtimes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-runtime-delivery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const proxyEntry = join(dataDir, 'plugins', 'claude', '0.2.4', 'proxy.mjs');
  const runtimeBytes = Buffer.from('#!/bin/sh\necho 2.1.159\n');
  const runtimeSha = createHash('sha256').update(runtimeBytes).digest('hex');
  const order: string[] = [];
  const store = new ManagedRuntimeGenerationStore(dataDir);
  await store.initialize();
  const plan: ManagedRuntimeInstallPlan = {
    generationId: 'claude-0.2.4-runtime-2.1.159',
    pluginId: parseProxyPluginId('claude'),
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.2.4',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: proxyEntry,
      processScope: 'session',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      kind: 'native-binary',
      runtimeId: 'claude',
      version: '2.1.159',
      asset: {
        url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-runtime-claude-2.1.159-darwin-arm64',
        sha256: runtimeSha,
        size: runtimeBytes.byteLength,
      },
      format: 'raw',
      entryRelativePath: 'bin/claude',
    },
    companions: [],
    certificate: { id: 'release-certificate-1', sha256: 'c'.repeat(64) },
  };
  let installed = false;
  let catalogSynced = false;
  const catalog = {
    get: async () => catalogSynced ? ({
      compatibility: { state: 'compatible' },
      installation: { state: installed ? 'installed' : 'not_installed' },
    }) : null,
    sync: async () => {
      order.push('catalog');
      catalogSynced = true;
    },
    install: async () => {
      order.push('proxy');
      await mkdir(dirname(proxyEntry), { recursive: true });
      await writeFile(proxyEntry, '#!/bin/sh\nexit 0\n');
      await chmod(proxyEntry, 0o700);
      installed = true;
    },
    managedRuntimeKind: () => 'native-binary',
    managedRuntimePlan: async () => plan,
  };
  const agents = {
    getAgent: () => ({ id: 'agent-1', pluginId: 'claude' }),
    managedRuntimeStatus: async () => ({
      pluginId: 'claude',
      active: store.activeCached('claude'),
      staged: (await store.list('claude')).filter(item => item.state === 'staged'),
    }),
    trustedLaunch: async () => ({
      pluginId: parseProxyPluginId('claude'),
      pluginVersion: '0.2.4',
      manifestSha256: 'a'.repeat(64),
      protocolRange: '>=2.2 <3.0',
      entryPath: proxyEntry,
      processScope: 'session',
      schemaVersion: 4,
      runtime: {
        kind: 'external',
        id: 'claude',
        displayName: 'Claude Code',
        verifiedVersions: ['2.1.159'],
      },
    }),
  };
  const installer = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir,
    store,
    download: async (_asset, _signal, onProgress) => {
      order.push('runtime');
      onProgress?.(runtimeBytes.length, runtimeBytes.length);
      return runtimeBytes;
    },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  const activation = new ManagedRuntimeActivationService({
    store,
    lockDataDir: dataDir,
    blockers: async () => [],
    closeProxy: async () => { order.push('close'); },
    drainRuntime: async () => { order.push('drain'); },
    advanceSessions: async () => undefined,
    acquireLock: async () => ({ release: async () => undefined }) as never,
  });
  const service = new ManagedRuntimeDeliveryService({
    agents: agents as never,
    catalog: catalog as never,
    installer,
    activation,
    runtimeControl: {} as never,
    resolver: {
      resolve: async () => ({
        profile: {
          id: 'runtime-profile',
          agentId: 'agent-1',
          pluginId: parseProxyPluginId('claude'),
          runtimeId: 'claude',
          path: join(dataDir, 'runtimes', 'claude', '2.1.159', runtimeSha, 'bin', 'claude'),
          version: '2.1.159',
          configHome: null,
          contentFingerprint: runtimeSha,
          verifiedVersions: ['2.1.159'],
          verification: 'verified',
        },
        lease: null,
        readinessIssue: { code: 'profile_missing', message: 'Configure the Agent HOME.', repairable: true },
      }),
    } as never,
  });

  const progress: ManagedRuntimeInstallProgress[] = [];
  const active = await service.install('claude', 'agent-1', event => progress.push(event));
  const runtimePath = join(dataDir, 'runtimes', 'claude', '2.1.159', runtimeSha, 'bin', 'claude');
  assert.equal(active.state, 'active');
  assert.equal(active.runtime?.entryPath, runtimePath);
  assert.deepEqual(await readFile(runtimePath), runtimeBytes);
  assert.deepEqual(order.slice(0, 3), ['catalog', 'proxy', 'runtime']);
  assert.equal(runtimePath.startsWith(join(dataDir, 'runtimes')), true);
  assert.deepEqual(progress.map(event => `${event.stage}:${event.status}`), [
    'catalog:started',
    'catalog:completed',
    'proxy:started',
    'proxy:completed',
    'runtime-plan:started',
    'runtime-plan:completed',
    'runtime-download:started',
    'runtime-download:progress',
    'runtime-download:completed',
    'runtime-verify:started',
    'runtime-verify:completed',
    'combination-verify:started',
    'combination-verify:completed',
    'activation:started',
    'activation:completed',
  ]);
});

test('delivery rejects a Runtime install for an Agent bound to another Proxy', async () => {
  const service = new ManagedRuntimeDeliveryService({
    agents: { getAgent: () => ({ pluginId: 'codex' }) } as never,
    catalog: {} as never,
    installer: {} as never,
    activation: {} as never,
    runtimeControl: {} as never,
    resolver: {} as never,
  });
  await assert.rejects(
    service.install('claude', 'agent-1'),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'RUNTIME_AGENT_MISMATCH',
  );
});

test('delivery freshly installs over an untrusted Proxy pointer before staging Runtime', async () => {
  const calls: string[] = [];
  let installation: 'quarantined' | 'installed' = 'quarantined';
  const generation = {
    schemaVersion: 1,
    generationId: 'claude-managed-generation',
    pluginId: parseProxyPluginId('claude'),
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.2.4', manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64),
      entryPath: '/managed/proxy.mjs', processScope: 'session', protocolRange: '^2.2',
    },
    runtime: null,
    companions: [],
    certificate: { id: 'certificate', sha256: 'c'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-13T00:00:00.000Z',
    activatedAt: null,
  } as const;
  const service = new ManagedRuntimeDeliveryService({
    agents: {
      managedRuntimeStatus: async () => ({ pluginId: 'claude', active: null, staged: [] }),
      trustedLaunch: async () => ({ pluginId: 'claude' }),
    } as never,
    catalog: {
      get: async () => ({
        compatibility: { state: 'compatible' },
        installation: { state: installation, updateAvailable: false },
      }),
      install: async () => { calls.push('proxy'); installation = 'installed'; },
      managedRuntimeKind: () => 'native-binary',
      managedRuntimePlan: async () => generation,
    } as never,
    installer: {
      install: async () => { calls.push('runtime'); return generation; },
    } as never,
    activation: {
      activate: async () => { calls.push('activate'); return { ...generation, state: 'active' }; },
    } as never,
    runtimeControl: {} as never,
    resolver: {} as never,
  });

  const active = await service.install('claude');
  assert.equal(active.state, 'active');
  assert.deepEqual(calls, ['proxy', 'runtime', 'activate']);
});

test('delivery updates an older certified Proxy and Runtime generation together', async () => {
  const calls: string[] = [];
  let updateAvailable = true;
  const generation = {
    schemaVersion: 1,
    generationId: 'claude-new-generation',
    pluginId: parseProxyPluginId('claude'),
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.2.5', manifestSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64),
      entryPath: '/managed/proxy.mjs', processScope: 'session', protocolRange: '^2.2',
    },
    runtime: null,
    companions: [],
    certificate: { id: 'certificate-2', sha256: 'f'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-13T00:00:00.000Z',
    activatedAt: null,
  } as const;
  const service = new ManagedRuntimeDeliveryService({
    agents: {
      managedRuntimeStatus: async () => ({
        pluginId: 'claude',
        active: { ...generation, generationId: 'claude-old-generation', state: 'active' },
        staged: [],
      }),
      trustedLaunch: async () => ({ pluginId: 'claude' }),
    } as never,
    catalog: {
      get: async () => ({
        compatibility: { state: 'compatible' },
        installation: { state: 'installed', updateAvailable },
      }),
      update: async () => { calls.push('proxy-update'); updateAvailable = false; },
      managedRuntimeKind: () => 'native-binary',
      managedRuntimePlan: async () => generation,
    } as never,
    installer: {
      install: async () => { calls.push('runtime-update'); return generation; },
    } as never,
    activation: {
      activate: async () => { calls.push('activate'); return { ...generation, state: 'active' }; },
    } as never,
    runtimeControl: {} as never,
    resolver: {} as never,
  });

  const active = await service.install('claude');
  assert.equal(active.generationId, 'claude-new-generation');
  assert.deepEqual(calls, ['proxy-update', 'runtime-update', 'activate']);
});

test('ZCode delivery discovers the local App Runtime and never downloads a CLI', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-zcode-delivery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const proxyEntry = join(dataDir, 'plugins', 'com.zhipu.zcode', '0.1.1', 'proxy.mjs');
  const zcodeEntry = join(dataDir, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await mkdir(dirname(proxyEntry), { recursive: true });
  await writeFile(proxyEntry, '#!/bin/sh\nexit 0\n');
  await chmod(proxyEntry, 0o700);
  await mkdir(dirname(zcodeEntry), { recursive: true });
  const zcodeBytes = Buffer.from('#!/bin/sh\necho 0.16.5\n');
  await writeFile(zcodeEntry, zcodeBytes);
  await chmod(zcodeEntry, 0o700);
  const digest = createHash('sha256').update(zcodeBytes).digest('hex');
  const store = new ManagedRuntimeGenerationStore(dataDir);
  await store.initialize();
  const plan: ManagedRuntimeInstallPlan = {
    generationId: 'zcode-0.1.1-runtime-0.16.5',
    pluginId: parseProxyPluginId('com.zhipu.zcode'),
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.1.1', manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64),
      entryPath: proxyEntry, processScope: 'shared', protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      kind: 'external-app', runtimeId: 'zcode', version: '0.16.5',
      entryPath: zcodeEntry, artifactSha256: digest,
    },
    companions: [],
    certificate: { id: 'zcode-release-1', sha256: 'c'.repeat(64) },
  };
  const installer = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir,
    store,
    download: async () => { throw new Error('ZCode Runtime must not be downloaded'); },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  const activation = new ManagedRuntimeActivationService({
    store,
    lockDataDir: dataDir,
    blockers: async () => [],
    closeProxy: async () => undefined,
    drainRuntime: async () => undefined,
    advanceSessions: async () => undefined,
    acquireLock: async () => ({ release: async () => undefined }) as never,
  });
  const launch = {
    pluginId: parseProxyPluginId('com.zhipu.zcode'), pluginVersion: '0.1.1',
    manifestSha256: 'a'.repeat(64), protocolRange: '>=2.2 <3.0', entryPath: proxyEntry,
    processScope: 'shared' as const, schemaVersion: 4 as const,
    runtime: { kind: 'external' as const, id: 'zcode', displayName: 'ZCode', verifiedVersions: ['0.16.5'] },
  };
  const service = new ManagedRuntimeDeliveryService({
    agents: {
      getAgent: () => ({ id: 'z-agent', pluginId: 'com.zhipu.zcode' }),
      managedRuntimeStatus: async () => ({ pluginId: 'com.zhipu.zcode', active: store.activeCached('com.zhipu.zcode'), staged: [] }),
      trustedLaunch: async () => launch,
    } as never,
    catalog: {
      get: async () => ({ compatibility: { state: 'compatible' }, installation: { state: 'installed' } }),
      managedRuntimeKind: () => 'external-app',
      managedRuntimePlan: async (_id: string, path?: string) => ({
        ...plan,
        runtime: { ...plan.runtime!, entryPath: path! },
      }),
    } as never,
    installer,
    activation,
    runtimeControl: {
      discover: async () => ({ runtime: { displayName: 'ZCode' }, candidates: [{ path: zcodeEntry }] }),
    } as never,
    resolver: {
      resolve: async () => ({
        profile: {
          id: 'zcode-profile', agentId: 'z-agent', pluginId: parseProxyPluginId('com.zhipu.zcode'),
          runtimeId: 'zcode', path: zcodeEntry, version: '0.16.5', configHome: null,
          contentFingerprint: digest, verifiedVersions: ['0.16.5'], verification: 'verified',
        },
        lease: { release: async () => undefined },
      }),
    } as never,
  });
  const active = await service.install('com.zhipu.zcode', 'z-agent');
  assert.equal(active.runtime?.ownership, 'external-app');
  assert.equal(active.runtime?.entryPath, zcodeEntry);
});
