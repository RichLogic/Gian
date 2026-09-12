import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ManagedRuntimeGeneration } from '@gian/shared';

import { ManagedRuntimeActivationService } from '../src/runtime/activation-service.js';
import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function generation(root: string): ManagedRuntimeGeneration {
  return {
    schemaVersion: 1,
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
      runtimeId: 'claude',
      version: '2.1.159',
      artifactSha256: 'c'.repeat(64),
      entryPath: join(root, 'runtimes', 'claude', '2.1.159', 'bin', 'claude'),
      ownership: 'managed',
    },
    companions: [],
    certificate: { id: 'certificate-1', sha256: 'd'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-10T00:00:00.000Z',
    activatedAt: null,
  };
}

test('activation holds one global lease, drains processes, and advances idle Sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = generation(root);
  await executable(candidate.proxy.entryPath);
  await executable(candidate.runtime!.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  await store.stage(candidate);
  const order: string[] = [];
  const service = new ManagedRuntimeActivationService({
    store,
    lockDataDir: join(root, 'locks'),
    blockers: async () => { order.push('idle'); return []; },
    closeProxy: async () => { order.push('close-proxy'); },
    drainRuntime: async () => { order.push('drain-runtime'); },
    advanceSessions: async (_pluginId, active) => { order.push(`advance:${active.generationId}`); },
    onActivated: () => { order.push('invalidate'); },
    now: () => new Date('2026-09-10T01:00:00.000Z'),
    acquireLock: async (_dir, pluginId) => {
      order.push(`lock:${pluginId}`);
      return {
        reserveProcessGroup: async () => { throw new Error('not used'); },
        release: async () => { order.push('unlock'); },
      };
    },
  });
  const active = await service.activate('claude', candidate.generationId);
  assert.equal(active.state, 'active');
  assert.deepEqual(order, [
    'lock:claude',
    'idle',
    'close-proxy',
    'drain-runtime',
    `advance:${candidate.generationId}`,
    'invalidate',
    'unlock',
  ]);
});

test('failed Session advancement remains pending and recovery replays it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-activation-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = generation(root);
  await executable(candidate.proxy.entryPath);
  await executable(candidate.runtime!.entryPath);
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  await store.stage(candidate);
  let attempts = 0;
  const service = new ManagedRuntimeActivationService({
    store,
    lockDataDir: join(root, 'locks'),
    blockers: async () => [],
    closeProxy: async () => undefined,
    drainRuntime: async () => undefined,
    advanceSessions: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database unavailable');
    },
    acquireLock: async () => ({
      reserveProcessGroup: async () => { throw new Error('not used'); },
      release: async () => undefined,
    }),
  });
  await assert.rejects(service.activate('claude', candidate.generationId), /database unavailable/);
  assert.equal(store.activeCached('claude'), null);
  assert.equal(store.hasPendingActivation('claude'), true);
  await service.recover('claude');
  assert.equal(attempts, 2);
  assert.equal(store.activeCached('claude')?.generationId, candidate.generationId);
});
