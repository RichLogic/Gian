import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { ManagedRuntimeInstallPlan } from '@gian/shared';

import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { ManagedRuntimeInstallError, ManagedRuntimeInstaller } from '../src/runtime/installer.js';
import { extractManagedRuntimeArchive } from '../src/runtime/safe-extract.js';
import { fixtureInstallPlan } from './runtime-install-fixtures.js';
import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function gzipUstar(files: ReadonlyMap<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    Buffer.from(name).copy(header, 0);
    header.write('0000755\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(`${bytes.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header[156] = 0x30;
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    header.fill(' ', 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    parts.push(header, bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (Buffer.byteLength(`${length} ${body}`) !== length) {
    length = Buffer.byteLength(`${length} ${body}`);
  }
  return Buffer.from(`${length} ${body}`);
}

function gzipPaxUstar(path: string, bytes: Buffer): Buffer {
  const members: Buffer[] = [];
  const append = (name: string, data: Buffer, type: number) => {
    const header = Buffer.alloc(512);
    Buffer.from(name).copy(header, 0);
    header.write('0000755\0', 100, 'utf8');
    header.write(`${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    header[156] = type;
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    header.fill(' ', 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    members.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) members.push(Buffer.alloc(padding));
  };
  append('PaxHeader', paxRecord('path', path), 0x78);
  append('truncated-name', bytes, 0x30);
  members.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(members));
}

function plan(root: string, bytes: Buffer): ManagedRuntimeInstallPlan {
  return {
    generationId: 'claude-generation-1',
    pluginId: 'claude',
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.2.4',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: join(root, 'plugins', 'claude', '0.2.4', 'proxy.mjs'),
      processScope: 'session',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      kind: 'native-binary',
      runtimeId: 'claude',
      version: '2.1.159',
      asset: {
        url: 'https://releases.example.test/claude-2.1.159',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
      format: 'raw',
      entryRelativePath: 'bin/claude',
    },
    companions: [],
    certificate: { id: 'certificate-1', sha256: 'd'.repeat(64) },
  };
}

test('native binary install verifies bytes and stages an immutable generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('#!/bin/sh\necho 2.1.159\n');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const installer = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir: root,
    store,
    download: async asset => {
      assert.equal(asset.url, input.runtime?.kind === 'native-binary' ? input.runtime.asset.url : '');
      return bytes;
    },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  const installed = await installer.install(input);
  assert.equal(installed.state, 'staged');
  assert.equal(installed.runtime?.ownership, 'managed');
  assert.equal(installed.runtime?.entryPath, join(root, 'runtimes', 'claude', '2.1.159', createHash('sha256').update(bytes).digest('hex'), 'bin', 'claude'));
  assert.deepEqual(await readFile(installed.runtime!.entryPath), bytes);
  assert.equal((await store.list('claude'))[0]?.generationId, input.generationId);

  const repeated = await installer.install(input);
  assert.equal(repeated.generationId, input.generationId);
});

test('managed Runtime tar.gz installs the complete tree and probes its declared entry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-installer-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = Buffer.from('#!/bin/sh\necho 2.1.159\n');
  const support = Buffer.from('runtime dependency');
  const archive = gzipUstar(new Map([
    ['bin/claude', entry],
    ['lib/support.txt', support],
  ]));
  const input = plan(root, archive);
  if (input.runtime?.kind !== 'native-binary') throw new Error('invalid fixture');
  input.runtime.format = 'tar.gz';
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  let probed: string | null = null;
  const installer = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir: root,
    store,
    download: async () => archive,
    probeVersion: async ({ executable: candidate, expectedVersion }) => {
      probed = candidate;
      return expectedVersion;
    },
  });

  const installed = await installer.install(input);
  const versionRoot = join(root, 'runtimes', 'claude', '2.1.159', createHash('sha256').update(archive).digest('hex'));
  assert.equal(installed.runtime?.entryPath, join(versionRoot, 'bin', 'claude'));
  assert.equal(probed, join(root, 'runtimes', expectStagingSegment(probed), 'bin', 'claude'));
  assert.deepEqual(await readFile(join(versionRoot, 'bin', 'claude')), entry);
  assert.deepEqual(await readFile(join(versionRoot, 'lib', 'support.txt')), support);
});

function expectStagingSegment(path: string | null): string {
  const match = /\/runtimes\/(\.staging-[^/]+)\/bin\/claude$/u.exec(path ?? '');
  assert.ok(match?.[1], 'Runtime entry must be probed from the staging generation');
  return match[1];
}

test('Runtime extractor applies only canonical local PAX paths and rejects traversal overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-pax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const longPath = `lib/${'nested-'.repeat(20)}runtime.js`;
  const bytes = Buffer.from('export default true;\n');
  await extractManagedRuntimeArchive(gzipPaxUstar(longPath, bytes), root);
  assert.deepEqual(await readFile(join(root, longPath)), bytes);
  await assert.rejects(
    extractManagedRuntimeArchive(gzipPaxUstar('../../escape', bytes), join(root, 'bad')),
    (error: unknown) => error instanceof ManagedRuntimeInstallError
      && error.code === 'RUNTIME_ARCHIVE_ENTRY',
  );
});

test('digest and version mismatches never publish a generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-installer-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('#!/bin/sh\necho 2.1.159\n');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const badDigest = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir: root,
    store,
    download: async () => Buffer.from('different bytes'),
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  await assert.rejects(
    badDigest.install(input),
    (error: unknown) => error instanceof ManagedRuntimeInstallError
      && (error.code === 'RUNTIME_SIZE_MISMATCH' || error.code === 'RUNTIME_DIGEST_MISMATCH'),
  );
  assert.deepEqual(await store.list('claude'), []);

  const wrongVersion = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir: root,
    store,
    download: async () => bytes,
    probeVersion: async () => '9.9.9',
  });
  await assert.rejects(
    wrongVersion.install(input),
    (error: unknown) => error instanceof ManagedRuntimeInstallError
      && error.code === 'RUNTIME_VERSION_MISMATCH',
  );
  assert.deepEqual(await store.list('claude'), []);
});

test('install plans reject untrusted URLs and executable paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-installer-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('runtime');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const installer = new ManagedRuntimeInstaller({
    planInstallation: fixtureInstallPlan,
    dataDir: root,
    store,
    download: async () => { throw new Error('must not download'); },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  if (input.runtime?.kind !== 'native-binary') throw new Error('invalid fixture');
  input.runtime.asset.url = 'file:///tmp/claude';
  await assert.rejects(
    installer.install(input),
    (error: unknown) => error instanceof ManagedRuntimeInstallError
      && error.code === 'RUNTIME_PLAN_INVALID',
  );
});

test('new Proxy generation reuses a fully verified Runtime without another download', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('certified runtime');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  let downloads = 0;
  const installer = new ManagedRuntimeInstaller({
    dataDir: root, store, planInstallation: fixtureInstallPlan,
    download: async () => { downloads++; return bytes; },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  const first = await installer.install(input);
  const second = await installer.install({
    ...input, generationId: 'claude-generation-2', proxy: { ...input.proxy, pluginVersion: '0.3.0' },
  });
  assert.equal(downloads, 1);
  assert.equal(first.runtime?.entryPath, second.runtime?.entryPath);
  await writeFile(second.runtime!.entryPath, 'tampered');
  await assert.rejects(installer.install(input), /different|already exists|conflict/i);
});

test('DSH legacy launcher is preserved and certified legacy dependency tree is reused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
  const archive = gzipUstar(new Map([[entry, Buffer.from('runtime')], ['node_modules/dependency/index.js', Buffer.from('dependency')]]));
  const input = plan(root, archive);
  input.pluginId = 'ai.deepseek.harness';
  if (input.runtime?.kind !== 'native-binary') throw new Error('fixture');
  Object.assign(input.runtime, { runtimeId: 'deepseek-harness', version: '0.1.1-rc.2', format: 'tar.gz', entryRelativePath: entry });
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  // The startup migration already ran above; legacy trees created afterwards
  // are installer reuse candidates, not migration input.
  const legacy = join(root, 'runtimes/deepseek-harness/runtimes/deepseek-harness/0.1.1-rc.2');
  await mkdir(legacy, { recursive: true });
  await extractManagedRuntimeArchive(archive, legacy);
  const wrapper = '#!/bin/sh\nexec old-managed-dsh "$@"\n';
  await writeFile(join(root, 'runtimes/dsh'), wrapper);
  const planner = createRuntimeInstallPlanner({
    runtimeId: 'deepseek-harness', kind: 'managed', format: 'tar.gz', entryRelativePath: entry,
    legacyDirectories: version => [`deepseek-harness/runtimes/deepseek-harness/${version}`],
  });
  let downloads = 0;
  const installer = new ManagedRuntimeInstaller({
    dataDir: root, store, planInstallation: async (_plan, request) => planner(request),
    download: async () => { downloads++; return archive; },
    probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  const result = await installer.install(input);
  assert.equal(result.runtime?.entryPath, join(legacy, entry));
  assert.equal(await readFile(join(root, 'runtimes/dsh'), 'utf8'), wrapper);
  await installer.install({ ...input, generationId: 'dsh-next-proxy' });
  assert.equal(downloads, 1);
});

test('recipe traversal, identity drift and directory symlinks are rejected before writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-recipe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('runtime');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const make = (alter: (value: Awaited<ReturnType<typeof fixtureInstallPlan>>) => unknown) => new ManagedRuntimeInstaller({
    dataDir: root, store,
    planInstallation: async (plan, request) => alter(await fixtureInstallPlan(plan, request)) as never,
    download: async () => bytes, probeVersion: async ({ expectedVersion }) => expectedVersion,
  });
  await assert.rejects(make(value => ({ ...value, runtimeId: 'other' })).install(input), /identity/);
  await assert.rejects(make(value => ({ ...value, operation: { ...value.operation, directory: '../escape' } })).install(input));
  const outside = await mkdtemp(join(tmpdir(), 'gian-runtime-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'runtimes', 'claude'));
  await assert.rejects(make(value => value).install(input), /symlink/);
});

test('an old Proxy without installer v1 fails explicitly before any Runtime download', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-old-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = plan(root, Buffer.from('runtime'));
  await executable(input.proxy.entryPath);
  const bootstrap = new URL('../../proxy-protocol/dist/src/node.js', import.meta.url).href;
  await writeFile(input.proxy.entryPath, `
    import { serveRuntimeBootstrap } from ${JSON.stringify(bootstrap)};
    await serveRuntimeBootstrap({
      pluginId: 'claude', pluginName: 'Claude', pluginVersion: '0.2.4', processScope: 'session',
      discover: async () => ({ candidates: [], setupActions: [] }),
      probe: async () => { throw new Error('must not probe'); },
    });
  `);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const installer = new ManagedRuntimeInstaller({
    dataDir: root, store,
    download: async () => { throw new Error('must not download'); },
    probeVersion: async () => { throw new Error('must not probe'); },
  });
  await assert.rejects(installer.install(input), (error: unknown) => (
    error instanceof ManagedRuntimeInstallError && error.code === 'RUNTIME_INSTALLER_UNSUPPORTED'
  ));
});

test('a version probe cannot bless mutated Runtime bytes with a certified receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-probe-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('certified');
  const input = plan(root, bytes);
  await executable(input.proxy.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const installer = new ManagedRuntimeInstaller({
    dataDir: root, store, planInstallation: fixtureInstallPlan,
    download: async () => bytes,
    probeVersion: async ({ executable: path, expectedVersion }) => {
      await writeFile(path, 'mutated');
      return expectedVersion;
    },
  });
  await assert.rejects(installer.install(input), (error: unknown) => (
    error instanceof ManagedRuntimeInstallError && error.code === 'RUNTIME_MUTATED'
  ));
  assert.deepEqual(await store.list('claude'), []);
});
