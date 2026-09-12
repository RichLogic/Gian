import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ManagedRuntimeGeneration } from '@gian/shared';

import { ManagedRuntimeGenerationStore, ManagedRuntimeStoreError } from '../src/runtime/generation-store.js';

function generation(root: string, generationId: string, version: string): ManagedRuntimeGeneration {
  return {
    schemaVersion: 1,
    generationId,
    pluginId: 'claude',
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: version,
      manifestSha256: '1'.repeat(64),
      artifactSha256: '2'.repeat(64),
      entryPath: join(root, 'plugins', 'claude', version, 'proxy.mjs'),
      processScope: 'session',
      protocolRange: '>=2.3 <3.0',
    },
    runtime: {
      runtimeId: 'claude',
      version,
      artifactSha256: '3'.repeat(64),
      entryPath: join(root, 'runtimes', 'claude', version, 'bin', 'claude'),
      ownership: 'managed',
    },
    companions: [],
    certificate: { id: `claude-${version}`, sha256: '4'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-10T00:00:00.000Z',
    activatedAt: null,
  };
}

async function writeComponents(value: ManagedRuntimeGeneration): Promise<void> {
  for (const path of [
    value.proxy.entryPath,
    ...(value.runtime ? [value.runtime.entryPath] : []),
    ...value.companions.map(companion => companion.entryPath),
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }
}

test('stages immutable generations and activates one global pointer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const first = generation(root, 'claude-1', '1.0.0');
  const second = generation(root, 'claude-2', '1.1.0');
  await writeComponents(first);
  await writeComponents(second);
  await store.stage(first);
  await store.stage(first);
  await store.stage(second);
  await assert.rejects(
    store.stage({ ...first, certificate: { ...first.certificate, sha256: '5'.repeat(64) } }),
    (error: unknown) => error instanceof ManagedRuntimeStoreError
      && error.code === 'RUNTIME_GENERATION_CONFLICT',
  );

  const activeFirst = await store.activate('claude', first.generationId, new Date('2026-09-10T01:00:00.000Z'));
  assert.equal(activeFirst.state, 'active');
  assert.equal((await store.active('claude'))?.generationId, first.generationId);

  await store.activate('claude', second.generationId, new Date('2026-09-10T02:00:00.000Z'));
  assert.equal((await store.active('claude'))?.generationId, second.generationId);
  assert.equal((await store.get('claude', first.generationId))?.state, 'retired');
  assert.equal((await store.get('claude', second.generationId))?.state, 'active');
});

test('recovery completes a pointer-published activation journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const first = generation(root, 'claude-1', '1.0.0');
  const second = generation(root, 'claude-2', '1.1.0');
  await writeComponents(first);
  await writeComponents(second);
  await store.stage(first);
  await store.stage(second);
  await store.activate('claude', first.generationId, new Date('2026-09-10T01:00:00.000Z'));

  const directory = join(root, 'runtimes', 'generations', 'claude');
  const activatedAt = '2026-09-10T02:00:00.000Z';
  await writeFile(join(directory, 'activation-journal.json'), JSON.stringify({
    schemaVersion: 1,
    pluginId: 'claude',
    generationId: second.generationId,
    previousGenerationId: first.generationId,
    activatedAt,
  }));
  await writeFile(join(directory, 'active.json'), JSON.stringify({
    schemaVersion: 1,
    pluginId: 'claude',
    generationId: second.generationId,
    activatedAt,
  }));

  await store.recover('claude');
  assert.equal((await store.active('claude'))?.generationId, second.generationId);
  assert.equal((await store.get('claude', first.generationId))?.state, 'retired');
  assert.equal((await store.get('claude', second.generationId))?.state, 'active');
  await assert.rejects(readFile(join(directory, 'activation-journal.json')), { code: 'ENOENT' });
});

test('rejects component paths outside Gian-owned Runtime and Proxy roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-contained-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runtimes'), { recursive: true });
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const invalid = generation(root, 'claude-1', '1.0.0');
  await writeComponents(invalid);
  const outside = join(root, 'outside', 'claude');
  await mkdir(dirname(outside), { recursive: true });
  await writeFile(outside, '#!/bin/sh\n');
  invalid.runtime = { ...invalid.runtime!, entryPath: outside };
  await assert.rejects(
    store.stage(invalid),
    (error: unknown) => error instanceof ManagedRuntimeStoreError
      && error.code === 'RUNTIME_PATH_OUTSIDE_STORE',
  );
});

test('failed post-publish work leaves a fail-closed journal for startup recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-post-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const candidate = generation(root, 'claude-1', '1.0.0');
  await writeComponents(candidate);
  await store.stage(candidate);
  await assert.rejects(
    store.activate('claude', candidate.generationId, new Date('2026-09-10T01:00:00.000Z'), async () => {
      throw new Error('session binding write failed');
    }),
    /session binding write failed/,
  );
  assert.equal(store.activeCached('claude'), null);
  assert.equal(store.hasPendingActivation('claude'), true);

  const cold = new ManagedRuntimeGenerationStore(root);
  await cold.initialize();
  assert.equal(cold.activeCached('claude'), null);
  assert.equal(cold.hasPendingActivation('claude'), true);
  let recovered = false;
  await cold.recover('claude', async active => {
    recovered = true;
    assert.equal(active.generationId, candidate.generationId);
  });
  assert.equal(recovered, true);
  assert.equal(cold.hasPendingActivation('claude'), false);
  assert.equal(cold.activeCached('claude')?.generationId, candidate.generationId);
});

test('startup may complete a pending first activation without Session advancement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-first-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const candidate = generation(root, 'claude-1', '1.0.0');
  await writeComponents(candidate);
  await store.stage(candidate);
  await assert.rejects(
    store.activate('claude', candidate.generationId, new Date('2026-09-10T01:00:00.000Z'), async () => {
      throw new Error('host stopped after pointer publication');
    }),
    /host stopped/,
  );

  const cold = new ManagedRuntimeGenerationStore(root);
  await cold.initialize();
  assert.equal(cold.hasPendingActivation('claude'), true);
  await cold.recoverFreshActivations();
  assert.equal(cold.hasPendingActivation('claude'), false);
  assert.equal(cold.activeCached('claude')?.generationId, candidate.generationId);
});
