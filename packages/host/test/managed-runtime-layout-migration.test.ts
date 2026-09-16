import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  recordRuntimeArtifact,
  runtimeFileInventory,
  runtimeReceiptPath,
  verifiedRuntimeReuse,
} from '../src/runtime/artifact-reuse.js';
import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { migrateRuntimeLayout } from '../src/runtime/migrate-runtime-layout.js';

async function executable(path: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface GenerationFixture {
  pluginId: string;
  generationId: string;
  runtimeId?: string;
  version?: string;
  entryPath?: string;
  companions?: Array<{ id: string; version: string; entryPath: string }>;
  state?: 'staged' | 'active' | 'retired';
  installedAt?: string;
  activatedAt?: string | null;
}

function generation(dataDir: string, fixture: GenerationFixture): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generationId: fixture.generationId,
    pluginId: fixture.pluginId,
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.1.0',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: join(dataDir, 'plugins', fixture.pluginId, '0.1.0', 'proxy.mjs'),
      processScope: 'session',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: fixture.entryPath
      ? {
        runtimeId: fixture.runtimeId ?? 'claude',
        version: fixture.version ?? '1.0.0',
        artifactSha256: 'c'.repeat(64),
        entryPath: fixture.entryPath,
        ownership: 'managed',
      }
      : null,
    companions: (fixture.companions ?? []).map(companion => ({
      id: companion.id,
      version: companion.version,
      artifactSha256: 'd'.repeat(64),
      entryPath: companion.entryPath,
    })),
    certificate: { id: 'certificate-1', sha256: 'e'.repeat(64) },
    state: fixture.state ?? 'staged',
    installedAt: fixture.installedAt ?? '2026-09-10T00:00:00.000Z',
    activatedAt: fixture.activatedAt ?? null,
  };
}

async function writeGeneration(dataDir: string, fixture: GenerationFixture): Promise<Record<string, unknown>> {
  const value = generation(dataDir, fixture);
  await executable((value['proxy'] as { entryPath: string }).entryPath);
  const directory = join(dataDir, 'runtimes', 'generations', fixture.pluginId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${fixture.generationId}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function activate(dataDir: string, pluginId: string, generationId: string, activatedAt = '2026-09-10T01:00:00.000Z'): Promise<void> {
  await writeFile(join(dataDir, 'runtimes', 'generations', pluginId, 'active.json'), JSON.stringify({
    schemaVersion: 1,
    pluginId,
    generationId,
    activatedAt,
  }));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

test('migration moves managed trees, re-keys receipts and rewrites generations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-layout-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'runtimes');
  const sha = 'f'.repeat(64);
  const oldTree = join(runtimeRoot, 'managed', 'claude', '2.1.159', sha);
  await executable(join(oldTree, 'bin', 'claude'), '#!/bin/sh\necho 2.1.159\n');
  await mkdir(join(oldTree, 'lib'), { recursive: true });
  await writeFile(join(oldTree, 'lib', 'support.txt'), 'support');
  await recordRuntimeArtifact(runtimeRoot, oldTree, sha, 'bin/claude', await runtimeFileInventory(oldTree));
  const oldReceipt = runtimeReceiptPath(runtimeRoot, oldTree);
  const receiptBody = await readFile(oldReceipt);
  await writeGeneration(root, {
    pluginId: 'claude',
    generationId: 'claude-1',
    version: '2.1.159',
    entryPath: join(oldTree, 'bin', 'claude'),
    state: 'active',
    activatedAt: '2026-09-10T01:00:00.000Z',
  });
  await activate(root, 'claude', 'claude-1');

  const report = await migrateRuntimeLayout(root);
  assert.equal(report.treesMoved, 1);
  assert.equal(report.receiptsRekeyed, 1);
  const newTree = join(runtimeRoot, 'claude', '2.1.159', sha);
  assert.deepEqual(await readFile(join(newTree, 'bin', 'claude')), Buffer.from('#!/bin/sh\necho 2.1.159\n'));
  assert.deepEqual(await readFile(join(newTree, 'lib', 'support.txt')), Buffer.from('support'));
  assert.equal(await pathExists(join(oldTree, 'bin', 'claude')), false);
  assert.deepEqual(await readFile(runtimeReceiptPath(runtimeRoot, newTree)), receiptBody);
  assert.equal(await pathExists(oldReceipt), false);

  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const active = await store.active('claude');
  assert.equal(active?.runtime?.entryPath, join(newTree, 'bin', 'claude'));
  // The receipt still certifies the moved tree for installer reuse.
  assert.equal(await verifiedRuntimeReuse(runtimeRoot, newTree, sha, 'bin/claude'), true);
});

test('migration renames the dsh Runtime id and keeps a hand-installed new-layout tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-layout-dsh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'runtimes', 'deepseek-harness', '0.1.5-rc.2', 'a'.repeat(64), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  await executable(entry, 'console.log("0.1.5-rc.2");\n');
  const written = await writeGeneration(root, {
    pluginId: 'ai.deepseek.harness',
    generationId: 'dsh-1',
    runtimeId: 'dsh',
    version: '0.1.5-rc.2',
    entryPath: entry,
    state: 'active',
    activatedAt: '2026-09-10T01:00:00.000Z',
  });
  await activate(root, 'ai.deepseek.harness', 'dsh-1');
  assert.equal((written['runtime'] as { runtimeId: string }).runtimeId, 'dsh');

  const report = await migrateRuntimeLayout(root);
  assert.equal(report.runtimeIdsRenamed, 1);
  assert.equal(report.treesMoved, 0);

  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const active = await store.active('ai.deepseek.harness');
  assert.equal(active?.runtime?.runtimeId, 'deepseek-harness');
  assert.equal(active?.runtime?.entryPath, entry);
  assert.deepEqual(await readFile(entry), Buffer.from('console.log("0.1.5-rc.2");\n'));
});

test('migration deletes unreferenced legacy trees and preserves referenced ones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-layout-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'runtimes');
  // Referenced legacy flat tree: kept.
  const flatEntry = join(runtimeRoot, 'codex', '0.146.0', 'bin', 'codex');
  await executable(flatEntry);
  await writeGeneration(root, {
    pluginId: 'codex',
    generationId: 'codex-1',
    version: '0.146.0',
    entryPath: flatEntry,
    state: 'active',
    activatedAt: '2026-09-10T01:00:00.000Z',
  });
  await activate(root, 'codex', 'codex-1');
  // Unreferenced legacy flat tree: deleted.
  const staleFlat = join(runtimeRoot, 'kimi', '0.38.0');
  await executable(join(staleFlat, 'kimi'));
  // Old DSH harness tree: deleted.
  const harnessLegacy = join(runtimeRoot, 'deepseek-harness', 'runtimes', 'deepseek-harness', '0.1.1-rc.2');
  await executable(join(harnessLegacy, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  // Unreferenced managed leftover: deleted wholesale.
  await executable(join(runtimeRoot, 'managed', 'grok', '1.0.4', 'b'.repeat(64), 'bin', 'grok'));
  // Legacy launcher file: preserved.
  const launcher = join(runtimeRoot, 'dsh');
  await writeFile(launcher, '#!/bin/sh\nexec old-managed-dsh "$@"\n');

  const report = await migrateRuntimeLayout(root);
  assert.deepEqual(report.treesDeleted.sort(), [
    'deepseek-harness/runtimes',
    'kimi/0.38.0',
    'managed',
  ]);
  assert.equal(await pathExists(flatEntry), true);
  assert.deepEqual(await readFile(launcher, 'utf8'), '#!/bin/sh\nexec old-managed-dsh "$@"\n');

  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  assert.equal((await store.active('codex'))?.runtime?.entryPath, flatEntry);
});

test('migration removes dangling generations and repairs the active pointer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-layout-dangling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Active generation whose managed tree vanished: removed, pointer repaired
  // to the surviving generation.
  const survivorEntry = join(root, 'runtimes', 'grok', '1.0.0', 'bin', 'grok');
  await executable(survivorEntry);
  await writeGeneration(root, {
    pluginId: 'grok',
    generationId: 'grok-old',
    version: '1.0.0',
    entryPath: survivorEntry,
    state: 'retired',
    installedAt: '2026-09-01T00:00:00.000Z',
  });
  await writeGeneration(root, {
    pluginId: 'grok',
    generationId: 'grok-lost',
    version: '1.0.4',
    entryPath: join(root, 'runtimes', 'managed', 'grok', '1.0.4', 'c'.repeat(64), 'bin', 'grok'),
    state: 'active',
    installedAt: '2026-09-09T00:00:00.000Z',
    activatedAt: '2026-09-09T01:00:00.000Z',
  });
  await activate(root, 'grok', 'grok-lost', '2026-09-09T01:00:00.000Z');
  // Plugin whose only generation dangles: record and pointer removed.
  await writeGeneration(root, {
    pluginId: 'kimi',
    generationId: 'kimi-lost',
    version: '0.38.0',
    entryPath: join(root, 'runtimes', 'managed', 'kimi', '0.38.0', 'd'.repeat(64), 'kimi'),
    state: 'active',
    activatedAt: '2026-09-09T01:00:00.000Z',
  });
  await activate(root, 'kimi', 'kimi-lost', '2026-09-09T01:00:00.000Z');

  const report = await migrateRuntimeLayout(root);
  assert.deepEqual(report.generationsRemoved.sort(), ['grok/grok-lost', 'kimi/kimi-lost']);
  assert.deepEqual(report.activationsRepaired.sort(), ['grok', 'kimi']);

  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  const grok = await store.active('grok');
  assert.equal(grok?.generationId, 'grok-old');
  assert.equal(grok?.state, 'active');
  assert.equal(grok?.activatedAt, '2026-09-09T01:00:00.000Z');
  assert.deepEqual((await store.list('grok')).map(item => item.generationId), ['grok-old']);
  assert.equal(await store.active('kimi'), null);
  assert.deepEqual(await store.list('kimi'), []);
});

test('migration is idempotent and never follows a managed symlink outside the store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-layout-idempotent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'runtimes');
  const sha = 'f'.repeat(64);
  const oldTree = join(runtimeRoot, 'managed', 'claude', '2.1.159', sha);
  await executable(join(oldTree, 'bin', 'claude'));
  await recordRuntimeArtifact(runtimeRoot, oldTree, sha, 'bin/claude', await runtimeFileInventory(oldTree));
  await writeGeneration(root, {
    pluginId: 'claude',
    generationId: 'claude-1',
    version: '2.1.159',
    entryPath: join(oldTree, 'bin', 'claude'),
    state: 'active',
    activatedAt: '2026-09-10T01:00:00.000Z',
  });
  await activate(root, 'claude', 'claude-1');

  const first = await migrateRuntimeLayout(root);
  assert.equal(first.treesMoved, 1);
  const second = await migrateRuntimeLayout(root);
  assert.deepEqual(second, {
    runtimeIdsRenamed: 0,
    treesMoved: 0,
    receiptsRekeyed: 0,
    generationsRemoved: [],
    activationsRepaired: [],
    treesDeleted: [],
    receiptsPruned: 0,
  });
  const store = new ManagedRuntimeGenerationStore(root);
  await store.initialize();
  assert.equal(
    (await store.active('claude'))?.runtime?.entryPath,
    join(runtimeRoot, 'claude', '2.1.159', sha, 'bin', 'claude'),
  );

  // A symlinked runtimes/managed is not owned: nothing outside the store is
  // read, moved or deleted, and the store stays untouched.
  const symlinkRoot = await mkdtemp(join(tmpdir(), 'gian-layout-symlink-'));
  t.after(() => rm(symlinkRoot, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'gian-layout-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await executable(join(outside, 'claude', '2.1.159', sha, 'bin', 'claude'));
  await mkdir(join(symlinkRoot, 'runtimes'), { recursive: true });
  await symlink(outside, join(symlinkRoot, 'runtimes', 'managed'));
  await writeGeneration(symlinkRoot, {
    pluginId: 'claude',
    generationId: 'claude-1',
    version: '2.1.159',
    entryPath: join(symlinkRoot, 'runtimes', 'managed', 'claude', '2.1.159', sha, 'bin', 'claude'),
    state: 'active',
    activatedAt: '2026-09-10T01:00:00.000Z',
  });
  await activate(symlinkRoot, 'claude', 'claude-1');
  const report = await migrateRuntimeLayout(symlinkRoot);
  assert.equal(report.treesMoved, 0);
  assert.deepEqual(report.treesDeleted, []);
  assert.equal(await pathExists(join(outside, 'claude', '2.1.159', sha, 'bin', 'claude')), true);
});
