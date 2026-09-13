import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';
import { isOpenRuntimeProfile, parseProxyPluginId } from '@gian/shared';

import { AgentManager } from '../src/agents/manager.js';
import { CatalogService } from '../src/catalog/service.js';
import { RuntimeControlPlane } from '../src/runtime/control-plane.js';
import { hostRuntimeFingerprint, MAX_RUNTIME_FINGERPRINT_ENTRIES, RuntimeFingerprintError } from '../src/runtime/fingerprint.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import { RuntimeResolver, RuntimeResolverError } from '../src/runtime/resolver.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

function catalogPolicy() {
  return {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian-Proxy-Catalog',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: { 'gian-official-catalog-2026': '00' },
  };
}

test('production Catalog list never spawns Proxy, bootstrap, or vendor processes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-nospawn-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'spawned');
  const entry = join(root, 'spawn.js');
  await writeExecutable(entry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'spawned\\n');
process.exit(2);
`);
  const cli = join(root, 'bin', 'claude');
  await writeExecutable(cli, `#!/bin/sh
printf 'invoked\\n' >> ${JSON.stringify(marker)}
echo claude 2.1.159
`);
  const pluginId = parseProxyPluginId('io.gian.fixture');
  const cache = new RuntimeReadinessCache();
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
      listInstalled: async () => [
        {
          pluginId,
          currentVersion: '1.0.0',
          currentPointer: 'valid' as const,
          versions: [{
            version: '1.0.0',
            state: 'valid' as const,
            receipt: { negotiatedProtocol: '2.2', sourceId: 'gian-official' },
          }],
        },
        {
          pluginId: parseProxyPluginId('claude'),
          currentVersion: '0.2.4',
          currentPointer: 'valid' as const,
          versions: [{
            version: '0.2.4',
            state: 'valid' as const,
            receipt: { negotiatedProtocol: '2.2', sourceId: 'gian-official' },
          }],
        },
      ],
      currentLaunch: async (id: string) => ({
        pluginId: parseProxyPluginId(id),
        pluginVersion: id === 'claude' ? '0.2.4' : '1.0.0',
        entryPath: entry,
        processScope: 'session' as const,
        schemaVersion: 4 as const,
        runtime: {
          kind: 'external' as const,
          id: id === 'claude' ? 'claude' : 'fixture',
          displayName: id === 'claude' ? 'Claude Code' : 'Fixture CLI',
          verifiedVersions: id === 'claude' ? ['2.1.159'] : ['1.2.3'],
        },
      }),
    } as never,
    policy: catalogPolicy(),
    hostVersions: ['2.2', '2.1', '2.0'],
    readinessCache: cache,
    officialPresence: async () => null,
  });
  const listed = await service.list();
  assert.equal(listed.items.every((item) => item.runtime.state === 'setup_required' || item.runtime.state === 'not_required'), true);
  assert.equal(listed.items.some((item) => item.availableActions.includes('create_agent')), false);
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });

  cache.publish({
    pluginId,
    pluginVersion: '1.0.0',
    selectedPath: cli,
    profileIdentity: 'profile-1',
    state: 'ready',
    displayName: 'Fixture CLI',
  });
  const withCache = new CatalogService({
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
        entryPath: entry,
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
    policy: catalogPolicy(),
    hostVersions: ['2.2', '2.1', '2.0'],
    readinessCache: cache,
  });
  const ready = await withCache.list();
  assert.equal(ready.items[0]?.runtime.state, 'ready');
  assert.equal(ready.items[0]?.availableActions.includes('create_agent'), true);
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('untrusted Manifest peek never becomes generic authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-untrusted-peek-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'invoked');
  const escaped = join(root, 'outside', 'proxy.mjs');
  await writeExecutable(escaped, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'entry\\n');
`);
  const packageDir = join(root, 'data', 'plugins', 'claude', '1.0.0');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: 'renamed',
    displayName: 'Escaped',
    pluginVersion: '1.0.0',
    entry: '../outside/proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'external', id: 'other', displayName: 'Other', verifiedVersions: ['1.0.0'] },
    branding: { logo: { light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: 'a'.repeat(64) } } },
  }));
  await symlink('1.0.0', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.5.5',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    runtimeResolver: {
      resolve: async () => {
        throw new Error('untrusted peek must not reach RuntimeResolver');
      },
    } as never,
  });
  const status = await manager.status('claude');
  assert.notEqual(status.cli.state, 'ready');
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('official and unknown pluginIds produce the same OpenRuntimeProfile keys', () => {
  const official = {
    id: 'profile-official',
    agentId: 'agent-1',
    pluginId: parseProxyPluginId('claude'),
    runtimeId: 'claude',
    path: '/usr/local/bin/claude',
    version: '2.1.159',
    configHome: '/Users/test/.claude',
    contentFingerprint: 'b'.repeat(64),
    verifiedVersions: ['2.1.159'],
    verification: 'verified' as const,
  };
  const unknown = {
    id: 'profile-unknown',
    agentId: 'agent-2',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    runtimeId: 'fixture',
    path: '/usr/local/bin/fixture',
    version: '1.2.3',
    configHome: null,
    contentFingerprint: 'c'.repeat(64),
    verifiedVersions: ['1.2.3'],
    verification: 'unverified' as const,
  };
  assert.equal(isOpenRuntimeProfile(official), true);
  assert.equal(isOpenRuntimeProfile(unknown), true);
  assert.deepEqual(Object.keys(official).sort(), Object.keys(unknown).sort());
  assert.equal(isOpenRuntimeProfile({ ...official, readinessIssue: { code: 'x' } }), false);
});

test('invalid trusted Runtime facts make zero process or claim calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-invalid-input-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'spawned');
  const entry = join(root, 'proxy.mjs');
  await writeExecutable(entry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'spawned\\n');
`);
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
  });
  await assert.rejects(
    () => resolver.resolve({
      pluginId: parseProxyPluginId('io.gian.fixture'),
      pluginVersion: '1.0.0',
      agentId: 'agent-1',
      entryPath: entry,
      processScope: 'session',
      runtime: { kind: 'external', id: 'fixture', displayName: 'Fixture CLI' },
      selectedPath: join(root, 'tool'),
    }),
    (error: unknown) => error instanceof RuntimeResolverError,
  );
  await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('fingerprint counts empty directories against the entry budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-fingerprint-dirs-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const selected = join(root, 'tool');
  await writeExecutable(selected, '#!/bin/sh\necho tool 1.0.0\n');
  const content = join(root, 'tree');
  await mkdir(content, { recursive: true });
  for (let index = 0; index < MAX_RUNTIME_FINGERPRINT_ENTRIES; index += 1) {
    await mkdir(join(content, `d${index}`));
  }
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: null,
      contentRoots: [{ path: content, mode: 'directory' }],
      homeDir: root,
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError && error.code === 'RUNTIME_FINGERPRINT_BUDGET',
  );
});

test('Runtime discover/probe routes validate pluginId, path, and action transitions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-api-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const cache = new RuntimeReadinessCache();
  const control = new RuntimeControlPlane({
    allowMissingCatalogPolicy: true,
    resolver: {
      discover: async () => ({
        candidates: [{ path: join(root, 'tool'), source: 'path' as const }],
        setupActions: [{ id: 'docs', kind: 'open_url' as const, label: 'Docs', url: 'https://example.com/setup' }],
      }),
      resolve: async (input) => ({
        profile: {
          id: 'profile-1',
          agentId: input.agentId,
          pluginId: input.pluginId,
          runtimeId: 'fixture',
          path: input.selectedPath,
          version: '1.2.3',
          configHome: null,
          contentFingerprint: 'd'.repeat(64),
          verifiedVersions: ['1.2.3'],
          verification: 'verified' as const,
        },
        lease: { release: async () => undefined },
      }),
    } as never,
    cache,
    resolveLaunch: async (pluginId) => {
      if (pluginId === 'missing.plugin') return null;
      return {
        pluginId,
        pluginVersion: '1.0.0',
        entryPath: join(root, 'proxy.mjs'),
        processScope: 'session' as const,
        schemaVersion: 4 as const,
        runtime: {
          kind: 'external' as const,
          id: 'fixture',
          displayName: 'Fixture CLI',
          verifiedVersions: ['1.2.3'],
        },
        source: 'plugin-store' as const,
      };
    },
  });
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.5.5',
    managedProxies: false,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents: manager,
    runtimeControl: control,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      models: [],
      thinkingLevels: [],
      permissionModes: [],
      configOptions: [],
    }) as never,
  });

  const malformed = await app.request('http://test.invalid/api/proxies/not%20a%20plugin/runtime/discover', {
    method: 'POST',
  });
  assert.equal(malformed.status, 400);

  const missing = await app.request('http://test.invalid/api/proxies/missing.plugin/runtime/discover', {
    method: 'POST',
  });
  assert.equal(missing.status, 404);

  const discovered = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/discover', {
    method: 'POST',
  });
  assert.equal(discovered.status, 200);
  const discoverBody = await discovered.json() as { availableActions: string[] };
  assert.equal(discoverBody.availableActions.includes('create_agent'), false);
  assert.equal(discoverBody.availableActions.includes('select_runtime'), true);

  const badPath = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'relative/tool' }),
  });
  assert.equal(badPath.status, 400);

  const tool = join(root, 'tool');
  await writeExecutable(tool, '#!/bin/sh\necho fixture 1.2.3\n');
  const probed = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: tool }),
  });
  assert.equal(probed.status, 200);
  const probeBody = await probed.json() as {
    profile: unknown;
    availableActions: string[];
  };
  assert.equal(isOpenRuntimeProfile(probeBody.profile), true);
  assert.equal(probeBody.availableActions.includes('create_agent'), true);

  const removed = await app.request('http://test.invalid/api/agents/claude/install-cli', { method: 'POST' });
  assert.equal(removed.status, 410);
});

test('production Host has no Runtime Provider factory modules', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../src/agents/manager.ts', import.meta.url), 'utf8');
  for (const file of [
    'command-provider.ts',
    'dsh-provider.ts',
    'kimi-provider.ts',
    'zcode-provider.ts',
    'manager.ts',
    'kimi-session-store.ts',
  ]) {
    await assert.rejects(
      readFile(new URL(`../src/runtime/${file}`, import.meta.url), 'utf8'),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      file,
    );
  }
  assert.equal(index.includes('RuntimeProvider'), false);
  assert.equal(manager.includes('RuntimeProvider'), false);
  assert.equal(manager.includes('peekRuntimeLaunchProtocol'), false);
  assert.equal(manager.includes('this.providers'), false);
});
