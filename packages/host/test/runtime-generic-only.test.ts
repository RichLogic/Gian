import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseProxyPluginId } from '@gian/shared';

import { AgentManager } from '../src/agents/manager.js';
import { CatalogService } from '../src/catalog/service.js';
import { resolveLegacyLaunch } from '../src/proxy/legacy-launch.js';
import { RuntimeResolver, RuntimeResolverError } from '../src/runtime/resolver.js';
import type { RuntimeLease } from '../src/runtime/types.js';

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

function failingV4Entry(): string {
  return `#!/usr/bin/env node
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocol: { name: 'gian.proxy', version: '2.2' },
        plugin: { id: 'claude', name: 'Claude Code', version: '1.0.0' },
        process: { scope: 'session' },
        capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
      },
    }) + '\\n');
    return;
  }
  if (req.method === 'runtime.probe') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        runtimeId: 'renamed',
        displayName: 'Claude Code',
        path: req.params.path,
        version: '2.1.159',
        configHome: null,
        contentRoots: [{ path: req.params.path, mode: 'file' }],
      },
    }) + '\\n');
    return;
  }
  if (req.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\\n');
    process.exit(0);
  }
});
`;
}

function fakeLease(): RuntimeLease {
  return {
    binaryPath: '/tmp/fake-legacy',
    version: '9.9.9',
    source: 'path',
    env: Object.freeze({}),
    release: async () => undefined,
  };
}

test('v4 legacy attach still uses RuntimeResolver and fails closed', { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-generic-only-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const entry = join(root, 'proxy.mjs');
  const cli = join(root, 'claude');
  await writeExecutable(entry, failingV4Entry());
  await writeExecutable(cli, '#!/bin/sh\necho claude 2.1.159\n');
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
  });
  const resolution = await resolveLegacyLaunch({
    executor: 'claude',
    launch: {
      pluginId: 'claude',
      pluginVersion: '1.0.0',
      manifestSha256: 'a'.repeat(64),
      protocolRange: '>=2.2 <3.0',
      entryPath: entry,
      processScope: 'session',
      schemaVersion: 4,
      runtime: {
        kind: 'external',
        id: 'claude',
        displayName: 'Claude Code',
        verifiedVersions: ['2.1.159'],
      },
      source: 'official-development',
    },
    runtimeResolver: resolver,
    cliPath: cli,
  });
  await assert.rejects(
    () => resolution.acquireLease(),
    (error: unknown) => error instanceof RuntimeResolverError && error.code === 'RUNTIME_ID_MISMATCH',
  );
});

test('explicit v3 official launch uses only the saved-path adapter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-v3-saved-path-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const saved = join(root, 'claude');
  await writeExecutable(saved, '#!/bin/sh\necho should-not-run\n');
  let resolverCalls = 0;
  const resolution = await resolveLegacyLaunch({
    executor: 'claude',
    launch: {
      pluginId: 'claude',
      pluginVersion: '1.0.0',
      manifestSha256: 'b'.repeat(64),
      protocolRange: '>=2.0 <2.2',
      entryPath: join(root, 'unused-v3-entry'),
      processScope: 'session',
      schemaVersion: 3,
      runtime: { kind: 'external' },
      source: 'official-development',
    },
    runtimeResolver: {
      resolve: async () => {
        resolverCalls += 1;
        throw new Error('v3 must not call RuntimeResolver');
      },
    } as never,
    cliPath: saved,
  });
  const acquired = await resolution.acquireLease();
  assert.equal(acquired?.binaryPath, saved);
  assert.equal(acquired?.version, '0.0.0');
  assert.equal(resolverCalls, 0);
});

test('catalog-only pluginId is a valid open identity', () => {
  assert.equal(parseProxyPluginId('io.gian.fixture'), 'io.gian.fixture');
});

test('Catalog create_agent follows real resolver readiness and never a v3 resolver fallback', async () => {
  const pluginId = parseProxyPluginId('io.gian.fixture');
  let resolverCalls = 0;
  const service = new CatalogService({
    store: {
      snapshot: () => ({
        state: 'ready' as const,
        sequence: 1,
        error: null,
        index: { plugins: [] },
      }),
    } as never,
    plugins: {
      listInstalled: async () => [{
        pluginId,
        currentVersion: '1.0.0',
        currentPointer: 'valid' as const,
        versions: [{
          version: '1.0.0',
          state: 'valid' as const,
          receipt: { negotiatedProtocol: '2.2', sourceId: 'gian-official' },
        }],
      }],
      currentLaunch: async () => ({
        pluginId,
        pluginVersion: '1.0.0',
        entryPath: '/tmp/fixture-entry',
        processScope: 'session' as const,
        schemaVersion: 4 as const,
        runtime: {
          kind: 'external' as const,
          id: 'fixture',
          displayName: 'Fixture CLI',
          verifiedVersions: ['1.2.3'],
        },
      }),
    } as never,
    policy: {
      sourceId: 'gian-official',
      repository: 'RichLogic/Gian-Proxy-Catalog',
      artifactRepositories: ['RichLogic/Gian'],
      pinnedPublicKeys: { 'gian-official-catalog-2026': '00' },
    },
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const listed = await service.list();
  assert.equal(listed.items[0]?.runtime.state, 'setup_required');
  assert.equal(listed.items[0]?.availableActions.includes('create_agent'), false);
  assert.equal(resolverCalls, 0);

  const legacy = new CatalogService({
    store: {
      snapshot: () => ({
        state: 'ready' as const,
        sequence: 1,
        error: null,
        index: { plugins: [] },
      }),
    } as never,
    plugins: {
      listInstalled: async () => [{
        pluginId,
        currentVersion: '1.0.0',
        currentPointer: 'valid' as const,
        versions: [{
          version: '1.0.0',
          state: 'valid' as const,
          receipt: { negotiatedProtocol: '2.1', sourceId: 'gian-official' },
        }],
      }],
      currentLaunch: async () => ({
        pluginId,
        pluginVersion: '1.0.0',
        entryPath: '/tmp/legacy-entry',
        processScope: 'session' as const,
        schemaVersion: 3,
        runtime: { kind: 'external' as const, id: 'fixture', displayName: 'Fixture CLI' },
      }),
    } as never,
    policy: {
      sourceId: 'gian-official',
      repository: 'RichLogic/Gian-Proxy-Catalog',
      artifactRepositories: ['RichLogic/Gian'],
      pinnedPublicKeys: { 'gian-official-catalog-2026': '00' },
    },
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const legacyListed = await legacy.list();
  assert.equal(legacyListed.items[0]?.runtime.state, 'setup_required');
  assert.equal(legacyListed.items[0]?.availableActions.includes('create_agent'), false);
});

async function writeMarkerCli(path: string, marker: string, versionLine: string): Promise<void> {
  await writeExecutable(path, `#!/bin/sh
printf 'invoked\\n' >> ${JSON.stringify(marker)}
echo ${JSON.stringify(versionLine)}
`);
}

test('v4 Agent status never calls the legacy Provider when resolver fails', { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-v4-fail-closed-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'provider-invoked');
  const claude = join(root, 'bin', 'claude');
  await writeMarkerCli(claude, marker, 'claude 2.1.220');
  const proxyDir = join(root, 'data', 'plugins', 'claude', '1.0.0');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), '#!/usr/bin/env node\nprocess.exit(2);\n');
  await mkdir(join(proxyDir, 'assets'), { recursive: true });
  await writeFile(join(proxyDir, 'assets', 'logo-light.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '1.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.220'] },
    branding: {
      logo: {
        light: {
          path: 'assets/logo-light.png',
          mediaType: 'image/png',
          sha256: 'a'.repeat(64),
        },
      },
    },
  }));
  await symlink('1.0.0', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.5.5',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
    runtimeResolver: new RuntimeResolver({
      dataDir: join(root, 'resolver'),
      updateLockDataDir: join(root, 'locks'),
      hostVersion: '0.5.5',
    }),
  });
  const status = await manager.status('claude');
  assert.equal(status.cli.state, 'ready');
  assert.equal(status.cli.version, null);
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('explicit v3 Agent status uses only the legacy adapter', { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-v3-legacy-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'provider-invoked');
  const claude = join(root, 'bin', 'claude');
  await writeMarkerCli(claude, marker, 'claude 2.1.220');
  const proxyDir = join(root, 'data', 'plugins', 'claude', '1.0.0');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), 'export {};\n');
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 3,
    id: 'claude',
    pluginVersion: '1.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code' },
  }));
  await symlink('1.0.0', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');
  let resolverCalls = 0;
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.5.5',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
    runtimeResolver: {
      resolve: async () => {
        resolverCalls += 1;
        throw new Error('v3 Agent status must not call RuntimeResolver');
      },
    } as never,
  });
  const status = await manager.status('claude');
  assert.equal(status.cli.state, 'ready');
  assert.equal(status.cli.version, null);
  assert.equal(resolverCalls, 0);
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
});
