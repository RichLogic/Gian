import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { SUPPORTED_PROTOCOL_VERSIONS } from '@gian/proxy-protocol';
import { parseProxyPluginId } from '@gian/shared';

import { classifyRuntimeVersion } from '../src/runtime/classify-version.js';
import {
  hostRuntimeFingerprint,
  RuntimeFingerprintError,
  MAX_RUNTIME_FINGERPRINT_BYTES,
  MAX_RUNTIME_LAUNCHER_BYTES,
  MAX_RUNTIME_FINGERPRINT_DEPTH,
  MAX_RUNTIME_FINGERPRINT_FILES,
} from '../src/runtime/fingerprint.js';
import { RuntimeResolver, RuntimeResolverError, openRuntimeIdentity } from '../src/runtime/resolver.js';
import { isPublicHttpsSetupUrl } from '../src/runtime/setup-url.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const PLUGIN_ID = parseProxyPluginId('io.gian.fixture');

async function tempRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-resolver-'));
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  return root;
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

function runtimeFixtureSource(options: {
  pluginId?: string;
  version?: string;
  mode?: 'normal' | 'none' | 'hang' | 'mutate' | 'mismatch' | 'bad-version' | 'old-version' | 'relative' | 'session-side-effect' | 'malformed' | 'readiness' | 'wrong-id' | 'hung-tree';
  setupUrl?: string;
} = {}): string {
  const pluginId = options.pluginId ?? 'io.gian.fixture';
  const version = options.version ?? '1.0.0';
  const mode = options.mode ?? 'normal';
  const setupUrl = options.setupUrl ?? 'https://example.com/setup';
  return `#!/usr/bin/env node
const fs = await import('node:fs');
const id = ${JSON.stringify(pluginId)};
const version = ${JSON.stringify(version)};
const mode = ${JSON.stringify(mode)};
const setupUrl = ${JSON.stringify(setupUrl)};
if (process.argv.includes('--self-test')) {
  if (process.env.GIAN_RUNTIME_BIN) process.exit(2);
  process.stdout.write(JSON.stringify({ schemaVersion: 4, id, pluginVersion: version, ok: true }) + '\\n');
  process.exit(0);
}
if (process.env.GIAN_RUNTIME_BIN) {
  fs.writeFileSync(process.env.GIAN_FIXTURE_MARKER ?? '', 'runtime-bin\\n');
}
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-09-03T00:00:00.000Z';
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  const fail = (message) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, error: { code: -32602, message },
  }) + '\\n');
  if (req.method === 'initialize') {
    if (process.env.GIAN_FIXTURE_DATADIRS) {
      fs.appendFileSync(process.env.GIAN_FIXTURE_DATADIRS, (process.env.GIAN_PLUGIN_DATA_DIR ?? '') + '\\n');
    }
    if (mode === 'malformed') {
      reply({ protocol: { name: 'gian.proxy', version: '2.2' } });
      return;
    }
    const offered = req.params.protocol.versions;
    if (!offered.includes('2.2')) return fail('2.2 required');
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id, name: 'Gian Fixture', version },
      process: { scope: 'session' },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'catalog.list') {
    reply({
      catalogRevision: 'rev-1',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
      specialCatalogs: {},
    });
    return;
  }
  if (req.method === 'runtime.discover') {
    if (mode === 'hung-tree') {
      const { spawn } = await import('node:child_process');
      spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); // gian-hung-tree'], {
        stdio: 'ignore',
      });
      return;
    }
    if (mode === 'hang') return;
    const candidate = mode === 'relative' ? 'relative/bin' : process.env.GIAN_FIXTURE_CANDIDATE;
    reply({
      candidates: candidate ? [{ path: candidate, source: 'path', label: 'Fixture CLI' }] : [],
      setupActions: [{ id: 'docs', kind: 'open_url', label: 'Setup', url: setupUrl }],
    });
    return;
  }
  if (req.method === 'runtime.probe') {
    if (mode === 'hang') return;
    const requested = req.params.path;
    if (mode === 'mutate' && requested) {
      fs.appendFileSync(requested, '\\n# mutated\\n');
    }
    if (mode === 'mismatch') {
      reply({
        runtimeId: 'fixture',
        displayName: 'Fixture CLI',
        path: requested + '-other',
        version: '1.2.3',
        configHome: null,
        contentRoots: [{ path: requested, mode: 'file' }],
      });
      return;
    }
    if (mode === 'bad-version') {
      reply({
        runtimeId: 'fixture',
        displayName: 'Fixture CLI',
        path: requested,
        version: 'not-a-version',
        configHome: null,
        contentRoots: [{ path: requested, mode: 'file' }],
      });
      return;
    }
    if (mode === 'readiness') {
      reply({
        runtimeId: 'fixture',
        displayName: 'Fixture CLI',
        path: requested,
        version: '1.2.3',
        configHome: null,
        contentRoots: [{ path: requested, mode: 'file' }],
        readinessIssue: {
          code: 'fixture_not_ready',
          message: 'Fixture runtime needs setup.',
          repairable: true,
        },
      });
      return;
    }
    if (mode === 'wrong-id') {
      reply({
        runtimeId: 'renamed',
        displayName: 'Fixture CLI',
        path: requested,
        version: '1.2.3',
        configHome: null,
        contentRoots: [{ path: requested, mode: 'file' }],
      });
      return;
    }
    if (mode === 'old-version') {
      reply({
        runtimeId: 'fixture',
        displayName: 'Fixture CLI',
        path: requested,
        version: '0.1.0',
        configHome: null,
        contentRoots: [{ path: requested, mode: 'file' }],
      });
      return;
    }
    reply({
      runtimeId: 'fixture',
      displayName: 'Fixture CLI',
      path: requested,
      version: '1.2.3',
      configHome: null,
      contentRoots: [{ path: requested, mode: 'file' }],
    });
    return;
  }
  if (req.method === 'session.create') {
    if (mode === 'session-side-effect' || process.env.GIAN_FIXTURE_MARKER) {
      fs.writeFileSync(process.env.GIAN_FIXTURE_MARKER, 'session-create\\n');
    }
    reply({
      session: {
        id: req.params.sessionId,
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        state: 'idle',
        sessionConfig: req.params.config ?? {},
        createdAt: emittedAt,
        updatedAt: emittedAt,
      },
    });
    return;
  }
  if (req.method === 'turn.start') {
    reply({ accepted: true, turnId: req.params.turnId });
    const base = {
      streamId: req.params.streamId,
      sessionId: req.params.sessionId,
      turnId: req.params.turnId,
      sourceTurnId: req.params.turnId,
      emittedAt,
    };
    for (const [method, eventId, sequence, data] of [
      ['turn.started', 'event-1', 1, {}],
      ['content.delta', 'event-2', 2, { contentId: 'c1', kind: 'text', delta: 'hello' }],
      ['content.completed', 'event-3', 3, { contentId: 'c1', kind: 'text', content: 'hello' }],
      ['turn.completed', 'event-4', 4, { stopReason: 'completed' }],
    ]) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method, params: { ...base, eventId, sequence, data },
      }) + '\\n');
    }
    return;
  }
  if (req.method === 'session.close' || req.method === 'shutdown') {
    reply({ ok: true });
    if (req.method === 'shutdown') process.exit(0);
  }
});
`;
}

async function writeFixture(
  t: { after: (fn: () => Promise<void>) => void },
  source: string,
): Promise<{ root: string; entry: string }> {
  const root = await tempRoot(t);
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, source, { mode: 0o755 });
  return { root, entry };
}

function resolverFor(root: string): RuntimeResolver {
  return new RuntimeResolver({
    dataDir: join(root, 'resolver-data'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
  });
}

function externalInput(entryPath: string, selectedPath: string | null, agentId = 'agent-1') {
  return {
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    agentId,
    entryPath,
    processScope: 'session' as const,
    runtime: {
      kind: 'external' as const,
      id: 'fixture',
      displayName: 'Fixture CLI',
      verifiedVersions: ['1.2.3'],
    },
    selectedPath,
  };
}

test('session offer includes 2.3/2.2 while bootstrap remains pinned to 2.2', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
});

test('setup URLs reject loopback, private, file, and credential forms', () => {
  assert.equal(isPublicHttpsSetupUrl('https://example.com/setup'), true);
  assert.equal(isPublicHttpsSetupUrl('https://docs.example.com/install'), true);
  assert.equal(isPublicHttpsSetupUrl('https://127.0.0.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://192.168.1.8/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://10.1.2.3/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://172.16.0.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://169.254.1.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://100.64.0.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://198.18.0.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://224.0.0.1/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[::1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[::]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[fe80::1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[fc00::1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[::ffff:127.0.0.1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[::ffff:10.0.0.1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[2001:db8::1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://[2001:2::1]/install'), false);
  assert.equal(isPublicHttpsSetupUrl('https://user:pass@example.com/x'), false);
  assert.equal(isPublicHttpsSetupUrl('https://example.com:8443/x'), false);
  assert.equal(isPublicHttpsSetupUrl('file:///tmp/x'), false);
  assert.equal(isPublicHttpsSetupUrl('http://example.com/x'), false);
});

test('Host fingerprint rejects escape, symlink children, and depth overflow', async (t) => {
  const root = await tempRoot(t);
  const selected = join(root, 'bin', 'tool');
  await writeExecutable(selected, '#!/bin/sh\necho 1.0.0\n');
  const escaped = join(root, 'outside.txt');
  await writeFile(escaped, 'secret\n');
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: null,
      contentRoots: [{ path: escaped, mode: 'file' }],
    }),
    /not anchored/,
  );

  const linked = join(root, 'bin', 'link');
  await symlink(selected, linked);
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: join(root, 'bin'),
      contentRoots: [{ path: linked, mode: 'file' }],
      homeDir: root,
    }),
    /symlink/,
  );

  let deep = join(root, 'bin', 'tree');
  for (let i = 0; i <= MAX_RUNTIME_FINGERPRINT_DEPTH + 1; i += 1) {
    deep = join(deep, `d${i}`);
    await mkdir(deep, { recursive: true });
  }
  await writeFile(join(deep, 'leaf'), 'x');
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: join(root, 'bin'),
      contentRoots: [{ path: join(root, 'bin', 'tree'), mode: 'directory' }],
      homeDir: root,
    }),
    /depth budget/,
  );

  const crowded = join(root, 'bin', 'crowded');
  await mkdir(crowded, { recursive: true });
  for (let i = 0; i <= MAX_RUNTIME_FINGERPRINT_FILES; i += 1) {
    await writeFile(join(crowded, `f${i}`), 'x');
  }
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: join(root, 'bin'),
      contentRoots: [{ path: crowded, mode: 'directory' }],
      homeDir: root,
    }),
    /file budget/,
  );

  const huge = join(root, 'bin', 'huge.bin');
  const handle = await (await import('node:fs/promises')).open(huge, 'w');
  await handle.truncate(MAX_RUNTIME_FINGERPRINT_BYTES + 1);
  await handle.close();
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: null,
      contentRoots: [{ path: huge, mode: 'file' }],
    }),
    /byte budget/,
  );
});

test('runtime:none produces a null-fact profile and no lease', async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource({ mode: 'none' }));
  const resolver = resolverFor(root);
  const resolved = await resolver.resolve({
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    agentId: 'agent-none',
    entryPath: entry,
    processScope: 'session',
    runtime: { kind: 'none' },
    selectedPath: null,
  });
  assert.equal(resolved.lease, null);
  assert.equal(resolved.profile.path, null);
  assert.equal(resolved.profile.version, null);
  assert.equal(resolved.profile.configHome, null);
  assert.equal(resolved.profile.contentFingerprint, null);
  assert.equal(resolved.profile.runtimeId, null);
  assert.equal(resolved.profile.verification, 'verified');
  assert.equal(resolved.profile.id, openRuntimeIdentity(PLUGIN_ID, null, null));
});

test('unknown fixture discover/select/probe/fingerprint/lease and generic create/turn/close', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource());
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  const marker = join(root, 'marker.txt');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  process.env.GIAN_FIXTURE_MARKER = marker;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
    delete process.env.GIAN_FIXTURE_MARKER;
  });

  const resolver = resolverFor(root);
  const discovered = await resolver.discover(externalInput(entry, null));
  assert.equal(discovered.candidates.length, 1);
  assert.equal(discovered.candidates[0]?.path, cli);
  assert.equal(discovered.setupActions[0]?.kind, 'open_url');

  const first = await resolver.resolve(externalInput(entry, cli, 'agent-a'));
  assert.ok(first.lease);
  assert.equal(first.profile.path, cli);
  assert.equal(first.profile.version, '1.2.3');
  assert.equal(first.profile.verification, 'verified');
  assert.ok(first.profile.contentFingerprint);
  assert.equal(first.profile.id, openRuntimeIdentity(PLUGIN_ID, cli, first.profile.contentFingerprint));
  assert.equal(first.lease.cli, undefined);

  const second = await resolver.resolve(externalInput(entry, cli, 'agent-b'));
  assert.equal(second.profile.id, first.profile.id);
  assert.equal(second.profile.contentFingerprint, first.profile.contentFingerprint);

  const manager = new ProxyManager({
    dataDir: join(root, 'proxy-data'),
  });
  t.after(() => manager.closeAll());
  const client = await manager.acquireWithBinding('fixture-session', {
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    manifestSha256: 'a'.repeat(64),
    entryPath: entry,
    processScope: 'session',
    protocolVersion: '2.2',
    runtimeProfile: { identity: first.profile.id },
  }, {
    acquireLease: async () => first.lease,
  });
  assert.ok(client instanceof ProtocolV2SessionClient);
  const created = await client.createSession({ cwd: root });
  assert.equal(created.nativeSessionId, 'native-1');
  await client.startTurn({
    sessionId: 'fixture-session',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  });
  await client.closeSession();
  await manager.dispose('fixture-session');
  await first.lease.release();
  await second.lease?.release();
});

test('relative, mismatched, and mutated runtimes fail closed', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource());
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
  });
  const resolver = resolverFor(root);
  await assert.rejects(
    () => resolver.resolve(externalInput(entry, 'relative/bin')),
    (error: unknown) => error instanceof RuntimeResolverError && error.code === 'RUNTIME_PATH_INVALID',
  );

  const mismatch = await writeFixture(t, runtimeFixtureSource({ mode: 'mismatch' }));
  await assert.rejects(
    () => resolverFor(mismatch.root).resolve(externalInput(mismatch.entry, cli)),
    /exactly match/,
  );

  const mutating = await writeFixture(t, runtimeFixtureSource({ mode: 'mutate' }));
  const mutatingCli = join(mutating.root, 'bin', 'fixture-cli');
  await writeExecutable(mutatingCli, '#!/bin/sh\necho fixture 1.2.3\n');
  process.env.GIAN_FIXTURE_CANDIDATE = mutatingCli;
  await assert.rejects(
    () => resolverFor(mutating.root).resolve(externalInput(mutating.entry, mutatingCli)),
    /changed while/,
  );
});

test('bad versions and private setup URLs fail closed', { timeout: 20_000 }, async (t) => {
  const badVersion = await writeFixture(t, runtimeFixtureSource({ mode: 'bad-version' }));
  const cli = join(badVersion.root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
  });
  await assert.rejects(
    () => resolverFor(badVersion.root).resolve(externalInput(badVersion.entry, cli)),
    /semantic version|Invalid|invalid/i,
  );

  const badUrl = await writeFixture(t, runtimeFixtureSource({ setupUrl: 'https://127.0.0.1/install' }));
  await assert.rejects(
    () => resolverFor(badUrl.root).discover(externalInput(badUrl.entry, null)),
    /public HTTPS/,
  );

  const old = await writeFixture(t, runtimeFixtureSource({ mode: 'old-version' }));
  const oldCli = join(old.root, 'bin', 'fixture-cli');
  await writeExecutable(oldCli, '#!/bin/sh\necho fixture 0.1.0\n');
  const oldResolved = await resolverFor(old.root).resolve(externalInput(old.entry, oldCli));
  assert.equal(oldResolved.profile.verification, 'incompatible');
  await oldResolved.lease?.release();

  const relative = await writeFixture(t, runtimeFixtureSource({ mode: 'relative' }));
  await assert.rejects(
    () => resolverFor(relative.root).resolve(externalInput(relative.entry, null)),
    /absolute|Invalid|RUNTIME_PATH_INVALID|not a valid/i,
  );

  const malformed = await writeFixture(t, runtimeFixtureSource({ mode: 'malformed' }));
  await assert.rejects(
    () => resolverFor(malformed.root).discover(externalInput(malformed.entry, null)),
    /Invalid initialize|PROTOCOL|bootstrap/i,
  );
});

test('bootstrap without GIAN_RUNTIME_BIN does not create a session', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource({ mode: 'session-side-effect' }));
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  const marker = join(root, 'side-effect.txt');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  process.env.GIAN_FIXTURE_MARKER = marker;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
    delete process.env.GIAN_FIXTURE_MARKER;
  });
  const resolved = await resolverFor(root).resolve(externalInput(entry, cli));
  assert.ok(resolved.lease);
  await resolved.lease.release();
  await assert.rejects(() => lstat(marker), { code: 'ENOENT' });
});

test('hung bootstrap times out and does not leave a lease', { timeout: 8_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource({ mode: 'hang' }));
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
  });
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver-data'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    bootstrapTimeoutMs: 1_200,
  });
  await assert.rejects(
    () => resolver.resolve(externalInput(entry, cli)),
    /timeout|BOOTSTRAP/i,
  );
});

test('different fingerprints never share a lease identity', { timeout: 20_000 }, async (t) => {
  const first = await writeFixture(t, runtimeFixtureSource());
  const second = await writeFixture(t, runtimeFixtureSource());
  const cliA = join(first.root, 'bin', 'a');
  const cliB = join(second.root, 'bin', 'b');
  await writeExecutable(cliA, '#!/bin/sh\necho A 1.2.3\n');
  await writeExecutable(cliB, '#!/bin/sh\necho B 1.2.3 extra\n');
  const resolver = resolverFor(first.root);
  process.env.GIAN_FIXTURE_CANDIDATE = cliA;
  const resolvedA = await resolver.resolve(externalInput(first.entry, cliA));
  process.env.GIAN_FIXTURE_CANDIDATE = cliB;
  const resolvedB = await resolver.resolve(externalInput(second.entry, cliB));
  delete process.env.GIAN_FIXTURE_CANDIDATE;
  assert.notEqual(resolvedA.profile.id, resolvedB.profile.id);
  assert.notEqual(resolvedA.profile.contentFingerprint, resolvedB.profile.contentFingerprint);
  await resolvedA.lease?.release();
  await resolvedB.lease?.release();
});

test('failed claim release blocks reuse until retry succeeds', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource());
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  process.env.GIAN_FIXTURE_CANDIDATE = cli;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_CANDIDATE;
  });
  let releases = 0;
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver-data'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    acquireLock: async () => {
      const lease = await import('../src/agents/update-lock.js')
        .then((module) => module.acquireAgentRuntimeUseLock(
          join(root, 'locks'),
          'fixture-lock',
          'test',
        ));
      const original = lease.release.bind(lease);
      lease.release = async () => {
        releases += 1;
        if (releases <= 2) throw new Error('simulated release failure');
        return original();
      };
      return lease;
    },
  });
  const resolved = await resolver.resolve(externalInput(entry, cli));
  assert.ok(resolved.lease);
  await assert.rejects(() => resolved.lease.release(), /simulated release failure/);
  await assert.rejects(
    () => resolver.resolve(externalInput(entry, cli, 'agent-retry')),
    /simulated release failure/,
  );
  const retried = await resolver.resolve(externalInput(entry, cli, 'agent-retry'));
  assert.ok(retried.lease);
  await retried.lease.release();
});

test('official Proxies project discover/probe facts through the same Host fingerprint', { timeout: 30_000 }, async (t) => {
  const root = await tempRoot(t);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  // KIMI_CODE_HOME outranks HOME in the Kimi discoverer; an inherited real
  // value (e.g. a developer shell inside Kimi Code) would bypass the fake
  // fixture and probe the machine's actual CLI.
  const previousKimiCodeHome = process.env.KIMI_CODE_HOME;
  process.env.HOME = root;
  process.env.CODEX_HOME = join(root, '.codex');
  process.env.KIMI_CODE_HOME = join(root, '.kimi-code');
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiCodeHome;
  });

  const { discoverClaudeRuntimes, probeClaudeRuntime } = await import('../../proxies/cc-proxy/src/runtime/discover.ts');
  const { discoverCodexRuntimes, probeCodexRuntime } = await import('../../proxies/codex-proxy/src/runtime/discover.ts');
  const { discoverKimiRuntimes, probeKimiRuntime } = await import('../../proxies/kimi-proxy/src/runtime/discover.ts');
  const { discoverGrokRuntimes, probeGrokRuntime } = await import('../../proxies/grok-proxy/src/runtime/discover.ts');
  const { discoverDshRuntimes, probeDshRuntime } = await import('../../proxies/dsh-proxy/src/runtime/discover.ts');
  const { discoverZcodeRuntimes, probeZcodeRuntime } = await import('../../proxies/zcode-proxy/src/runtime/discover.ts');

  const bins = join(root, '.local', 'bin');
  await Promise.all([
    mkdir(bins, { recursive: true }),
    mkdir(process.env.CODEX_HOME, { recursive: true }),
  ]);
  process.env.PATH = bins;
  for (const [name, version] of [
    ['claude', '2.1.159'],
    ['codex', '0.146.0'],
    ['kimi', '0.38.0'],
    ['grok', '1.0.4'],
    ['dsh', '0.1.1-rc.2'],
  ] as const) {
    await writeExecutable(join(bins, name), `#!/bin/sh\necho ${name} ${version}\n`);
  }
  const zcode = join(root, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await writeExecutable(zcode, '#!/bin/sh\necho zcode 0.16.5\n');
  await mkdir(join(root, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(root, '.zcode', 'cli', 'config.json'), '{"ok":true}\n');

  const official = [
    { name: 'claude', discover: discoverClaudeRuntimes, probe: probeClaudeRuntime, verified: '2.1.159', source: 'official-user' },
    { name: 'codex', discover: discoverCodexRuntimes, probe: probeCodexRuntime, verified: '0.146.0', source: 'official-user' },
    { name: 'kimi', discover: discoverKimiRuntimes, probe: probeKimiRuntime, verified: '0.38.0', source: 'official-user' },
    { name: 'grok', discover: discoverGrokRuntimes, probe: probeGrokRuntime, verified: '1.0.4', source: 'official-user' },
    { name: 'dsh', discover: discoverDshRuntimes, probe: probeDshRuntime, verified: '0.1.1-rc.2', source: 'official-user' },
    { name: 'zcode', discover: discoverZcodeRuntimes, probe: probeZcodeRuntime, verified: '0.16.5', source: 'official-user' },
  ];
  for (const item of official) {
    const discovered = await item.discover();
    assert.ok(discovered.candidates.length > 0, `${item.name} discovered no candidates`);
    assert.ok(discovered.setupActions.some((action) => action.kind === 'open_url'));
    assert.ok(discovered.setupActions.some((action) => action.kind === 'select_file'));
    const selected = discovered.candidates[0]!;
    assert.ok(selected.source === 'official-user' || selected.source === 'path' || selected.source === 'official-system');
    const probed = await item.probe(selected.path);
    assert.equal(probed.path, selected.path);
    assert.equal(probed.version, item.verified);
    assert.ok(probed.configHome);
    assert.ok(probed.contentRoots.length >= 1);
    const fingerprint = await hostRuntimeFingerprint({
      selectedPath: probed.path,
      configHome: probed.configHome,
      contentRoots: probed.contentRoots,
    });
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      probed.version === item.verified ? 'verified' : 'unverified',
      'verified',
    );
  }
});

test('SemVer classification uses exact match, prerelease order, and unverified newer lines', () => {
  assert.equal(classifyRuntimeVersion('1.0.0', ['1.0.0']), 'verified');
  assert.equal(classifyRuntimeVersion('1.0.0-rc.1', ['1.0.0']), 'incompatible');
  assert.equal(classifyRuntimeVersion('1.0.1', ['1.0.0']), 'unverified');
  assert.equal(classifyRuntimeVersion('not-a-version', ['1.0.0']), 'incompatible');
  assert.equal(classifyRuntimeVersion('1.0.0', []), 'unverified');
  assert.equal(classifyRuntimeVersion(null, ['1.0.0']), 'verified');
});

test('fingerprint uses one global budget and rejects unauthorized configHome', async (t) => {
  const root = await tempRoot(t);
  const selected = join(root, 'bin', 'tool');
  await writeExecutable(selected, '#!/bin/sh\necho 1.0.0\n');
  const first = join(root, 'bin', 'a');
  const second = join(root, 'bin', 'b');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const half = Math.floor(MAX_RUNTIME_FINGERPRINT_FILES / 2) + 1;
  for (let i = 0; i < half; i += 1) {
    await writeFile(join(first, `f${i}`), 'x');
    await writeFile(join(second, `g${i}`), 'x');
  }
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: join(root, 'bin'),
      contentRoots: [
        { path: first, mode: 'directory' },
        { path: second, mode: 'directory' },
      ],
      homeDir: root,
    }),
    /file budget/,
  );

  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: '/etc',
      contentRoots: [{ path: selected, mode: 'file' }],
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError && error.code === 'RUNTIME_CONFIG_HOME_INVALID',
  );
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: '/',
      contentRoots: [{ path: selected, mode: 'file' }],
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError && error.code === 'RUNTIME_CONFIG_HOME_INVALID',
  );

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  await mkdir(join(root, 'Documents'), { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
  await assert.rejects(
    () => hostRuntimeFingerprint({
      selectedPath: selected,
      configHome: join(root, 'Documents'),
      contentRoots: [{ path: selected, mode: 'file' }],
    }),
    (error: unknown) => error instanceof RuntimeFingerprintError && error.code === 'RUNTIME_CONFIG_HOME_INVALID',
  );
  const digest = await hostRuntimeFingerprint({
    selectedPath: selected,
    configHome: join(root, '.claude'),
    contentRoots: [{ path: selected, mode: 'file' }],
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('readinessIssue and Manifest identity mismatch produce no lease', { timeout: 20_000 }, async (t) => {
  const ready = await writeFixture(t, runtimeFixtureSource({ mode: 'readiness' }));
  const cli = join(ready.root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  const resolved = await resolverFor(ready.root).resolve(externalInput(ready.entry, cli));
  assert.equal(resolved.lease, null);
  assert.equal(resolved.readinessIssue?.code, 'fixture_not_ready');
  assert.equal(resolved.readinessIssue?.repairable, true);

  const renamed = await writeFixture(t, runtimeFixtureSource({ mode: 'wrong-id' }));
  const renamedCli = join(renamed.root, 'bin', 'fixture-cli');
  await writeExecutable(renamedCli, '#!/bin/sh\necho fixture 1.2.3\n');
  await assert.rejects(
    () => resolverFor(renamed.root).resolve(externalInput(renamed.entry, renamedCli)),
    (error: unknown) => error instanceof RuntimeResolverError && error.code === 'RUNTIME_ID_MISMATCH',
  );
});

test('mutation between resolve and reserveProcessGroup invalidates the generation', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource());
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  const resolved = await resolverFor(root).resolve(externalInput(entry, cli));
  assert.ok(resolved.lease?.reserveProcessGroup);
  await appendFile(cli, '# mutated-after-resolve\n');
  await assert.rejects(
    () => resolved.lease!.reserveProcessGroup!(),
    (error: unknown) => error instanceof RuntimeResolverError && error.code === 'RUNTIME_MUTATED',
  );
  await resolved.lease?.release().catch(() => undefined);
});

test('bootstrap timeout waits until the Proxy process tree is empty', { timeout: 12_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource({ mode: 'hung-tree' }));
  const cli = join(root, 'bin', 'fixture-cli');
  await writeExecutable(cli, '#!/bin/sh\necho fixture 1.2.3\n');
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver-data'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    bootstrapTimeoutMs: 1_200,
  });
  await assert.rejects(
    () => resolver.discover(externalInput(entry, null)),
    /timeout|BOOTSTRAP|cleanup/i,
  );
  const leftover = spawn('ps', ['-axo', 'command='], { encoding: 'utf8' });
  const listing = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    leftover.stdout.on('data', (chunk) => { stdout += String(chunk); });
    leftover.on('error', reject);
    leftover.on('close', () => resolve(stdout));
  });
  assert.equal(listing.includes('gian-hung-tree'), false);
});

test('concurrent bootstrap attempts use unique data directories', { timeout: 20_000 }, async (t) => {
  const { root, entry } = await writeFixture(t, runtimeFixtureSource());
  const first = join(root, 'bin', 'fixture-a');
  const second = join(root, 'bin', 'fixture-b');
  await writeExecutable(first, '#!/bin/sh\necho fixture 1.2.3\n');
  await writeExecutable(second, '#!/bin/sh\necho fixture 1.2.3\n');
  const dataDirs = join(root, 'datadirs.log');
  process.env.GIAN_FIXTURE_DATADIRS = dataDirs;
  t.after(() => {
    delete process.env.GIAN_FIXTURE_DATADIRS;
  });
  const resolver = resolverFor(root);
  const [left, right] = await Promise.all([
    resolver.resolve(externalInput(entry, first, 'agent-a')),
    resolver.resolve(externalInput(entry, second, 'agent-b')),
  ]);
  await left.lease?.release();
  await right.lease?.release();
  const recorded = new Set(
    (await readFile(dataDirs, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean),
  );
  assert.ok(recorded.size >= 2, `expected unique data dirs, got ${[...recorded].join(',')}`);
});

test('generic RuntimeResolver source has no Provider or plugin literal branches', async () => {
  const files = [
    join(repoRoot, 'packages/host/src/runtime/resolver.ts'),
    join(repoRoot, 'packages/host/src/runtime/bootstrap.ts'),
    join(repoRoot, 'packages/host/src/runtime/fingerprint.ts'),
    join(repoRoot, 'packages/host/src/runtime/setup-url.ts'),
    join(repoRoot, 'packages/host/src/runtime/classify-version.ts'),
    join(repoRoot, 'packages/host/src/runtime/config-home.ts'),
    join(repoRoot, 'packages/host/src/runtime/launch-mode.ts'),
  ];
  const forbidden = [
    /\bproductExecutorForPluginId\b/,
    /\bas Executor\b/,
    /pluginId\s+as\s+Executor/,
    /executor\s*===\s*['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
    /case ['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
    /pluginId\s*===\s*['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} matched ${pattern}`);
    }
  }
});


test('standalone CLI budget accepts files above the directory budget and hashes the entire symlink target', async t => {
  const root = await tempRoot(t);
  const binary = join(root, 'standalone-cli');
  const handle = await (await import('node:fs/promises')).open(binary, 'w+');
  await handle.truncate(MAX_RUNTIME_FINGERPRINT_BYTES + 4096);
  const launcher = join(root, 'cli');
  await symlink(binary, launcher);
  try {
    const fingerprint = () => hostRuntimeFingerprint({ selectedPath: launcher, configHome: null, contentRoots: [{ path: launcher, mode: 'file' }] });
    const before = await fingerprint();
    // Changing bytes after the old 64 MiB boundary must change the identity.
    await handle.write(Buffer.from('changed'), 0, 7, MAX_RUNTIME_FINGERPRINT_BYTES + 1);
    assert.notEqual(await fingerprint(), before);
    assert.match(await hostRuntimeFingerprint({ selectedPath: binary, configHome: null, contentRoots: [{ path: binary, mode: 'file' }] }), /^[a-f0-9]{64}$/);
    await handle.truncate(MAX_RUNTIME_LAUNCHER_BYTES + 1);
    await assert.rejects(fingerprint, /byte budget/);
  } finally {
    await handle.close();
  }
});
