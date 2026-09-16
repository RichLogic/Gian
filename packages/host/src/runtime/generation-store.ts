import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  isCanonicalAbsolutePath,
  parseProxyPluginId,
  type ManagedRuntimeActivePointer,
  type ManagedRuntimeGeneration,
  type ManagedRuntimePlatform,
} from '@gian/shared';

import { fsyncDirectory, writeFileAtomic } from '../catalog/atomic.js';
import { migrateRuntimeLayout } from './migrate-runtime-layout.js';

const MAX_RECORD_BYTES = 256 * 1024;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORMS = new Set<ManagedRuntimePlatform>([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);

interface ActivationJournal {
  schemaVersion: 1;
  pluginId: string;
  generationId: string;
  previousGenerationId: string | null;
  activatedAt: string;
}

export class ManagedRuntimeStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedRuntimeStoreError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4_096 && isCanonicalAbsolutePath(value);
}

function proxyRef(value: unknown): value is ManagedRuntimeGeneration['proxy'] {
  const item = record(value);
  return Boolean(item
    && exactKeys(item, [
      'pluginVersion',
      'manifestSha256',
      'artifactSha256',
      'entryPath',
      'processScope',
      'protocolRange',
    ])
    && typeof item['pluginVersion'] === 'string' && SEMVER.test(item['pluginVersion'])
    && typeof item['manifestSha256'] === 'string' && SHA256.test(item['manifestSha256'])
    && typeof item['artifactSha256'] === 'string' && SHA256.test(item['artifactSha256'])
    && safePath(item['entryPath'])
    && (item['processScope'] === 'shared' || item['processScope'] === 'session')
    && typeof item['protocolRange'] === 'string'
    && item['protocolRange'].length > 0
    && item['protocolRange'].length <= 128);
}

function runtimeRef(value: unknown): value is NonNullable<ManagedRuntimeGeneration['runtime']> {
  const item = record(value);
  return Boolean(item
    && exactKeys(item, ['runtimeId', 'version', 'artifactSha256', 'entryPath', 'ownership'])
    && typeof item['runtimeId'] === 'string' && COMPONENT_ID.test(item['runtimeId'])
    && typeof item['version'] === 'string' && SEMVER.test(item['version'])
    && typeof item['artifactSha256'] === 'string' && SHA256.test(item['artifactSha256'])
    && safePath(item['entryPath'])
    && (item['ownership'] === 'managed' || item['ownership'] === 'external-app'));
}

function companionRef(value: unknown): value is ManagedRuntimeGeneration['companions'][number] {
  const item = record(value);
  return Boolean(item
    && exactKeys(item, ['id', 'version', 'artifactSha256', 'entryPath'])
    && typeof item['id'] === 'string' && COMPONENT_ID.test(item['id'])
    && typeof item['version'] === 'string' && SEMVER.test(item['version'])
    && typeof item['artifactSha256'] === 'string' && SHA256.test(item['artifactSha256'])
    && safePath(item['entryPath']));
}

function parseGeneration(value: unknown): ManagedRuntimeGeneration {
  const item = record(value);
  if (!item || !exactKeys(item, [
    'schemaVersion',
    'generationId',
    'pluginId',
    'platform',
    'proxy',
    'runtime',
    'companions',
    'certificate',
    'state',
    'installedAt',
    'activatedAt',
  ])) {
    throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_INVALID', 'Runtime generation record is invalid.');
  }
  const certificate = record(item['certificate']);
  const companions = item['companions'];
  if (
    item['schemaVersion'] !== 1
    || typeof item['generationId'] !== 'string'
    || !GENERATION_ID.test(item['generationId'])
    || typeof item['pluginId'] !== 'string'
    || typeof item['platform'] !== 'string'
    || !PLATFORMS.has(item['platform'] as ManagedRuntimePlatform)
    || !proxyRef(item['proxy'])
    || (item['runtime'] !== null && !runtimeRef(item['runtime']))
    || !Array.isArray(companions)
    || companions.length > 16
    || !companions.every(companionRef)
    || new Set(companions.map(companion => companion.id)).size !== companions.length
    || !certificate
    || !exactKeys(certificate, ['id', 'sha256'])
    || typeof certificate['id'] !== 'string'
    || !COMPONENT_ID.test(certificate['id'])
    || typeof certificate['sha256'] !== 'string'
    || !SHA256.test(certificate['sha256'])
    || !['staged', 'active', 'retired', 'failed'].includes(String(item['state']))
    || !isoDate(item['installedAt'])
    || (item['activatedAt'] !== null && !isoDate(item['activatedAt']))
  ) {
    throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_INVALID', 'Runtime generation fields are invalid.');
  }
  parseProxyPluginId(item['pluginId']);
  return item as unknown as ManagedRuntimeGeneration;
}

function parsePointer(value: unknown): ManagedRuntimeActivePointer {
  const item = record(value);
  if (
    !item
    || !exactKeys(item, ['schemaVersion', 'pluginId', 'generationId', 'activatedAt'])
    || item['schemaVersion'] !== 1
    || typeof item['pluginId'] !== 'string'
    || typeof item['generationId'] !== 'string'
    || !GENERATION_ID.test(item['generationId'])
    || !isoDate(item['activatedAt'])
  ) {
    throw new ManagedRuntimeStoreError('RUNTIME_POINTER_INVALID', 'Active Runtime pointer is invalid.');
  }
  parseProxyPluginId(item['pluginId']);
  return item as unknown as ManagedRuntimeActivePointer;
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
    throw new ManagedRuntimeStoreError('RUNTIME_RECORD_INVALID', `Runtime record is not a bounded regular file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new ManagedRuntimeStoreError('RUNTIME_RECORD_INVALID', `Runtime record is too large: ${path}`);
  }
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

export class ManagedRuntimeGenerationStore {
  private readonly runtimeRoot: string;
  private readonly generationRoot: string;
  private readonly activeGenerations = new Map<string, ManagedRuntimeGeneration>();
  private readonly pendingActivations = new Set<string>();

  constructor(private readonly dataDir: string) {
    this.runtimeRoot = join(dataDir, 'runtimes');
    this.generationRoot = join(this.runtimeRoot, 'generations');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.generationRoot, { recursive: true, mode: 0o700 }),
      mkdir(join(this.dataDir, 'plugins'), { recursive: true, mode: 0o700 }),
    ]);
    // One-time, idempotent Runtime layout migration (runtimes/managed/* →
    // runtimes/*, Runtime id `dsh` → `deepseek-harness`, legacy tree
    // cleanup). It must finish before any generation record is parsed so
    // recovery below sees only the migrated, fail-closed state.
    await migrateRuntimeLayout(this.dataDir);
    for (const entry of await readdir(this.generationRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await this.recover(entry.name, undefined, true);
      if (!this.pendingActivations.has(entry.name)) {
        const active = await this.readActive(entry.name);
        if (active) this.activeGenerations.set(entry.name, active);
      }
    }
  }

  async stage(input: ManagedRuntimeGeneration): Promise<ManagedRuntimeGeneration> {
    const generation = parseGeneration(input);
    if (generation.state !== 'staged' || generation.activatedAt !== null) {
      throw new ManagedRuntimeStoreError(
        'RUNTIME_GENERATION_NOT_STAGED',
        'A new Runtime generation must be staged and must not have activatedAt.',
      );
    }
    await this.assertOwnedPaths(generation);
    const directory = await this.pluginDirectory(generation.pluginId);
    const path = join(directory, `${generation.generationId}.json`);
    const bytes = serialize(generation);
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = parseGeneration(await readJson(path));
      if (serialize(existing).equals(bytes)) return existing;
      throw new ManagedRuntimeStoreError(
        'RUNTIME_GENERATION_CONFLICT',
        `Runtime generation already exists with different content: ${generation.generationId}`,
      );
    }
    return generation;
  }

  async get(pluginId: string, generationId: string): Promise<ManagedRuntimeGeneration | null> {
    const id = parseProxyPluginId(pluginId);
    if (!GENERATION_ID.test(generationId)) {
      throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_ID_INVALID', 'Runtime generation id is invalid.');
    }
    try {
      const generation = parseGeneration(await readJson(join(this.generationRoot, id, `${generationId}.json`)));
      if (generation.pluginId !== id || generation.generationId !== generationId) {
        throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_INVALID', 'Runtime generation identity does not match its path.');
      }
      await this.assertOwnedPaths(generation);
      return generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async active(pluginId: string): Promise<ManagedRuntimeGeneration | null> {
    const id = parseProxyPluginId(pluginId);
    if (this.pendingActivations.has(id)) {
      throw new ManagedRuntimeStoreError(
        'RUNTIME_ACTIVATION_PENDING',
        'Runtime activation recovery must finish before the generation can be used.',
      );
    }
    const active = await this.readActive(pluginId);
    if (active) this.activeGenerations.set(active.pluginId, active);
    else this.activeGenerations.delete(id);
    return active;
  }

  activeCached(pluginId: string): ManagedRuntimeGeneration | null {
    const id = parseProxyPluginId(pluginId);
    return this.pendingActivations.has(id) ? null : this.activeGenerations.get(id) ?? null;
  }

  hasPendingActivation(pluginId: string): boolean {
    return this.pendingActivations.has(parseProxyPluginId(pluginId));
  }

  /** Startup can finish a first activation before Session services exist:
   * there is no previous generation, so there are no bindings to advance.
   * Replacement activations remain pending for the full activation service. */
  async recoverFreshActivations(): Promise<void> {
    for (const id of [...this.pendingActivations]) {
      const value = record(await readJson(join(
        this.generationRoot,
        id,
        'activation-journal.json',
      )));
      if (value?.['previousGenerationId'] === null) await this.recover(id);
    }
  }

  private async readActive(pluginId: string): Promise<ManagedRuntimeGeneration | null> {
    const id = parseProxyPluginId(pluginId);
    let pointer: ManagedRuntimeActivePointer;
    try {
      pointer = parsePointer(await readJson(join(this.generationRoot, id, 'active.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (pointer.pluginId !== id) {
      throw new ManagedRuntimeStoreError('RUNTIME_POINTER_INVALID', 'Active Runtime pointer pluginId does not match its path.');
    }
    const generation = await this.get(id, pointer.generationId);
    if (!generation || generation.state !== 'active' || generation.activatedAt !== pointer.activatedAt) {
      throw new ManagedRuntimeStoreError('RUNTIME_POINTER_DANGLING', 'Active Runtime pointer does not identify an active generation.');
    }
    return generation;
  }

  async list(pluginId: string): Promise<ManagedRuntimeGeneration[]> {
    const id = parseProxyPluginId(pluginId);
    const directory = join(this.generationRoot, id);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const generations: ManagedRuntimeGeneration[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name === 'active.json' || entry.name === 'activation-journal.json') continue;
      const generationId = entry.name.slice(0, -'.json'.length);
      const generation = await this.get(id, generationId);
      if (generation) generations.push(generation);
    }
    return generations.sort((left, right) => right.installedAt.localeCompare(left.installedAt));
  }

  async activate(
    pluginId: string,
    generationId: string,
    now = new Date(),
    afterPublish?: (
      active: ManagedRuntimeGeneration,
      previous: ManagedRuntimeGeneration | null,
    ) => Promise<void>,
  ): Promise<ManagedRuntimeGeneration> {
    const id = parseProxyPluginId(pluginId);
    const candidate = await this.get(id, generationId);
    if (!candidate) {
      throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_NOT_FOUND', `Runtime generation not found: ${generationId}`);
    }
    if (candidate.state !== 'staged' && candidate.state !== 'active') {
      throw new ManagedRuntimeStoreError('RUNTIME_GENERATION_NOT_STAGED', 'Only a staged Runtime generation can be activated.');
    }
    const previous = await this.active(id);
    if (previous?.generationId === generationId) return previous;
    const activatedAt = now.toISOString();
    const directory = await this.pluginDirectory(id);
    const journal: ActivationJournal = {
      schemaVersion: 1,
      pluginId: id,
      generationId,
      previousGenerationId: previous?.generationId ?? null,
      activatedAt,
    };
    await writeFileAtomic(join(directory, 'activation-journal.json'), serialize(journal));
    this.pendingActivations.add(id);
    this.activeGenerations.delete(id);
    await this.writeGeneration({ ...candidate, state: 'active', activatedAt });
    await writeFileAtomic(join(directory, 'active.json'), serialize({
      schemaVersion: 1,
      pluginId: id,
      generationId,
      activatedAt,
    } satisfies ManagedRuntimeActivePointer));
    if (previous) {
      await this.writeGeneration({ ...previous, state: 'retired' });
    }
    const active = { ...candidate, state: 'active' as const, activatedAt };
    if (afterPublish) await afterPublish(active, previous);
    await rm(join(directory, 'activation-journal.json'), { force: true });
    await fsyncDirectory(directory);
    this.pendingActivations.delete(id);
    this.activeGenerations.set(id, active);
    return active;
  }

  async recover(
    pluginId: string,
    afterPublish?: (
      active: ManagedRuntimeGeneration,
      previous: ManagedRuntimeGeneration | null,
    ) => Promise<void>,
    retainPublishedJournal = false,
  ): Promise<void> {
    let id: string;
    try {
      id = parseProxyPluginId(pluginId);
    } catch {
      return;
    }
    const directory = join(this.generationRoot, id);
    let journal: ActivationJournal;
    try {
      const value = record(await readJson(join(directory, 'activation-journal.json')));
      if (
        !value
        || !exactKeys(value, ['schemaVersion', 'pluginId', 'generationId', 'previousGenerationId', 'activatedAt'])
        || value['schemaVersion'] !== 1
        || value['pluginId'] !== id
        || typeof value['generationId'] !== 'string'
        || !GENERATION_ID.test(value['generationId'])
        || (value['previousGenerationId'] !== null && (
          typeof value['previousGenerationId'] !== 'string'
          || !GENERATION_ID.test(value['previousGenerationId'])
        ))
        || !isoDate(value['activatedAt'])
      ) {
        throw new ManagedRuntimeStoreError('RUNTIME_JOURNAL_INVALID', 'Runtime activation journal is invalid.');
      }
      journal = value as unknown as ActivationJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.pendingActivations.delete(id);
        return;
      }
      throw error;
    }
    this.pendingActivations.add(id);
    this.activeGenerations.delete(id);

    let pointer: ManagedRuntimeActivePointer | null = null;
    try {
      pointer = parsePointer(await readJson(join(directory, 'active.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const candidate = await this.get(id, journal.generationId);
    if (!candidate) {
      throw new ManagedRuntimeStoreError('RUNTIME_JOURNAL_DANGLING', 'Activation journal candidate is missing.');
    }
    if (pointer?.generationId === journal.generationId && pointer.activatedAt === journal.activatedAt) {
      if (candidate.state !== 'active' || candidate.activatedAt !== journal.activatedAt) {
        await this.writeGeneration({ ...candidate, state: 'active', activatedAt: journal.activatedAt });
      }
      let previous: ManagedRuntimeGeneration | null = null;
      if (journal.previousGenerationId) {
        previous = await this.get(id, journal.previousGenerationId);
        if (previous && previous.state !== 'retired') {
          await this.writeGeneration({ ...previous, state: 'retired' });
        }
      }
      if (retainPublishedJournal && !afterPublish) return;
      const active = {
        ...candidate,
        state: 'active' as const,
        activatedAt: journal.activatedAt,
      };
      if (afterPublish) await afterPublish(active, previous);
    } else if (candidate.state === 'active') {
      await this.writeGeneration({ ...candidate, state: 'staged', activatedAt: null });
    }
    await rm(join(directory, 'activation-journal.json'), { force: true });
    await fsyncDirectory(directory);
    this.pendingActivations.delete(id);
    const active = await this.readActive(id);
    if (active) this.activeGenerations.set(id, active);
    else this.activeGenerations.delete(id);
  }

  private async pluginDirectory(pluginId: string): Promise<string> {
    const directory = join(this.generationRoot, parseProxyPluginId(pluginId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async writeGeneration(generation: ManagedRuntimeGeneration): Promise<void> {
    const parsed = parseGeneration(generation);
    await this.assertOwnedPaths(parsed);
    const path = join(this.generationRoot, parsed.pluginId, `${parsed.generationId}.json`);
    await writeFileAtomic(path, serialize(parsed));
  }

  private async assertOwnedPaths(generation: ManagedRuntimeGeneration): Promise<void> {
    const paths = [
      { path: generation.proxy.entryPath, ownership: 'managed' as const },
      ...(generation.runtime ? [{
        path: generation.runtime.entryPath,
        ownership: generation.runtime.ownership,
      }] : []),
      ...generation.companions.map(companion => ({
        path: companion.entryPath,
        ownership: 'managed' as const,
      })),
    ];
    const pluginRoot = join(this.dataDir, 'plugins');
    const [canonicalRuntimeRoot, canonicalPluginRoot] = await Promise.all([
      realpath(this.runtimeRoot),
      realpath(pluginRoot),
    ]);
    for (const component of paths) {
      const metadata = await lstat(component.path);
      const canonical = await realpath(component.path);
      const externalZcode = component.ownership === 'external-app'
        && (generation.pluginId === 'zcode' || generation.pluginId === 'com.zhipu.zcode')
        && (
          canonical === '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
          || canonical.endsWith('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')
        );
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || (
          !externalZcode
          && (!contained(canonicalRuntimeRoot, canonical) && !contained(canonicalPluginRoot, canonical))
        )
      ) {
        throw new ManagedRuntimeStoreError(
          'RUNTIME_PATH_OUTSIDE_STORE',
          `Managed Runtime component is outside Gian-owned roots: ${component.path}`,
        );
      }
    }
  }
}
