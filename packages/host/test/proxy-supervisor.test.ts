import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import {
  KNOWN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@gian/proxy-protocol';
import { parseProxyPluginId } from '@gian/shared';

import type { RuntimeLease } from '../src/runtime/types.js';
import {
  sessionProcessKey,
  sharedProcessKey,
  validateLaunchBinding,
  type ProxyLaunchBinding,
} from '../src/proxy/launch-binding.js';
import { officialRuntimeIdentity, resolveLegacyLaunch } from '../src/proxy/legacy-launch.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';
import { legacyProxyManagerConfig } from './helpers/legacy-proxy-manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function fixtureSource(options: {
  pluginId?: string;
  pluginVersion?: string;
  processScope?: 'shared' | 'session';
  protocolVersion?: string;
  offeredPath?: string;
  handshake?: Partial<{
    pluginId: string;
    pluginVersion: string;
    processScope: string;
    protocolVersion: string;
  }>;
} = {}): string {
  const pluginId = options.pluginId ?? 'io.gian.fixture';
  const pluginVersion = options.pluginVersion ?? '1.0.0';
  const processScope = options.processScope ?? 'shared';
  const protocolVersion = options.protocolVersion ?? '2.1';
  const handshake = options.handshake ?? {};
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-09-03T00:00:00.000Z';
const pluginId = ${JSON.stringify(handshake.pluginId ?? pluginId)};
const pluginVersion = ${JSON.stringify(handshake.pluginVersion ?? pluginVersion)};
const processScope = ${JSON.stringify(handshake.processScope ?? processScope)};
const protocolVersion = ${JSON.stringify(handshake.protocolVersion ?? protocolVersion)};
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.jsonrpc !== '2.0' || typeof request.id !== 'string') {
    throw new Error('fixture expected JSON-RPC 2.0 string ids');
  }
  if (request.method === 'initialize') {
    ${options.offeredPath ? `await (await import('node:fs/promises')).writeFile(${JSON.stringify(options.offeredPath)}, JSON.stringify(request.params.protocol.versions));` : ''}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: protocolVersion },
      plugin: { id: pluginId, name: 'Fixture', version: pluginVersion },
      process: { scope: processScope },
      capabilities: {},
    } }) + '\\n');
  } else if (request.method === 'catalog.list') {
    const catalog = {
      catalogRevision: 'rev-1',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
      ...(protocolVersion === '2.0' ? {} : { specialCatalogs: {} }),
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: catalog }) + '\\n');
  } else if (request.method === 'session.create') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { session: {
      id: request.params.sessionId,
      nativeSession: { id: 'native-1' },
      streamId: 'stream-1',
      state: 'idle',
      sessionConfig: request.params.config ?? {},
      createdAt: emittedAt,
      updatedAt: emittedAt,
    } } }) + '\\n');
  } else if (request.method === 'turn.start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      accepted: true,
      turnId: request.params.turnId,
    } }) + '\\n');
    const base = {
      streamId: request.params.streamId,
      sessionId: request.params.sessionId,
      turnId: request.params.turnId,
      sourceTurnId: request.params.turnId,
      emittedAt,
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.started', params: {
      ...base, eventId: 'event-1', sequence: 1, data: {},
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.delta', params: {
      ...base, eventId: 'event-2', sequence: 2,
      data: { contentId: 'content-1', kind: 'text', delta: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.completed', params: {
      ...base, eventId: 'event-3', sequence: 3,
      data: { contentId: 'content-1', kind: 'text', content: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.completed', params: {
      ...base, eventId: 'event-4', sequence: 4,
      data: { stopReason: 'completed' },
    } }) + '\\n');
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    if (request.method === 'shutdown') break;
  }
}
`;
}

async function writeFixture(
  t: TestContext,
  source: string,
): Promise<{ root: string; entry: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-supervisor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, source);
  return { root, entry, dataDir: join(root, 'data') };
}

function binding(
  entryPath: string,
  overrides: Partial<ProxyLaunchBinding> = {},
): ProxyLaunchBinding {
  return {
    pluginId: parseProxyPluginId('io.gian.fixture'),
    pluginVersion: '1.0.0',
    manifestSha256: 'ab'.repeat(32),
    entryPath,
    processScope: 'shared',
    protocolVersion: '2.1',
    runtimeProfile: null,
    ...overrides,
  };
}

function lease(onRelease?: () => Promise<void> | void): RuntimeLease {
  return {
    cli: 'claude',
    binaryPath: process.execPath,
    version: '1.0.0',
    source: 'managed',
    env: {},
    async release() {
      await onRelease?.();
    },
  };
}

function managerFor(dataDir: string, entryPath: string): ProxyManager {
  return new ProxyManager(legacyProxyManagerConfig({
    dataDir,
    ccProxyEntry: entryPath,
    claudeProxy: { pluginVersion: '1.0.0', processScope: 'session', schemaVersion: 3 },
  }));
}

function hostOf(client: ProtocolV2SessionClient) {
  return client.runtimeHost();
}

test('process keys isolate version, protocol, runtime, scope, and package coordinate', () => {
  const base = binding('/tmp/proxy.mjs');
  const shared = sharedProcessKey(base);
  assert.notEqual(shared, sharedProcessKey({ ...base, pluginVersion: '1.0.1' }));
  assert.notEqual(shared, sharedProcessKey({ ...base, protocolVersion: '2.0' }));
  assert.notEqual(shared, sharedProcessKey({ ...base, protocolVersion: '2.2' }));
  assert.notEqual(
    shared,
    sharedProcessKey({ ...base, runtimeProfile: { identity: 'profile-a' } }),
  );
  assert.notEqual(shared, sharedProcessKey({ ...base, processScope: 'session' }));
  assert.notEqual(shared, sharedProcessKey({ ...base, manifestSha256: 'cd'.repeat(32) }));
  assert.notEqual(shared, sharedProcessKey({ ...base, entryPath: '/tmp/other-proxy.mjs' }));
  assert.notEqual(
    sharedProcessKey({ ...base, runtimeProfile: null }),
    sharedProcessKey({ ...base, runtimeProfile: { identity: 'none' } }),
  );
  assert.notEqual(shared, sessionProcessKey(base, 'session-1'));
  assert.notEqual(sessionProcessKey(base, 'session-1'), sessionProcessKey(base, 'session-2'));
});

test('generic bindings reject collisions, invalid fields, and offer widening', () => {
  const base = binding('/tmp/proxy.mjs');
  assert.throws(() => validateLaunchBinding({ ...base, runtimeProfile: { identity: ' none ' } }));
  assert.throws(() => validateLaunchBinding({ ...base, runtimeProfile: { identity: '' } }));
  assert.throws(() => validateLaunchBinding({ ...base, runtimeProfile: { identity: 'a\u0000b' } }));
  assert.throws(() => validateLaunchBinding({ ...base, runtimeProfile: { identity: 'a\tb' } }));
  assert.throws(() => validateLaunchBinding({ ...base, entryPath: 'relative/proxy.mjs' }));
  assert.throws(() => validateLaunchBinding({ ...base, entryPath: '/tmp/foo/../proxy.mjs' }));
  assert.throws(() => validateLaunchBinding({ ...base, manifestSha256: 'AB'.repeat(32) }));
  assert.doesNotThrow(() => validateLaunchBinding({ ...base, protocolVersion: '2.2' }));
  assert.throws(() => validateLaunchBinding({ ...base, protocolVersion: '9.9' }));
  assert.throws(() => validateLaunchBinding({
    ...base,
    runtimeProfile: { identity: 'x'.repeat(1025) },
  }));
  assert.throws(() => validateLaunchBinding({
    ...base,
    pluginId: 'not a plugin' as ProxyLaunchBinding['pluginId'],
  }));
  assert.throws(() => validateLaunchBinding({
    ...base,
    offeredProtocolVersions: ['2.1', '2.0', '2.2'],
  } as ProxyLaunchBinding));
  assert.throws(() => validateLaunchBinding({
    ...base,
    retireOnFailedAttach: true,
  } as ProxyLaunchBinding));
});

test('generic supervisor files have no Provider or plugin literal branches', async () => {
  const files = [
    join(repoRoot, 'packages/host/src/proxy/supervisor.ts'),
    join(repoRoot, 'packages/host/src/proxy/launch-binding.ts'),
    join(repoRoot, 'packages/host/src/proxy/manager.ts'),
    join(repoRoot, 'packages/host/src/proxy/protocol-v2-session-client.ts'),
    join(repoRoot, 'packages/host/src/proxy/protocol-v2-client.ts'),
  ];
  const forbidden = [
    /\bproductExecutorForPluginId\b/,
    /\bas Executor\b/,
    /pluginId\s+as\s+Executor/,
    /executor\s*===\s*['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
    /case ['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
  ];
  const launchBinding = await readFile(join(repoRoot, 'packages/host/src/proxy/launch-binding.ts'), 'utf8');
  assert.equal(launchBinding.includes('SUPPORTED_PROTOCOL_VERSIONS'), false);
  assert.equal(launchBinding.includes('KNOWN_PROTOCOL_VERSIONS'), true);
  const protocolClient = await readFile(join(repoRoot, 'packages/host/src/proxy/protocol-v2-client.ts'), 'utf8');
  assert.equal(protocolClient.includes('[...SUPPORTED_PROTOCOL_VERSIONS]'), true);
  const legacyLaunch = await readFile(join(repoRoot, 'packages/host/src/proxy/legacy-launch.ts'), 'utf8');
  assert.equal(legacyLaunch.includes('PROTOCOL_V22'), true);
  assert.equal(legacyLaunch.includes('SUPPORTED_PROTOCOL_VERSIONS'), true);
  assert.equal(legacyLaunch.includes('isGenericRuntimeProtocol'), false);
  assert.equal(legacyLaunch.includes('OFFICIAL_POLICIES'), false);
  const bindingInterface = launchBinding.slice(
    launchBinding.indexOf('export interface ProxyLaunchBinding'),
    launchBinding.indexOf('export type CanonicalRuntime'),
  );
  assert.equal(bindingInterface.includes('offeredProtocolVersions'), false);
  assert.equal(bindingInterface.includes('retireOnFailedAttach'), false);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      if (file.endsWith('launch-binding.ts') && pattern.source === '\\bas Executor\\b') continue;
      assert.equal(pattern.test(source), false, `${file} matched ${pattern}`);
    }
  }
});

test('unknown fixture shared scope reuses one exact host for concurrent creates', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'shared' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const launch = binding(entry, { processScope: 'shared' });
  const [first, second] = await Promise.all([
    manager.acquireWithBinding('session-a', launch),
    manager.acquireWithBinding('session-b', launch),
  ]);
  assert.ok(first instanceof ProtocolV2SessionClient);
  assert.ok(second instanceof ProtocolV2SessionClient);
  assert.equal(hostOf(first), hostOf(second));
  assert.equal(first.pluginId, 'io.gian.fixture');
  const created = await first.createSession({ cwd: dataDir });
  assert.equal(created.nativeSessionId, 'native-1');
  await first.startTurn({
    sessionId: 'session-a',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  });
  await first.closeSession();
  await manager.dispose('session-a');
  assert.equal(hostOf(second).isExited(), false);
  await manager.dispose('session-b');
});

test('unknown fixture session scope gives each Session its own owner', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const launch = binding(entry, { processScope: 'session' });
  const first = await manager.acquireWithBinding('session-a', launch) as ProtocolV2SessionClient;
  const second = await manager.acquireWithBinding('session-b', launch) as ProtocolV2SessionClient;
  assert.notEqual(hostOf(first), hostOf(second));
  await first.createSession({ cwd: dataDir });
  await second.createSession({ cwd: dataDir });
  await first.closeSession();
  await second.closeSession();
});

test('same plugin with different version, protocol, or profile never shares', async (t) => {
  const baselineFixture = await writeFixture(t, fixtureSource({ processScope: 'shared' }));
  const versionFixture = await writeFixture(t, fixtureSource({
    processScope: 'shared',
    pluginVersion: '1.0.1',
  }));
  const protocolFixture = await writeFixture(t, fixtureSource({
    processScope: 'shared',
    protocolVersion: '2.0',
  }));
  const manager = managerFor(baselineFixture.dataDir, baselineFixture.entry);
  t.after(() => manager.closeAll());
  const base = binding(baselineFixture.entry, { processScope: 'shared' });
  const [versioned, protocoled, profiled, baseline] = await Promise.all([
    manager.acquireWithBinding('v', binding(versionFixture.entry, {
      processScope: 'shared',
      pluginVersion: '1.0.1',
    })),
    manager.acquireWithBinding('p', binding(protocolFixture.entry, {
      processScope: 'shared',
      protocolVersion: '2.0',
    })),
    manager.acquireWithBinding('r', { ...base, runtimeProfile: { identity: 'profile-a' } }),
    manager.acquireWithBinding('b', base),
  ]);
  const hosts = [versioned, protocoled, profiled, baseline].map((client) => (
    hostOf(client as ProtocolV2SessionClient)
  ));
  assert.equal(new Set(hosts).size, 4);
});

test('initialize mismatch publishes nothing and releases the exact lease', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({
    processScope: 'shared',
    handshake: { pluginId: 'io.gian.other' },
  }));
  let releases = 0;
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  await assert.rejects(
    () => manager.acquireWithBinding(
      'bad',
      binding(entry, { processScope: 'shared' }),
      {
        acquireLease: async (): Promise<RuntimeLease> => ({
          cli: 'claude',
          binaryPath: process.execPath,
          version: '1.0.0',
          source: 'managed',
          env: {},
          async release() {
            releases += 1;
          },
        }),
      },
    ),
    /plugin id|Handshake/i,
  );
  assert.equal(manager.get('bad'), undefined);
  assert.equal(releases, 1);
});

test('generic failed attach keeps the exact shared host', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'shared' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const launch = binding(entry, { processScope: 'shared' });
  const first = await manager.acquireWithBinding('failed', launch) as ProtocolV2SessionClient;
  const firstHost = hostOf(first);
  await manager.dispose('failed');
  const retry = await manager.acquireWithBinding('retry', launch) as ProtocolV2SessionClient;
  assert.equal(hostOf(retry), firstHost);
});

test('same Session rejects a different exact binding before and after publish', async (t) => {
  const baseline = await writeFixture(t, fixtureSource({ processScope: 'shared' }));
  const otherVersion = await writeFixture(t, fixtureSource({
    processScope: 'shared',
    pluginVersion: '1.0.1',
  }));
  const otherProtocol = await writeFixture(t, fixtureSource({
    processScope: 'shared',
    protocolVersion: '2.0',
  }));
  const otherScope = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const manager = managerFor(baseline.dataDir, baseline.entry);
  t.after(() => manager.closeAll());
  const published = binding(baseline.entry, { processScope: 'shared' });
  const first = await manager.acquireWithBinding('stable', published);
  const mismatches: ProxyLaunchBinding[] = [
    binding(otherVersion.entry, { processScope: 'shared', pluginVersion: '1.0.1' }),
    binding(otherProtocol.entry, { processScope: 'shared', protocolVersion: '2.0' }),
    { ...published, runtimeProfile: { identity: 'profile-b' } },
    binding(otherScope.entry, { processScope: 'session' }),
    { ...published, manifestSha256: 'cd'.repeat(32) },
    { ...published, entryPath: otherVersion.entry },
  ];
  for (const other of mismatches) {
    await assert.rejects(
      () => manager.acquireWithBinding('stable', other),
      /different exact launch/,
    );
  }
  assert.equal(await manager.acquireWithBinding('stable', published), first);

  const inFlight = { ...published, runtimeProfile: { identity: 'in-flight-a' } };
  const inFlightOther = { ...published, runtimeProfile: { identity: 'in-flight-b' } };
  let firstStarted!: () => void;
  const firstInFlight = new Promise<void>((resolve) => { firstStarted = resolve; });
  let allowFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { allowFirst = resolve; });
  const creating = manager.acquireWithBinding('racy-bind', inFlight, {
    acquireLease: async () => {
      firstStarted();
      await firstGate;
      return lease();
    },
  });
  await firstInFlight;
  await assert.rejects(
    () => manager.acquireWithBinding('racy-bind', inFlightOther),
    /different exact launch/,
  );
  allowFirst();
  await creating;
});

test('official adapter rejects a different cliPath or proxyVersion for one Session', async (t) => {
  const { root, entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const cliA = join(root, 'cli-a');
  const cliB = join(root, 'cli-b');
  await writeFile(cliA, '#!/bin/sh\necho saved-a\n');
  await writeFile(cliB, '#!/bin/sh\necho saved-b\n');
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const first = await manager.getOrCreate('official', 'claude', {
    cliPath: cliA,
    proxyVersion: '1.0.0',
  });
  await assert.rejects(
    () => manager.getOrCreate('official', 'claude', {
      cliPath: cliB,
      proxyVersion: '1.0.0',
    }),
    /different exact launch/,
  );
  await assert.rejects(
    () => manager.getOrCreate('official', 'claude', {
      cliPath: cliA,
      proxyVersion: '1.0.1',
    }),
    /different exact launch/,
  );
  assert.equal(
    await manager.getOrCreate('official', 'claude', {
      cliPath: cliA,
      proxyVersion: '1.0.0',
    }),
    first,
  );
});

test('one plugin can keep shared and session generations and dispose each exactly once', async (t) => {
  const sharedFx = await writeFixture(t, fixtureSource({ processScope: 'shared' }));
  const sessionFx = await writeFixture(t, fixtureSource({
    processScope: 'session',
    pluginVersion: '1.0.1',
  }));
  const manager = managerFor(sharedFx.dataDir, sharedFx.entry);
  t.after(() => manager.closeAll());
  let sharedReleases = 0;
  let sessionReleases = 0;
  const sharedLaunch = binding(sharedFx.entry, { processScope: 'shared' });
  const sessionLaunch = binding(sessionFx.entry, {
    processScope: 'session',
    pluginVersion: '1.0.1',
    manifestSha256: 'cd'.repeat(32),
  });

  const sharedFirst = await manager.acquireWithBinding('shared-s', sharedLaunch, {
    acquireLease: async () => lease(() => { sharedReleases += 1; }),
  }) as ProtocolV2SessionClient;
  const sessionFirst = await manager.acquireWithBinding('session-s', sessionLaunch, {
    acquireLease: async () => lease(() => { sessionReleases += 1; }),
  }) as ProtocolV2SessionClient;
  const sharedHost = hostOf(sharedFirst);
  const sessionHost = hostOf(sessionFirst);
  assert.notEqual(sharedHost, sessionHost);

  await manager.dispose('session-s');
  assert.equal(sessionHost.isExited(), true);
  assert.equal(sharedHost.isExited(), false);
  assert.equal(sessionReleases, 1);
  assert.equal(sharedReleases, 0);

  await manager.dispose('shared-s');
  assert.equal(sharedHost.isExited(), false);
  assert.equal(sharedReleases, 0);

  const sharedAgain = await manager.acquireWithBinding('shared-2', sharedLaunch) as ProtocolV2SessionClient;
  assert.equal(hostOf(sharedAgain), sharedHost);
  await manager.closeAll();
  assert.equal(sharedHost.isExited(), true);
  assert.equal(sharedReleases, 1);
  assert.equal(sessionReleases, 1);

  const managerB = managerFor(sharedFx.dataDir, sharedFx.entry);
  t.after(() => managerB.closeAll());
  let sharedReleasesB = 0;
  let sessionReleasesB = 0;
  const sessionB = await managerB.acquireWithBinding('session-s', sessionLaunch, {
    acquireLease: async () => lease(() => { sessionReleasesB += 1; }),
  }) as ProtocolV2SessionClient;
  const sharedB = await managerB.acquireWithBinding('shared-s', sharedLaunch, {
    acquireLease: async () => lease(() => { sharedReleasesB += 1; }),
  }) as ProtocolV2SessionClient;
  const sessionHostB = hostOf(sessionB);
  const sharedHostB = hostOf(sharedB);
  await managerB.dispose('shared-s');
  assert.equal(sharedHostB.isExited(), false);
  assert.equal(sessionHostB.isExited(), false);
  assert.equal(sharedReleasesB, 0);
  await managerB.dispose('session-s');
  assert.equal(sessionHostB.isExited(), true);
  assert.equal(sessionReleasesB, 1);
  await managerB.closeAll();
  assert.equal(sharedHostB.isExited(), true);
  assert.equal(sharedReleasesB, 1);
});

test('Host offers integrated 2.3/2.2 before legacy versions while official identity is hashed', async () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  assert.deepEqual([...KNOWN_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);

  const longCliA = `/opt/${'a'.repeat(2048)}/claude`;
  const longCliB = `/opt/${'b'.repeat(2048)}/claude`;
  assert.ok(JSON.stringify({ cliPath: longCliA, proxyVersion: '' }).length > 1024);

  const identityA = officialRuntimeIdentity({ cliPath: longCliA, proxyVersion: '' });
  const identityB = officialRuntimeIdentity({ cliPath: longCliB, proxyVersion: '' });
  assert.match(identityA, /^[0-9a-f]{64}$/);
  assert.match(identityB, /^[0-9a-f]{64}$/);
  assert.notEqual(identityA, identityB);

  const resolved = await resolveLegacyLaunch({
    executor: 'claude',
    launch: {
      pluginId: 'claude',
      pluginVersion: '1.0.0',
      manifestSha256: 'a'.repeat(64),
      protocolRange: '>=2.0 <2.2',
      entryPath: '/tmp/cc-proxy.mjs',
      processScope: 'session',
      schemaVersion: 3,
      runtime: { kind: 'external' },
      source: 'official-development',
    },
    cliPath: longCliA,
  });
  assert.deepEqual([...resolved.offeredProtocolVersions], ['2.1', '2.0']);
  assert.equal(resolved.binding.protocolVersion, '2.1');
  assert.match(resolved.binding.runtimeProfile?.identity ?? '', /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => validateLaunchBinding(resolved.binding));
});

test('generic acquire offers only the pinned protocol version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-supervisor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const offeredPath = join(root, 'offered.json');
  const entry = join(root, 'proxy.mjs');
  const dataDir = join(root, 'data');
  await writeFile(entry, fixtureSource({ processScope: 'shared', offeredPath }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  await assert.rejects(
    () => manager.acquireWithBinding(
      'pin',
      {
        ...binding(entry, { processScope: 'shared' }),
        offeredProtocolVersions: ['2.1', '2.0', '2.2'],
      } as ProxyLaunchBinding,
    ),
    /offeredProtocolVersions|exact protocol|cannot set/,
  );
  const client = await manager.acquireWithBinding('pin', binding(entry, { processScope: 'shared' }));
  assert.ok(client);
  const offered = JSON.parse(await readFile(offeredPath, 'utf8')) as string[];
  assert.deepEqual(offered, ['2.1']);

  const offered22Path = join(root, 'offered-22.json');
  const entry22 = join(root, 'proxy-22.mjs');
  await writeFile(entry22, fixtureSource({
    processScope: 'shared',
    protocolVersion: '2.2',
    offeredPath: offered22Path,
  }));
  const pinned22 = await manager.acquireWithBinding(
    'pin-22',
    binding(entry22, { processScope: 'shared', protocolVersion: '2.2' }),
  );
  assert.ok(pinned22);
  const offered22 = JSON.parse(await readFile(offered22Path, 'utf8')) as string[];
  assert.deepEqual(offered22, ['2.2']);
});

test('fork promotion keeps the session-scoped host alive for the child', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const launch = binding(entry, { processScope: 'session' });
  const parent = await manager.acquireWithBinding('parent', launch) as ProtocolV2SessionClient;
  await parent.createSession({ cwd: dataDir });
  const child = hostOf(parent).createSessionClient('child');
  manager.adoptExisting('child', child);
  await manager.dispose('parent');
  assert.equal(hostOf(parent).isExited(), false);
  await child.createSession({ cwd: dataDir });
  await manager.dispose('child');
});

test('close during create and stale exit stay race-safe', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  const launch = binding(entry, { processScope: 'session' });
  let acquires = 0;
  let releases = 0;
  let firstAcquireStarted!: () => void;
  const firstAcquiring = new Promise<void>((resolve) => { firstAcquireStarted = resolve; });
  let allowFirstAcquire!: () => void;
  const firstAcquireGate = new Promise<void>((resolve) => { allowFirstAcquire = resolve; });
  const creating = manager.acquireWithBinding('racy', launch, {
    acquireLease: async (): Promise<RuntimeLease> => {
      acquires += 1;
      if (acquires === 1) {
        firstAcquireStarted();
        await firstAcquireGate;
      }
      return {
        cli: 'claude',
        binaryPath: process.execPath,
        version: '1.0.0',
        source: 'managed',
        env: {},
        async release() {
          releases += 1;
        },
      };
    },
  });
  await firstAcquiring;
  const closing = manager.dispose('racy');
  allowFirstAcquire();
  const replacement = await creating;
  await closing;
  assert.ok(replacement instanceof ProtocolV2SessionClient);
  assert.equal(manager.get('racy'), replacement);
  assert.ok(acquires >= 2, 'dispose must consume the first exact create so acquire retries');
  assert.ok(releases >= 1, 'the consumed create must release its exact lease');

  const first = await manager.acquireWithBinding('stable', launch) as ProtocolV2SessionClient;
  await manager.forceDispose('stable');
  const second = await manager.acquireWithBinding('stable', launch) as ProtocolV2SessionClient;
  assert.notEqual(first, second);
  await first.forceKill();
  assert.equal(manager.get('stable'), second);
});

test('cleanup retry remains fail-closed on the generic path', async (t) => {
  const { entry, dataDir } = await writeFixture(t, fixtureSource({ processScope: 'session' }));
  const manager = managerFor(dataDir, entry);
  t.after(() => manager.closeAll());
  let releases = 0;
  const client = await manager.acquireWithBinding(
    'retry',
    binding(entry, { processScope: 'session' }),
    {
      acquireLease: async (): Promise<RuntimeLease> => ({
        cli: 'claude',
        binaryPath: process.execPath,
        version: '1.0.0',
        source: 'managed',
        env: {},
        async release() {
          releases += 1;
          if (releases === 1) throw new Error('first release failed');
        },
      }),
    },
  );
  assert.ok(client);
  await assert.rejects(
    () => manager.closeAll(),
    (error: unknown) => aggregateContains(error, /first release failed/),
  );
  await manager.closeAll();
  assert.equal(releases >= 2, true);
});

function aggregateContains(error: unknown, pattern: RegExp): boolean {
  if (pattern.test(String(error))) return true;
  return error instanceof AggregateError
    && error.errors.some((item) => aggregateContains(item, pattern));
}
