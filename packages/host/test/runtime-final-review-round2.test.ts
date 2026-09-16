import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';
import { PROTOCOL_V22, PROTOCOL_V23, SUPPORTED_PROTOCOL_VERSIONS } from '@gian/proxy-protocol';
import { isOpenRuntimeProfile, parseProxyPluginId, productExecutorForPluginId } from '@gian/shared';

import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import { offeredProtocolVersionsForInstall } from '../src/plugin-store/initialize.js';
import { RuntimeControlPlane } from '../src/runtime/control-plane.js';
import { hostRuntimeFingerprint, RuntimeFingerprintError } from '../src/runtime/fingerprint.js';
import { RuntimeGuardian, runtimeOwnerExecutorId } from '../src/runtime/guardian.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';
import { validateStaticProxyPackage } from '../src/runtime/trusted-launch.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';
import { developmentEntries, fakeOfficialProxy, testResolver } from './runtime-test-harness.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function persistedAgents(dataDir: string): Promise<unknown[]> {
  const raw = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8')) as {
    agents?: unknown[];
  };
  return raw.agents ?? [];
}

async function countingProxy(
  root: string,
  pluginId: string,
  displayName: string,
  pluginVersion: string,
  runtimeId: string,
  verifiedVersions: string[],
  marker: string,
): Promise<string> {
  const packageDir = join(root, `count-${pluginVersion}`);
  const proxy = join(packageDir, 'dist', 'src', 'cli', 'spawn.js');
  await mkdir(dirname(proxy), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@gian/count-proxy',
    version: pluginVersion,
  }));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: pluginId,
    displayName,
    pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'external', id: runtimeId, displayName, verifiedVersions },
    branding: {
      logo: {
        light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: 'a'.repeat(64) },
      },
    },
  }));
  await writeFile(proxy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, result,
  }) + '\\n');
  const fail = (message) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, error: { code: -32000, message },
  }) + '\\n');
  if (req.method === 'initialize') {
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: ${JSON.stringify(pluginId)}, name: ${JSON.stringify(displayName)}, version: ${JSON.stringify(pluginVersion)} },
      process: { scope: 'session' },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'runtime.discover') {
    reply({ candidates: [], setupActions: [] });
    return;
  }
  if (req.method === 'runtime.probe') {
    appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(pluginVersion)} + '\\n');
    let out = '';
    try {
      out = await new Promise((resolve, reject) => {
        execFile(req.params.path, ['--version'], (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve(String(stdout) + String(stderr));
        });
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    const version = String(out).match(/\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
    if (!version) {
      fail('did not report a semantic version');
      return;
    }
    reply({
      runtimeId: ${JSON.stringify(runtimeId)},
      displayName: ${JSON.stringify(displayName)},
      path: req.params.path,
      version,
      configHome: null,
      contentRoots: [{ path: req.params.path, mode: 'file' }],
    });
    return;
  }
  if (req.method === 'shutdown') {
    reply({ ok: true });
    process.exit(0);
  }
});
`);
  await chmod(proxy, 0o755);
  return proxy;
}

function allowCreateCatalog() {
  return {
    get: async () => ({ availableActions: ['create_agent'] }),
  } as never;
}

test('v4 install prefers integrated 2.3/2.2 while the legacy activation fallback stays exact 2.2', () => {
  assert.equal((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(PROTOCOL_V23), true);
  assert.equal((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(PROTOCOL_V22), true);
  assert.deepEqual(offeredProtocolVersionsForInstall('>=2.2 <3.0'), [PROTOCOL_V23, PROTOCOL_V22]);
  assert.deepEqual(offeredProtocolVersionsForInstall('>=2.2 <3.0', ['2.1', '2.0']), [PROTOCOL_V22]);
  assert.deepEqual(offeredProtocolVersionsForInstall('>=2.0 <3.0', ['2.1', '2.0']), ['2.1', '2.0']);
});

test('saved-Agent status revalidates through Resolver and cannot stay ready after mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-status-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'probes');
  const bin = join(root, 'bin', 'claude');
  await writeExecutable(bin, '#!/bin/sh\necho claude 2.1.159\n');
  const entry = await countingProxy(
    root,
    'claude',
    'Claude Code',
    '0.2.4',
    'claude',
    ['2.1.159'],
    marker,
  );
  const options = {
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false as const,
    developmentProxyEntries: { ...(await developmentEntries(root)), claude: entry },
    runtimeResolver: testResolver(root),
    homeDir: join(root, 'home'),
    pathEnv: '',
    catalogService: allowCreateCatalog(),
  };
  const first = await AgentManager.create(options);
  const agent = await first.createAgent({ name: 'Claude Code', proxy: 'claude', cliPath: bin });
  const created = await first.agentStatus(agent.id);
  assert.equal(created.ready, true);
  assert.equal(created.cli.version, '2.1.159');
  assert.ok(created.runtimeProfile);
  assert.equal(created.runtimeProfile.version, '2.1.159');
  assert.equal(isOpenRuntimeProfile(created.runtimeProfile), true);
  const probesAfterCreate = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.ok(probesAfterCreate.length >= 1);

  const cold = await AgentManager.create({
    ...options,
    runtimeResolver: testResolver(join(root, 'cold')),
    readinessCache: new RuntimeReadinessCache(),
  });
  const revalidated = await cold.agentStatus(agent.id);
  assert.equal(revalidated.ready, true);
  assert.equal(revalidated.cli.version, '2.1.159');
  assert.ok(revalidated.runtimeProfile);
  assert.notEqual(revalidated.cli.version, null);
  assert.notEqual(revalidated.runtimeProfile, null);
  const probesAfterCold = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.ok(probesAfterCold.length > probesAfterCreate.length);

  await writeExecutable(bin, '#!/bin/sh\necho claude 2.1.159-mutated\n');
  const liveCache = new RuntimeReadinessCache();
  liveCache.publish({
    pluginId: 'claude',
    pluginVersion: '0.2.4',
    selectedPath: bin,
    profileIdentity: revalidated.runtimeProfile.id,
    state: 'ready',
    displayName: 'Claude Code',
    profile: revalidated.runtimeProfile,
    observation: {
      pluginId: parseProxyPluginId('claude'),
      pluginVersion: '0.2.4',
      selectedPath: bin,
      configHome: null,
      contentRoots: [{ path: bin, mode: 'file' }],
      fingerprint: revalidated.runtimeProfile.contentFingerprint ?? 'x'.repeat(64),
    },
  });
  const closed: string[] = [];
  const guardian = new RuntimeGuardian({
    resolver: new RuntimeResolver({
      dataDir: join(root, 'guard-resolver'),
      updateLockDataDir: join(root, 'guard-locks'),
      hostVersion: '0.1.0',
      homeDir: join(root, 'home'),
    }),
    readinessCache: liveCache,
    closeRuntimeOwner: async (pluginId) => { closed.push(pluginId); },
  });
  await guardian.checkNow();
  assert.equal(liveCache.isInvalidated('claude', '0.2.4', bin), true);
  assert.deepEqual(closed, ['claude']);

  const afterInvalidate = await AgentManager.create({
    ...options,
    runtimeResolver: testResolver(join(root, 'invalidated')),
    readinessCache: liveCache,
  });
  const blocked = await afterInvalidate.agentStatus(agent.id);
  assert.equal(blocked.ready, false);
  assert.notEqual(blocked.cli.state, 'ready');
  const probesAfterBlocked = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.equal(probesAfterBlocked.length, probesAfterCold.length);
});

test('unknown external and runtime:none follow the same cold-restart and invalidate rules', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-unknown-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'probes');
  const bin = join(root, 'bin', 'fixture');
  await writeExecutable(bin, '#!/bin/sh\necho fixture 1.2.3\n');
  const entry = await countingProxy(
    root,
    'io.gian.fixture',
    'Fixture CLI',
    '1.0.0',
    'fixture',
    ['1.2.3'],
    marker,
  );
  const noneEntry = await countingProxy(
    join(root, 'none-pkg'),
    'io.gian.none',
    'None CLI',
    '1.0.0',
    'none',
    ['1.2.3'],
    join(root, 'none-probes'),
  );
  const pluginStore = {
    currentLaunch: async (pluginId: string) => {
      if (pluginId === 'io.gian.fixture') {
        return {
          pluginId: parseProxyPluginId('io.gian.fixture'),
          pluginVersion: '1.0.0',
          manifestSha256: 'a'.repeat(64),
          protocolRange: '>=2.2 <3.0',
          entryPath: entry,
          processScope: 'session' as const,
          schemaVersion: 4 as const,
          runtime: {
            kind: 'external' as const,
            id: 'fixture',
            displayName: 'Fixture CLI',
            verifiedVersions: ['1.2.3'],
          },
        };
      }
      if (pluginId === 'io.gian.none') {
        return {
          pluginId: parseProxyPluginId('io.gian.none'),
          pluginVersion: '1.0.0',
          manifestSha256: 'b'.repeat(64),
          protocolRange: '>=2.2 <3.0',
          entryPath: noneEntry,
          processScope: 'session' as const,
          schemaVersion: 4 as const,
          runtime: { kind: 'none' as const },
        };
      }
      return null;
    },
  };
  const options = {
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false as const,
    developmentProxyEntries: await developmentEntries(root),
    runtimeResolver: testResolver(root),
    pluginStore: pluginStore as never,
    homeDir: join(root, 'home'),
    pathEnv: '',
    catalogService: allowCreateCatalog(),
  };
  const first = await AgentManager.create(options);
  const external = await first.createAgent({
    name: 'Fixture',
    pluginId: 'io.gian.fixture',
    cliPath: bin,
  });
  const none = await first.createAgent({
    name: 'None',
    pluginId: 'io.gian.none',
  });
  const externalReady = await first.agentStatus(external.id);
  const noneReady = await first.agentStatus(none.id);
  assert.equal(externalReady.ready, true);
  assert.equal(externalReady.cli.version, '1.2.3');
  assert.ok(externalReady.runtimeProfile);
  assert.equal(noneReady.ready, true);
  assert.equal(noneReady.cli.version, null);
  assert.ok(noneReady.runtimeProfile);
  assert.equal(isOpenRuntimeProfile(noneReady.runtimeProfile), true);

  const cold = await AgentManager.create({
    ...options,
    runtimeResolver: testResolver(join(root, 'cold')),
    readinessCache: new RuntimeReadinessCache(),
  });
  const externalCold = await cold.agentStatus(external.id);
  const noneCold = await cold.agentStatus(none.id);
  assert.equal(externalCold.ready, true);
  assert.ok(externalCold.runtimeProfile);
  assert.equal(noneCold.ready, true);
  assert.ok(noneCold.runtimeProfile);

  const cache = new RuntimeReadinessCache();
  cache.publish({
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.0.0',
    selectedPath: bin,
    profileIdentity: externalCold.runtimeProfile!.id,
    state: 'ready',
    displayName: 'Fixture CLI',
    profile: externalCold.runtimeProfile!,
  });
  cache.publish({
    pluginId: 'io.gian.none',
    pluginVersion: '1.0.0',
    selectedPath: null,
    profileIdentity: noneCold.runtimeProfile!.id,
    state: 'not_required',
    displayName: 'None CLI',
    profile: noneCold.runtimeProfile!,
  });
  cache.invalidate('io.gian.fixture', '1.0.0', bin);
  cache.invalidate('io.gian.none', '1.0.0', null);
  const blocked = await AgentManager.create({
    ...options,
    runtimeResolver: testResolver(join(root, 'blocked')),
    readinessCache: cache,
  });
  assert.equal((await blocked.agentStatus(external.id)).ready, false);
  assert.equal((await blocked.agentStatus(none.id)).ready, false);
});

test('createAgent bypasses are rejected without a partial agents.json row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-create-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin', 'claude');
  await writeExecutable(bin, '#!/bin/sh\necho claude 2.1.159\n');
  const bad = join(root, 'bin', 'old');
  await writeExecutable(bad, '#!/bin/sh\necho claude 0.1.0\n');
  const dataDir = join(root, 'data');
  const fixtureEntry = await countingProxy(
    join(root, 'fixture-pkg'),
    'io.gian.fixture',
    'Fixture CLI',
    '1.0.0',
    'fixture',
    ['1.2.3'],
    join(root, 'unused-probes'),
  );
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: await developmentEntries(root),
    runtimeResolver: testResolver(root),
    homeDir: join(root, 'home'),
    pathEnv: '',
    pluginStore: {
      currentLaunch: async (pluginId: string) => pluginId === 'io.gian.fixture'
        ? {
          pluginId: parseProxyPluginId('io.gian.fixture'),
          pluginVersion: '1.0.0',
          manifestSha256: 'a'.repeat(64),
          protocolRange: '>=2.2 <3.0',
          entryPath: fixtureEntry,
          processScope: 'session' as const,
          schemaVersion: 4 as const,
          runtime: {
            kind: 'external' as const,
            id: 'fixture',
            displayName: 'Fixture CLI',
            verifiedVersions: ['1.2.3'],
          },
        }
        : null,
    } as never,
    catalogService: {
      get: async (pluginId: string) => (
        pluginId === 'claude'
          ? { availableActions: ['create_agent'] }
          : { availableActions: [] }
      ),
    } as never,
  });

  await assert.rejects(
    () => manager.createAgent({ name: 'Missing', pluginId: 'io.gian.missing' }),
    (error: unknown) => error instanceof AgentCreateError && error.status === 404,
  );
  await assert.rejects(
    () => manager.createAgent({ name: 'Pathless', proxy: 'claude' }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_PATH_REQUIRED',
  );
  await assert.rejects(
    () => manager.createAgent({ name: 'Forbidden', pluginId: 'io.gian.fixture' }),
    (error: unknown) => error instanceof AgentCreateError && error.status === 409,
  );
  await assert.rejects(
    () => manager.createAgent({ name: 'Old', proxy: 'claude', cliPath: bad }),
    /incompatible/i,
  );
  assert.deepEqual(await persistedAgents(dataDir), []);

  const app = new Hono();
  registerAgentRoutes(app, {
    agents: manager,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      models: [],
      thinkingLevels: [],
      permissionModes: [],
      configOptions: [],
    }) as never,
  });
  const missing = await app.request('http://test.invalid/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP Missing', pluginId: 'io.gian.missing' }),
  });
  assert.equal(missing.status, 404);
  const pathless = await app.request('http://test.invalid/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP Pathless', proxy: 'claude' }),
  });
  assert.equal(pathless.status, 400);
  const forbidden = await app.request('http://test.invalid/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP Forbidden', pluginId: 'io.gian.fixture' }),
  });
  assert.equal(forbidden.status, 409);
  assert.deepEqual(await persistedAgents(dataDir), []);

  const created = await manager.createAgent({ name: 'Claude Code', proxy: 'claude', cliPath: bin });
  const renamed = await manager.updateAgent(created.id, { name: 'Renamed Claude' });
  const afterRename = await manager.agentStatus(renamed.id);
  assert.equal(afterRename.ready, true);
  assert.ok(afterRename.runtimeProfile);
  const secondBin = join(root, 'bin', 'claude-2');
  await writeExecutable(secondBin, '#!/bin/sh\necho claude 2.1.159\n');
  const moved = await manager.updateAgent(created.id, { cliPath: secondBin });
  const afterMove = await manager.agentStatus(moved.id);
  assert.equal(afterMove.ready, true);
  assert.equal(afterMove.runtimeProfile?.path, secondBin);
  assert.equal(afterMove.runtimeProfile?.agentId, moved.id);
});

test('Resolver generationKey does not reuse a live lease across Proxy versions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-generation-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, 'probes');
  const bin = join(root, 'bin', 'claude');
  await writeExecutable(bin, '#!/bin/sh\necho claude 2.1.159\n');
  const firstEntry = await countingProxy(root, 'claude', 'Claude Code', '0.2.4', 'claude', ['2.1.159'], marker);
  const secondEntry = await countingProxy(
    join(root, 'v025'),
    'claude',
    'Claude Code',
    '0.2.5',
    'claude',
    ['2.1.159'],
    marker,
  );
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    homeDir: join(root, 'home'),
  });
  const first = await resolver.resolve({
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '0.2.4',
    agentId: 'agent-old',
    entryPath: firstEntry,
    processScope: 'session',
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
    selectedPath: bin,
  });
  const second = await resolver.resolve({
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '0.2.5',
    agentId: 'agent-new',
    entryPath: secondEntry,
    processScope: 'session',
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
    selectedPath: bin,
  });
  const probes = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.deepEqual(probes, ['0.2.4', '0.2.5']);
  assert.equal(first.profile.pluginId, second.profile.pluginId);
  assert.equal(first.profile.path, second.profile.path);
  assert.notEqual(first.profile.agentId, second.profile.agentId);
  await first.lease?.release();
  await second.lease?.release();
  resolver.invalidate(parseProxyPluginId('claude'), bin);
  const third = await resolver.resolve({
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '0.2.5',
    agentId: 'agent-new',
    entryPath: secondEntry,
    processScope: 'session',
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
    selectedPath: bin,
  });
  const afterInvalidate = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.deepEqual(afterInvalidate, ['0.2.4', '0.2.5', '0.2.5']);
  await third.lease?.release();
});

test('Guardian invalidates cached observations before close and maps DSH/ZCode owners', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-guardian-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin', 'dsh');
  await writeExecutable(bin, '#!/bin/sh\necho dsh 0.1.1-rc.2\n');
  const entry = await fakeOfficialProxy(root, 'dsh', 'DeepSeek Harness', '0.1.6');
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    homeDir: join(root, 'home'),
  });
  const resolved = await resolver.resolve({
    pluginId: parseProxyPluginId('ai.deepseek.harness'),
    pluginVersion: '0.1.6',
    agentId: 'agent-dsh',
    entryPath: entry,
    processScope: 'shared',
    runtime: {
      kind: 'external',
      id: 'deepseek-harness',
      displayName: 'DeepSeek Harness',
      verifiedVersions: ['0.1.1-rc.2'],
    },
    selectedPath: bin,
  });
  await resolved.lease?.release();
  assert.ok(resolved.observation);
  const cache = new RuntimeReadinessCache();
  cache.publish({
    pluginId: 'ai.deepseek.harness',
    pluginVersion: '0.1.6',
    selectedPath: bin,
    profileIdentity: resolved.profile.id,
    state: 'ready',
    displayName: 'DeepSeek Harness',
    profile: resolved.profile,
    observation: resolved.observation,
  });
  await writeExecutable(bin, '#!/bin/sh\necho dsh 0.1.1-rc.2 mutated\n');
  const closed: string[] = [];
  const guardian = new RuntimeGuardian({
    resolver,
    readinessCache: cache,
    closeRuntimeOwner: async (pluginId) => {
      closed.push(pluginId);
      throw new Error('controlled close failure');
    },
  });
  await assert.rejects(guardian.checkNow(), AggregateError);
  assert.equal(cache.isInvalidated('ai.deepseek.harness', '0.1.6', bin), true);
  assert.deepEqual(closed, ['ai.deepseek.harness']);
  assert.equal(runtimeOwnerExecutorId('ai.deepseek.harness'), 'dsh');
  assert.equal(runtimeOwnerExecutorId('com.zhipu.zcode'), 'zcode');
  assert.equal(productExecutorForPluginId('ai.deepseek.harness'), 'dsh');
  const appSource = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  assert.match(appSource, /bindRuntimeOwnerCloser\(\(owner\) => proxy\.closeByExecutor\(owner\)\)/);
  assert.equal(appSource.includes('productExecutorForPluginId(pluginId)'), false);
});

test('Runtime API uses exact 400/404/409/413/502 and streams the 64KiB limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-api-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  let discoverCalls = 0;
  const cache = new RuntimeReadinessCache();
  const control = new RuntimeControlPlane({
    resolver: {
      discover: async () => {
        discoverCalls += 1;
        return { candidates: [], setupActions: [] };
      },
      resolve: async () => {
        throw new Error('upstream probe exploded');
      },
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
    catalogItem: async (pluginId) => {
      if (pluginId === 'io.gian.incompatible') {
        return {
          pluginId,
          availableActions: [],
          compatibility: { state: 'requires_app_update' },
          installation: { state: 'installed' },
        } as never;
      }
      return {
        pluginId,
        availableActions: ['select_runtime'],
        compatibility: { state: 'compatible' },
        installation: { state: 'installed' },
      } as never;
    },
  });
  const manager = await AgentManager.create({
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

  const incompatible = await app.request('http://test.invalid/api/proxies/io.gian.incompatible/runtime/discover', {
    method: 'POST',
  });
  assert.equal(incompatible.status, 200);
  const incompatibleBody = await incompatible.json() as { availableActions: string[] };
  assert.equal(incompatibleBody.availableActions.includes('create_agent'), false);
  assert.equal(discoverCalls, 0);

  const forbiddenProbe = await app.request('http://test.invalid/api/proxies/io.gian.incompatible/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(root, 'tool') }),
  });
  assert.equal(forbiddenProbe.status, 409);

  const badJson = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);

  const oversized = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"path":"${join(root, 'tool')}","pad":"${'x'.repeat(70 * 1024)}"}`,
  });
  assert.equal(oversized.status, 413);

  const exploded = await app.request('http://test.invalid/api/proxies/io.gian.fixture/runtime/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(root, 'tool') }),
  });
  assert.equal(exploded.status, 502);
});

test('configHome rejects an intermediate symlink that escapes into /etc', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-symlink-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const selected = join(home, 'bin', 'tool');
  await writeExecutable(selected, '#!/bin/sh\necho tool 1.0.0\n');
  await symlink('/etc', join(home, '.evil'));
  const configHome = join(home, '.evil');
  const escaped = join(home, '.evil', 'hosts');
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome,
      contentRoots: [{ path: escaped, mode: 'file' }],
      homeDir: home,
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError
      && /escaped its authorized identity roots: .*\/\.evil/.test(error.message),
  );

  const companion = join(home, 'bin');
  await symlink('/etc', join(root, 'retarget'));
  const raced = join(root, 'raced');
  await mkdir(raced);
  await writeExecutable(join(raced, 'tool'), '#!/bin/sh\necho tool 1.0.0\n');
  await symlink(join(root, 'retarget'), join(raced, 'escape'));
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: join(raced, 'tool'),
      configHome: companion,
      contentRoots: [{ path: join(raced, 'escape', 'hosts'), mode: 'file' }],
      homeDir: home,
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError,
  );
});

test('official-managed static packages validate version name, v4 logo, and hashes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round2-static-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const versionDir = join(root, 'data', 'plugins', 'claude', '0.2.4');
  await mkdir(join(versionDir, 'assets'), { recursive: true });
  await writeFile(join(versionDir, 'proxy.mjs'), 'export {};\n');
  await writeFile(join(versionDir, 'assets', 'logo-light.png'), PNG);
  const digest = createHash('sha256').update(PNG).digest('hex');
  await writeFile(join(versionDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '0.2.4',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'external', id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
    branding: {
      logo: {
        light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: digest },
      },
    },
  }));
  await symlink('0.2.4', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');
  const trusted = await validateStaticProxyPackage({
    directory: versionDir,
    expectedId: 'claude',
    expectedVersion: '0.2.4',
    source: 'official-managed',
  });
  assert.equal(trusted.schemaVersion, 4);
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const logo = await manager.proxyLogo('claude', 'light');
  assert.ok(logo);
  assert.equal(logo.mediaType, 'image/png');
  assert.equal(logo.sha256, digest);
  assert.deepEqual(logo.bytes, PNG);

  const wrongName = join(root, 'data', 'plugins', 'claude', 'wrong');
  await mkdir(join(wrongName, 'assets'), { recursive: true });
  await writeFile(join(wrongName, 'proxy.mjs'), 'export {};\n');
  await writeFile(join(wrongName, 'assets', 'logo-light.png'), PNG);
  await writeFile(join(wrongName, 'manifest.json'), await readFile(join(versionDir, 'manifest.json')));
  await assert.rejects(
    () => validateStaticProxyPackage({
      directory: wrongName,
      expectedId: 'claude',
      expectedVersion: '0.2.4',
      source: 'official-managed',
    }),
    /current target name must match Manifest pluginVersion/,
  );
});

test('production Host surfaces no dummy runtimeManager or runtimes route branch', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/web/routes/agents.ts', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../src/proxy/manager.ts', import.meta.url), 'utf8');
  for (const token of ['runtimeManager', 'runtimeProviders()', 'runtimes:']) {
    assert.equal(index.includes(token), false, token);
    assert.equal(app.includes(token), false, token);
    assert.equal(routes.includes(token), false, token);
    assert.equal(manager.includes(token), false, token);
  }
});
