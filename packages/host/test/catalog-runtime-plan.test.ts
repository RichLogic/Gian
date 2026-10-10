import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogIndexV1 } from '@gian/proxy-catalog-contract';
import { parseProxyPluginId, type OfficialCatalogSourcePolicy } from '@gian/shared';

import { CatalogService } from '../src/catalog/service.js';
import type { TrustedLaunch } from '../src/runtime/trusted-launch.js';

function fixture() {
  const runtimeAsset = {
    url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-runtime-claude-2.1.159-darwin-arm64',
    sha256: 'c'.repeat(64),
    size: 123,
  };
  const manifest = {
    url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz.manifest.json',
    sha256: 'a'.repeat(64),
    size: 456,
  };
  const archive = {
    url: 'https://github.com/RichLogic/Gian/releases/download/proxy-claude-v0.2.4/gian-proxy-claude-0.2.4-darwin-arm64.tar.gz',
    sha256: 'b'.repeat(64),
    size: 789,
  };
  const index = {
    schemaVersion: 1,
    sourceId: 'gian-official',
    sequence: 7,
    issuedAt: '2026-09-12T00:00:00.000Z',
    plugins: [{
      pluginId: 'claude',
      displayName: 'Claude Code',
      tagline: 'Claude',
      featuredOrder: 1,
      documentation: {},
      branding: {},
      stable: {
        pluginVersion: '0.2.4',
        protocolRange: '>=2.2 <3.0',
        processScope: 'session',
        runtime: {
          kind: 'external',
          id: 'claude',
          displayName: 'Claude Code',
          verifiedVersions: ['2.1.159'],
        },
        manifest,
        artifacts: { 'darwin-arm64': archive },
        combination: {
          generationId: 'claude-0.2.4-runtime-2.1.159',
          certificate: { id: 'release-certificate-7', sha256: 'd'.repeat(64) },
          runtime: {
            kind: 'native-binary',
            runtimeId: 'claude',
            version: '2.1.159',
            asset: runtimeAsset,
            format: 'raw',
            entryRelativePath: 'bin/claude',
          },
          companions: [],
        },
      },
    }],
  } as unknown as CatalogIndexV1;
  return { archive, index, manifest };
}

test('Dev Catalog ignores published versions, installed packages and refresh failures', async () => {
  const input = fixture();
  const launch: TrustedLaunch = {
    pluginId: 'grok', displayName: 'Grok Build', pluginVersion: '0.3.8-Dev',
    manifestSha256: 'a'.repeat(64), protocolRange: '>=2.2 <3.0',
    entryPath: '/dev/grok-proxy/dist/src/cli/spawn.js',
    processScope: 'session', schemaVersion: 4, runtime: { kind: 'none' },
    source: 'official-development',
  };
  const service = new CatalogService({
    store: { snapshot: () => ({ state: 'stale', sequence: 7,
      error: { code: 'CATALOG_SYNC_FAILED', message: 'timeout' }, index: input.index }) } as never,
    plugins: {
      listInstalled: async () => { throw new Error('Dev must not read installed package versions'); },
      install: async () => { throw new Error('Dev must not download a release package'); },
    } as never,
    policy: { sourceId: 'gian-official', repository: 'RichLogic/Gian-Proxies',
      artifactRepositories: [], pinnedPublicKeys: {} },
    sourceClient: { sync: async () => { throw new Error('Dev refresh must remain local'); } } as never,
    developmentProxies: async () => [launch],
  });
  for (const list of [await service.list(), await service.sync()]) {
    assert.deepEqual(list.source, { id: 'giandev', sequence: null, state: 'ready', error: null });
    assert.deepEqual(list.items.map(item => item.pluginId), ['grok']);
    assert.deepEqual(list.items[0]!.installation, {
      state: 'installed', installedVersion: '0.3.8-Dev', latestVersion: '0.3.8-Dev',
      updateAvailable: false, source: 'giandev',
    });
    assert.deepEqual(list.items[0]!.availableActions, ['create_agent']);
  }
  await assert.rejects(service.install('grok'), /source Proxies/);
  await assert.rejects(service.update('grok'), /source Proxies/);
  await assert.rejects(service.rollback('grok'), /source Proxies/);
});

test('Dev Catalog reports a verified provisioned CLI without requiring any saved Agent', async () => {
  const launch: TrustedLaunch = { pluginId: 'grok', displayName: 'Grok Build', pluginVersion: '0.3.8-Dev',
    manifestSha256: 'a'.repeat(64), protocolRange: '>=2.2 <3.0', entryPath: '/dev/proxy.mjs',
    processScope: 'session', schemaVersion: 4, source: 'official-development',
    runtime: { kind: 'external', id: 'grok', verifiedVersions: ['1.0.46'] } };
  const service = new CatalogService({
    store: { snapshot: () => ({ state: 'empty', index: null }) } as never,
    plugins: {} as never,
    policy: { sourceId: 'gian-official', repository: 'RichLogic/Gian-Proxies',
      artifactRepositories: [], pinnedPublicKeys: {} },
    developmentProxies: async () => [launch],
    developmentRuntime: async () => ({ state: 'ready', displayName: 'Grok CLI',
      path: '/test/runtimes/grok/1.0.46/bin/grok', version: '1.0.46' }),
  });
  const item = (await service.list()).items[0]!;
  assert.equal(item.installation.source, 'giandev');
  assert.equal(item.runtime.state, 'ready');
  assert.equal(item.runtime.version, '1.0.46');
  assert.deepEqual(item.availableActions, ['create_agent']);
});

test('trusted Catalog builds the exact managed Runtime install plan from the installed Proxy receipt', async () => {
  const input = fixture();
  const receipt = {
    schemaVersion: 1 as const,
    sourceId: 'gian-official' as const,
    catalogSequence: 7,
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '0.2.4',
    platform: 'darwin-arm64',
    manifestSha256: input.manifest.sha256,
    archiveSha256: input.archive.sha256,
    negotiatedProtocol: '2.2',
    processScope: 'session' as const,
    installedAt: '2026-09-12T00:00:00.000Z',
    files: [{ path: 'proxy.mjs', sha256: 'e'.repeat(64), size: 1 }],
  };
  const plugins = {
    listInstalled: async () => [{
      pluginId: 'claude',
      currentVersion: '0.2.4',
      currentPointer: 'valid',
      versions: [{ version: '0.2.4', state: 'valid', receipt }],
    }],
    currentLaunch: async () => ({
      pluginId: parseProxyPluginId('claude'),
      displayName: 'Claude Code',
      pluginVersion: '0.2.4',
      manifestSha256: input.manifest.sha256,
      entryPath: '/tmp/gian/plugins/claude/0.2.4/proxy.mjs',
      processScope: 'session',
      schemaVersion: 4,
      runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
      protocolRange: '>=2.2 <3.0',
    }),
  };
  const policy: OfficialCatalogSourcePolicy = {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian-Proxy-Catalog',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: {},
  };
  const service = new CatalogService({
    store: { snapshot: () => ({ state: 'ready', sequence: 7, error: null, index: input.index, files: new Map() }) } as never,
    plugins: plugins as never,
    policy,
    platform: 'darwin-arm64',
  });
  const plan = await service.managedRuntimePlan('claude');
  assert.equal(plan.generationId, 'claude-0.2.4-runtime-2.1.159');
  assert.equal(plan.proxy.artifactSha256, input.archive.sha256);
  assert.equal(plan.runtime?.kind, 'native-binary');
  assert.equal(plan.runtime?.version, '2.1.159');
});
