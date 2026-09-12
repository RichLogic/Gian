import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ManagedRuntimeInstallPlan } from '@gian/shared';

import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { ManagedRuntimeInstallError, ManagedRuntimeInstaller } from '../src/runtime/installer.js';

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
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
