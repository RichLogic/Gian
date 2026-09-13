import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { ManagedRuntimeInstallPlan } from '@gian/shared';

import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { ManagedRuntimeInstallError, ManagedRuntimeInstaller } from '../src/runtime/installer.js';
import { extractManagedRuntimeArchive } from '../src/runtime/safe-extract.js';

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
  assert.equal(installed.runtime?.entryPath, join(root, 'runtimes', 'claude', '2.1.159', 'bin', 'claude'));
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
    dataDir: root,
    store,
    download: async () => archive,
    probeVersion: async ({ executable: candidate, expectedVersion }) => {
      probed = candidate;
      return expectedVersion;
    },
  });

  const installed = await installer.install(input);
  const versionRoot = join(root, 'runtimes', 'claude', '2.1.159');
  assert.equal(installed.runtime?.entryPath, join(versionRoot, 'bin', 'claude'));
  assert.equal(probed, join(root, 'runtimes', 'claude', expectStagingSegment(probed), 'bin', 'claude'));
  assert.deepEqual(await readFile(join(versionRoot, 'bin', 'claude')), entry);
  assert.deepEqual(await readFile(join(versionRoot, 'lib', 'support.txt')), support);
});

function expectStagingSegment(path: string | null): string {
  const match = /\/runtimes\/claude\/(\.staging-[^/]+)\/bin\/claude$/u.exec(path ?? '');
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
