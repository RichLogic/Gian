import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  PROTOCOL_V22,
  RUNTIME_BOOTSTRAP_ENV,
  RUNTIME_BOOTSTRAP_VALUE,
  type ManifestV4,
} from '@gian/proxy-protocol';
import { isOpenRuntimeProfile, parseProxyPluginId } from '@gian/shared';

import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import type { AgentUpdateLease } from '../src/agents/update-lock.js';
import { acquireAgentUpdateLock } from '../src/agents/update-lock.js';
import { catalogProxyActions } from '../src/catalog/service.js';
import { pluginChildEnvironment } from '../src/plugin-store/child-env.js';
import {
  initializeCatalogPackage,
  noRuntimeActivationEnvironment,
} from '../src/plugin-store/initialize.js';
import {
  assertAuthorizedFilesystemIdentity,
  ConfigHomeIdentityError,
  isAuthorizedConfigHome,
} from '../src/runtime/config-home.js';
import { RuntimeControlError, RuntimeControlPlane } from '../src/runtime/control-plane.js';
import { hostRuntimeFingerprint } from '../src/runtime/fingerprint.js';
import {
  bindRuntimeOwnerCloser,
  RuntimeGuardian,
  runtimeOwnerCloseKey,
} from '../src/runtime/guardian.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';
import { validateStaticProxyPackage } from '../src/runtime/trusted-launch.js';
import { developmentEntries, testResolver } from './runtime-test-harness.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const OFFICIAL = [
  { name: 'claude', packageDir: 'cc-proxy', pluginId: 'claude', processScope: 'session' as const },
  { name: 'codex', packageDir: 'codex-proxy', pluginId: 'codex', processScope: 'shared' as const },
  { name: 'kimi', packageDir: 'kimi-proxy', pluginId: 'kimi', processScope: 'shared' as const },
  { name: 'grok', packageDir: 'grok-proxy', pluginId: 'grok', processScope: 'session' as const },
  { name: 'dsh', packageDir: 'dsh-proxy', pluginId: 'ai.deepseek.harness', processScope: 'shared' as const },
  { name: 'zcode', packageDir: 'zcode-proxy', pluginId: 'com.zhipu.zcode', processScope: 'shared' as const },
] as const;

function trackingLease(): { events: string[]; protector: AgentUpdateLease } {
  const events: string[] = [];
  return {
    events,
    protector: {
      async reserveProcessGroup() {
        return {
          async register(groupId: number) {
            events.push(`register:${groupId}`);
            return 'registered';
          },
          async cancelBeforeSpawn() {
            events.push('cancel');
          },
          async releaseUnregistered(groupId: number) {
            events.push(`unreg:${groupId}`);
          },
          async release() {
            events.push('release');
          },
        };
      },
      async release() {
        events.push('lease-release');
      },
    },
  };
}

function listGroupMembers(groupId: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,pgid='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const pids: number[] = [];
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (match && Number(match[2]) === groupId) pids.push(Number(match[1]));
      }
      resolve(pids);
    });
  });
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

function allowCreateCatalog() {
  return {
    get: async () => ({ availableActions: ['create_agent'] }),
  } as never;
}

async function noneOfficialProxy(root: string): Promise<string> {
  const packageDir = join(root, 'none-claude');
  const proxy = join(packageDir, 'dist', 'src', 'cli', 'spawn.js');
  await mkdir(dirname(proxy), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@gian/cc-proxy',
    version: '0.2.4',
  }));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '0.2.4',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'none' },
    branding: {
      logo: {
        light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: 'a'.repeat(64) },
      },
    },
  }));
  await writeFile(proxy, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, result,
  }) + '\\n');
  if (req.method === 'initialize') {
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: 'claude', name: 'Claude Code', version: '0.2.4' },
      process: { scope: 'session' },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'runtime.discover') {
    reply({ candidates: [], setupActions: [] });
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

async function recordingActivationProxy(root: string, envLog: string): Promise<string> {
  const path = join(root, 'record-activate.mjs');
  await writeExecutable(path, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  bootstrap: process.env.GIAN_RUNTIME_BOOTSTRAP ?? null,
  runtimeBin: Object.prototype.hasOwnProperty.call(process.env, 'GIAN_RUNTIME_BIN'),
  runtimeBinValue: process.env.GIAN_RUNTIME_BIN ?? null,
  versions: process.env.GIAN_PROTOCOL_VERSIONS ?? null,
}));
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, result,
  }) + '\\n');
  if (req.method === 'initialize') {
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: 'claude', name: 'Claude Code', version: '0.2.4' },
      process: { scope: 'session' },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'catalog.list') {
    reply({
      catalogRevision: 'runtime-bootstrap',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
      specialCatalogs: {},
    });
    return;
  }
  if (req.method === 'shutdown') {
    reply({ ok: true });
    process.exit(0);
  }
});
`);
  return path;
}

test('no-Runtime activation child env sets the bootstrap marker and never offers a Runtime bin', () => {
  const env = noRuntimeActivationEnvironment({ pluginId: 'claude' });
  assert.equal(env[RUNTIME_BOOTSTRAP_ENV], RUNTIME_BOOTSTRAP_VALUE);
  assert.equal(Object.hasOwn(env, 'GIAN_RUNTIME_BIN'), false);
  assert.equal(env.GIAN_PROTOCOL_VERSIONS, PROTOCOL_V22);
  const session = pluginChildEnvironment({
    pluginId: 'claude',
    protocolVersions: [PROTOCOL_V22],
  });
  assert.equal(session[RUNTIME_BOOTSTRAP_ENV], undefined);
});

test('PluginStore activates each official spawn.js in bootstrap with no vendor children', {
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-official-activate-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousKimi = process.env.KIMI_CODE_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousKimi === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimi;
  });
  process.env.HOME = root;
  process.env.KIMI_CODE_HOME = join(root, '.kimi-code');
  process.env.PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

  for (const item of OFFICIAL) {
    const packageDir = join(repoRoot, 'packages', 'proxies', item.packageDir);
    const raw = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8')) as ManifestV4;
    const manifest: ManifestV4 = { ...raw, entry: 'dist/src/cli/spawn.js' };
    await chmod(join(packageDir, manifest.entry), 0o755);
    const lease = trackingLease();
    const negotiated = await initializeCatalogPackage({
      directory: packageDir,
      manifest,
      dataDir: join(root, 'data', item.name),
      hostVersion: '0.1.0',
      protector: lease.protector,
    });
    assert.equal(negotiated, PROTOCOL_V22, item.name);
    const registered = lease.events
      .filter((event) => event.startsWith('register:'))
      .map((event) => Number(event.slice('register:'.length)));
    assert.ok(registered.length >= 1, `${item.name} never registered a process group`);
    assert.ok(lease.events.includes('release'), `${item.name} did not release its process group`);
    for (const groupId of registered) {
      assert.deepEqual(await listGroupMembers(groupId), [], `${item.name} left a vendor/session child`);
    }
  }
});

test('AgentManager v4 compatibility probe uses the same bootstrap marker contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-agent-activate-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const envLog = join(root, 'env.json');
  const entryPath = await recordingActivationProxy(root, envLog);
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: await developmentEntries(root),
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const internals = manager as unknown as {
    runProxyCompatibilityProbe: (
      input: {
        id: 'claude';
        version: string;
        entryPath: string;
        protocol: 'gian.proxy';
        processScope: 'session';
        schemaVersion: 4;
      },
      updateOwner: AgentUpdateLease,
    ) => Promise<void>;
  };
  const updateOwner = await acquireAgentUpdateLock(
    join(root, 'locks'),
    'claude',
    'v4 no-Runtime activation',
  );
  try {
    await internals.runProxyCompatibilityProbe({
      id: 'claude',
      version: '0.2.4',
      entryPath,
      protocol: 'gian.proxy',
      processScope: 'session',
      schemaVersion: 4,
    }, updateOwner);
  } finally {
    await updateOwner.release();
  }
  const recorded = JSON.parse(await readFile(envLog, 'utf8')) as {
    bootstrap: string | null;
    runtimeBin: boolean;
    versions: string | null;
  };
  assert.equal(recorded.bootstrap, RUNTIME_BOOTSTRAP_VALUE);
  assert.equal(recorded.runtimeBin, false);
  assert.equal(recorded.versions, PROTOCOL_V22);
});

test('Guardian close helper uses the open pluginId for unknown owners', async () => {
  assert.equal(runtimeOwnerCloseKey('io.gian.fixture'), 'io.gian.fixture');
  assert.equal(runtimeOwnerCloseKey('ai.deepseek.harness'), 'dsh');
  const closed: string[] = [];
  const closer = bindRuntimeOwnerCloser(async (owner) => {
    closed.push(owner);
  });
  await closer('io.gian.fixture');
  await closer('ai.deepseek.harness');
  assert.deepEqual(closed, ['io.gian.fixture', 'dsh']);
  const app = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  assert.match(app, /bindRuntimeOwnerCloser\(\(owner\) => proxy\.closeByExecutor\(owner\)\)/);
  assert.equal(app.includes('productExecutorForPluginId(pluginId)'), false);
});

test('two Proxy generations on one path keep distinct observations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-generations-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const bin = join(root, 'bin', 'fixture');
  const extra = join(root, 'bin', 'old-root');
  await writeExecutable(bin, '#!/bin/sh\necho fixture 1.2.3\n');
  await mkdir(extra, { recursive: true });
  await writeFile(join(extra, 'marker'), 'old\n');
  const oldFingerprint = await hostRuntimeFingerprint({
    selectedPath: bin,
    configHome: null,
    contentRoots: [
      { path: bin, mode: 'file' },
      { path: extra, mode: 'directory' },
    ],
    homeDir: home,
  });
  const newFingerprint = await hostRuntimeFingerprint({
    selectedPath: bin,
    configHome: null,
    contentRoots: [{ path: bin, mode: 'file' }],
    homeDir: home,
  });
  const cache = new RuntimeReadinessCache();
  const profile = (pluginVersion: string, fingerprint: string) => ({
    id: `profile-${pluginVersion}`,
    agentId: 'fixture',
    pluginId: 'io.gian.fixture',
    runtimeId: 'fixture',
    path: bin,
    version: '1.2.3',
    configHome: null,
    contentFingerprint: fingerprint,
    verifiedVersions: ['1.2.3'],
    verification: 'verified' as const,
  });
  cache.publish({
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.0.0',
    selectedPath: bin,
    profileIdentity: 'profile-1.0.0',
    state: 'ready',
    displayName: 'Fixture',
    profile: profile('1.0.0', oldFingerprint),
    observation: {
      pluginId: parseProxyPluginId('io.gian.fixture'),
      pluginVersion: '1.0.0',
      selectedPath: bin,
      configHome: null,
      contentRoots: [
        { path: bin, mode: 'file' },
        { path: extra, mode: 'directory' },
      ],
      fingerprint: oldFingerprint,
    },
  });
  cache.publish({
    pluginId: 'io.gian.fixture',
    pluginVersion: '2.0.0',
    selectedPath: bin,
    profileIdentity: 'profile-2.0.0',
    state: 'ready',
    displayName: 'Fixture',
    profile: profile('2.0.0', newFingerprint),
    observation: {
      pluginId: parseProxyPluginId('io.gian.fixture'),
      pluginVersion: '2.0.0',
      selectedPath: bin,
      configHome: null,
      contentRoots: [{ path: bin, mode: 'file' }],
      fingerprint: newFingerprint,
    },
  });
  const closed: string[] = [];
  const guardian = new RuntimeGuardian({
    resolver: new RuntimeResolver({
      dataDir: join(root, 'resolver'),
      updateLockDataDir: join(root, 'locks'),
      hostVersion: '0.1.0',
      homeDir: home,
    }),
    readinessCache: cache,
    closeRuntimeOwner: bindRuntimeOwnerCloser(async (owner) => {
      closed.push(owner);
    }),
  });
  await writeFile(join(extra, 'marker'), 'mutated\n');
  await guardian.checkNow();
  assert.deepEqual(closed, ['io.gian.fixture']);
  assert.equal(cache.isInvalidated('io.gian.fixture', '1.0.0', bin), true);
  assert.equal(cache.isInvalidated('io.gian.fixture', '2.0.0', bin), true);
});

test('configHome rejects system companions and HOME-folder symlink escapes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gian-round3-config-home-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(home, { recursive: true, force: true });
  });
  const selected = join(home, '.local', 'bin', 'tool');
  await writeExecutable(selected, '#!/bin/sh\necho tool 1.0.0\n');
  assert.equal(isAuthorizedConfigHome('/etc', '/etc/tool', home), false);
  assert.equal(isAuthorizedConfigHome('/usr/bin', '/usr/bin/tool', home), false);
  assert.equal(isAuthorizedConfigHome('/private', '/private/var/tool', home), false);

  await mkdir(join(home, 'Documents'), { recursive: true });
  await mkdir(join(home, '.kimi-code'), { recursive: true });
  await mkdir(join(home, 'Library', 'Application Support', 'Tool'), { recursive: true });
  const xdg = join(home, 'xdg-config', 'tool');
  await mkdir(xdg, { recursive: true });
  const companionRoot = join(home, 'opt', 'vendor', 'bin');
  await mkdir(companionRoot, { recursive: true });
  const companionBin = join(companionRoot, 'tool');
  await writeExecutable(companionBin, '#!/bin/sh\necho tool 1.0.0\n');
  await symlink(join(home, 'Documents'), join(home, '.evil-docs'));
  await symlink('/etc', join(home, '.evil-etc'));

  await assert.rejects(
    () => assertAuthorizedFilesystemIdentity(join(home, '.evil-docs'), selected, home),
    (error: unknown) => error instanceof ConfigHomeIdentityError,
  );
  await assert.rejects(
    () => assertAuthorizedFilesystemIdentity(join(home, '.evil-etc'), selected, home),
    (error: unknown) => error instanceof ConfigHomeIdentityError,
  );
  await assertAuthorizedFilesystemIdentity(join(home, '.kimi-code'), selected, home);
  await assertAuthorizedFilesystemIdentity(
    join(home, 'Library', 'Application Support', 'Tool'),
    selected,
    home,
  );
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(home, 'xdg-config');
  try {
    await assertAuthorizedFilesystemIdentity(xdg, selected, home);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
  assert.equal(isAuthorizedConfigHome(companionRoot, companionBin, home), true);
  await assertAuthorizedFilesystemIdentity(companionRoot, companionBin, home);
});

test('RuntimeControlPlane and v4 create reject missing Catalog policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-policy-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  assert.throws(
    () => new RuntimeControlPlane({
      resolver: new RuntimeResolver({
        dataDir: join(root, 'resolver'),
        updateLockDataDir: join(root, 'locks'),
        hostVersion: '0.1.0',
        homeDir: join(root, 'home'),
      }),
      cache: new RuntimeReadinessCache(),
      resolveLaunch: async () => null,
    }),
    (error: unknown) => (
      error instanceof RuntimeControlError && error.code === 'RUNTIME_CATALOG_POLICY_REQUIRED'
    ),
  );
  const bin = join(root, 'bin', 'claude');
  await writeExecutable(bin, '#!/bin/sh\necho claude 2.1.159\n');
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: await developmentEntries(root),
    runtimeResolver: testResolver(root),
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  await assert.rejects(
    () => manager.createAgent({ name: 'Claude Code', proxy: 'claude', cliPath: bin }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'CATALOG_UNAVAILABLE',
  );
});

test('repairable invalid Runtime exposes setup/select and withholds create_agent', () => {
  assert.deepEqual(catalogProxyActions({
    compatibility: 'compatible',
    installation: 'installed',
    updateAvailable: false,
    runtime: 'invalid',
    runtimeRepairable: true,
    canRollback: false,
    installable: false,
  }), ['open_setup', 'select_runtime']);
  assert.deepEqual(catalogProxyActions({
    compatibility: 'compatible',
    installation: 'installed',
    updateAvailable: false,
    runtime: 'invalid',
    canRollback: false,
    installable: false,
  }), []);
});

test('official v4 runtime:none keeps its profile and does not invent an external runtimeId', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-none-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const noneEntry = await noneOfficialProxy(root);
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { ...(await developmentEntries(root)), claude: noneEntry },
    runtimeResolver: testResolver(root),
    homeDir: join(root, 'home'),
    pathEnv: '',
    catalogService: allowCreateCatalog(),
  });
  const agent = await manager.createAgent({ name: 'None Claude', proxy: 'claude' });
  const status = await manager.agentStatus(agent.id);
  assert.equal(status.ready, true);
  assert.ok(status.runtimeProfile);
  assert.equal(isOpenRuntimeProfile(status.runtimeProfile), true);
  assert.equal(status.runtimeProfile.path, null);
  assert.equal(status.runtimeProfile.runtimeId, null);
  const descriptor = await manager.proxyLaunchDescriptor('claude');
  assert.equal(descriptor.protocol?.runtimeId, undefined);
});

test('official-managed packages reject an empty or unreadable entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-round3-entry-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const versionDir = join(root, '0.2.4');
  await mkdir(join(versionDir, 'assets'), { recursive: true });
  await writeFile(join(versionDir, 'proxy.mjs'), '');
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
  await assert.rejects(
    () => validateStaticProxyPackage({
      directory: versionDir,
      expectedId: 'claude',
      expectedVersion: '0.2.4',
      source: 'official-managed',
    }),
    /entry size is invalid/,
  );
  await writeFile(join(versionDir, 'proxy.mjs'), 'export {};\n');
  await chmod(join(versionDir, 'proxy.mjs'), 0o000);
  await assert.rejects(
    () => validateStaticProxyPackage({
      directory: versionDir,
      expectedId: 'claude',
      expectedVersion: '0.2.4',
      source: 'official-managed',
    }),
    /not readable|entry size is invalid|EACCES/,
  );
  await chmod(join(versionDir, 'proxy.mjs'), 0o644);
});
