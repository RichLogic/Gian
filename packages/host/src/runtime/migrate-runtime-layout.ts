import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fsyncDirectory, writeFileAtomic } from '../catalog/atomic.js';
import {
  ownedRuntimeDirectory,
  runtimeFileInventory,
  runtimeReceiptPath,
  sameRuntimeTree,
} from './artifact-reuse.js';

const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_FILE = /^[0-9a-f]{64}\.json$/;
const RENAMED_RUNTIME_IDS: Readonly<Record<string, string>> = { dsh: 'deepseek-harness' };
const RESERVED_ROOT_ENTRIES = new Set(['generations', 'receipts']);

export interface RuntimeLayoutMigrationReport {
  runtimeIdsRenamed: number;
  treesMoved: number;
  receiptsRekeyed: number;
  generationsRemoved: string[];
  activationsRepaired: string[];
  treesDeleted: string[];
  receiptsPruned: number;
}

interface GenerationRecord {
  pluginId: string;
  generationId: string;
  file: string;
  value: Record<string, unknown>;
  runtime: Record<string, unknown> | null;
  companions: Array<Record<string, unknown>>;
  removed: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** One-time migration from the pre-2026-09 managed Runtime layout to the
 * content-addressed `runtimes/{runtimeId}/{version}/{sha256}` layout, run by
 * ManagedRuntimeGenerationStore.initialize before any generation is parsed:
 *
 * - Generation records whose Runtime id is a renamed id (`dsh`) are rewritten
 *   to the new id (`deepseek-harness`).
 * - Component entry paths pointing into `runtimes/managed/...` move their
 *   tree to the same path without the `managed/` level, re-key the tree's
 *   receipt (receipts are keyed by absolute directory) and re-point the
 *   generation. A tree already present at the target with identical content
 *   is re-pointed and re-keyed in place.
 * - Legacy flat trees `runtimes/{runtimeId}/{version}`, the old
 *   `runtimes/deepseek-harness/runtimes/` tree and `runtimes/managed/` are
 *   deleted once no generation references them. Referenced trees are never
 *   deleted, and nothing outside `<dataDir>/runtimes` is touched.
 * - Generations whose managed Runtime or companion entry no longer exists
 *   after migration are removed; if that orphans the active pointer, the
 *   newest surviving generation is promoted so startup never publishes a
 *   dangling active generation.
 *
 * Every step is idempotent: each record is moved, re-keyed and atomically
 * rewritten before the next is touched, so an interrupted run converges on
 * the next startup instead of corrupting the store.
 */
export async function migrateRuntimeLayout(dataDir: string): Promise<RuntimeLayoutMigrationReport> {
  const runtimeRoot = join(dataDir, 'runtimes');
  const generationRoot = join(runtimeRoot, 'generations');
  const managedRoot = join(runtimeRoot, 'managed');
  const report: RuntimeLayoutMigrationReport = {
    runtimeIdsRenamed: 0,
    treesMoved: 0,
    receiptsRekeyed: 0,
    generationsRemoved: [],
    activationsRepaired: [],
    treesDeleted: [],
    receiptsPruned: 0,
  };
  const records = await readGenerationRecords(generationRoot);

  const rekeyReceipt = async (oldTree: string, newTree: string): Promise<void> => {
    const oldReceipt = runtimeReceiptPath(runtimeRoot, oldTree);
    const newReceipt = runtimeReceiptPath(runtimeRoot, newTree);
    try {
      const body = await readFile(oldReceipt);
      await mkdir(dirname(newReceipt), { recursive: true, mode: 0o700 });
      await writeFileAtomic(newReceipt, body);
      await rm(oldReceipt, { force: true });
      report.receiptsRekeyed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };

  const ensureOwnedParent = async (parent: string): Promise<boolean> => {
    let current = runtimeRoot;
    for (const part of relative(runtimeRoot, parent).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // A legacy launcher file or symlink occupying a path component refuses
      // the move; the record keeps its managed/ entry and stays referenced.
      if (!await ownedRuntimeDirectory(runtimeRoot, current).catch(() => false)) return false;
    }
    return true;
  };

  /** Moves one component entry out of runtimes/managed. Returns the new
   * absolute entry path, or null when the entry must stay as recorded. */
  const migrateManagedEntry = async (entryPath: unknown): Promise<string | null> => {
    if (typeof entryPath !== 'string' || !isWithin(managedRoot, entryPath)) return null;
    const parts = relative(managedRoot, entryPath).split(sep);
    const [runtimeId, version, sha, ...rest] = parts;
    if (!runtimeId || !version || !sha || rest.length === 0
      || !COMPONENT_ID.test(runtimeId) || !SEMVER.test(version) || !SHA256.test(sha)) {
      return null;
    }
    const oldTree = join(managedRoot, runtimeId, version, sha);
    const newTree = join(runtimeRoot, runtimeId, version, sha);
    const oldOwned = await ownedRuntimeDirectory(runtimeRoot, oldTree).catch(() => false);
    const newOwned = await ownedRuntimeDirectory(runtimeRoot, newTree).catch(() => false);
    if (newOwned) {
      if (oldOwned) {
        if (!await sameRuntimeTree(newTree, await runtimeFileInventory(oldTree))) return null;
        await rm(oldTree, { recursive: true, force: true });
      }
      await rekeyReceipt(oldTree, newTree);
      report.treesMoved++;
      return join(newTree, ...rest);
    }
    if (!oldOwned || !await ensureOwnedParent(dirname(newTree))) return null;
    await rename(oldTree, newTree);
    await fsyncDirectory(dirname(newTree));
    await rekeyReceipt(oldTree, newTree);
    report.treesMoved++;
    return join(newTree, ...rest);
  };

  for (const record of records) {
    let dirty = false;
    const runtime = record.runtime;
    if (runtime) {
      const renamed = RENAMED_RUNTIME_IDS[String(runtime['runtimeId'])];
      if (renamed) {
        runtime['runtimeId'] = renamed;
        report.runtimeIdsRenamed++;
        dirty = true;
      }
      if (runtime['ownership'] === 'managed') {
        const moved = await migrateManagedEntry(runtime['entryPath']);
        if (moved) {
          runtime['entryPath'] = moved;
          dirty = true;
        }
      }
    }
    for (const companion of record.companions) {
      const moved = await migrateManagedEntry(companion['entryPath']);
      if (moved) {
        companion['entryPath'] = moved;
        dirty = true;
      }
    }
    if (dirty) await writeFileAtomic(record.file, serialize(record.value));
  }

  const managedEntryPaths = (record: GenerationRecord): string[] => {
    const paths: string[] = [];
    const runtime = record.runtime;
    if (runtime && runtime['ownership'] === 'managed' && typeof runtime['entryPath'] === 'string') {
      paths.push(runtime['entryPath']);
    }
    for (const companion of record.companions) {
      if (typeof companion['entryPath'] === 'string') paths.push(companion['entryPath']);
    }
    return paths;
  };

  // A partially migrated store must not keep records whose managed Runtime
  // bytes are gone; remaining records are the referenced set for deletion.
  for (const record of records) {
    const paths = managedEntryPaths(record);
    let dangling = false;
    for (const path of paths) {
      if (!await exists(path)) {
        dangling = true;
        break;
      }
    }
    if (!dangling) continue;
    record.removed = true;
    await rm(record.file, { force: true });
    report.generationsRemoved.push(`${record.pluginId}/${record.generationId}`);
  }

  const survivors = records.filter(record => !record.removed);
  const referenced = survivors.flatMap(managedEntryPaths);
  const isReferenced = (directory: string): boolean => (
    referenced.some(path => path === directory || path.startsWith(`${directory}${sep}`))
  );

  await repairActivePointers(generationRoot, records, report);

  const safeRemoveTree = async (directory: string): Promise<boolean> => {
    const owned = await ownedRuntimeDirectory(runtimeRoot, directory).catch(() => false);
    if (!owned) return false;
    await rm(directory, { recursive: true, force: true });
    await fsyncDirectory(dirname(directory));
    report.treesDeleted.push(relative(runtimeRoot, directory).split(sep).join('/'));
    return true;
  };

  const isNewLayoutVersionDir = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.length > 0 && entries.every(entry => (
      entry.isDirectory() && !entry.isSymbolicLink() && SHA256.test(entry.name)
    ));
  };

  // Legacy flat trees and foreign subtrees below a Runtime id directory
  // (including the old deepseek-harness/runtimes tree) are deleted once no
  // surviving generation references them.
  let rootEntries;
  try {
    rootEntries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report;
    throw error;
  }
  for (const entry of rootEntries) {
    if (RESERVED_ROOT_ENTRIES.has(entry.name) || entry.name === 'managed' || entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !COMPONENT_ID.test(entry.name)) continue;
    const runtimeIdDir = join(runtimeRoot, entry.name);
    for (const child of await readdir(runtimeIdDir, { withFileTypes: true })) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const childPath = join(runtimeIdDir, child.name);
      if (SEMVER.test(child.name) && await isNewLayoutVersionDir(childPath)) continue;
      if (!isReferenced(childPath)) await safeRemoveTree(childPath);
    }
  }

  // runtimes/managed is fully deleted once every referenced tree moved out;
  // a pathological conflict keeps only the still-referenced subtrees.
  if (await ownedRuntimeDirectory(runtimeRoot, managedRoot).catch(() => false)) {
    if (!isReferenced(managedRoot)) {
      await safeRemoveTree(managedRoot);
    } else {
      for (const runtimeIdDir of await readdir(managedRoot, { withFileTypes: true })) {
        if (!runtimeIdDir.isDirectory() || runtimeIdDir.isSymbolicLink() || !COMPONENT_ID.test(runtimeIdDir.name)) continue;
        const versionParent = join(managedRoot, runtimeIdDir.name);
        for (const versionDir of await readdir(versionParent, { withFileTypes: true })) {
          if (!versionDir.isDirectory() || versionDir.isSymbolicLink() || !SEMVER.test(versionDir.name)) continue;
          const shaParent = join(versionParent, versionDir.name);
          for (const shaDir of await readdir(shaParent, { withFileTypes: true })) {
            if (!shaDir.isDirectory() || shaDir.isSymbolicLink() || !SHA256.test(shaDir.name)) continue;
            const tree = join(shaParent, shaDir.name);
            if (!isReferenced(tree)) await safeRemoveTree(tree);
          }
        }
      }
    }
  }

  report.receiptsPruned = await pruneReceipts(runtimeRoot);
  return report;
}

async function readGenerationRecords(generationRoot: string): Promise<GenerationRecord[]> {
  const records: GenerationRecord[] = [];
  let plugins;
  try {
    plugins = await readdir(generationRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return records;
    throw error;
  }
  for (const plugin of plugins) {
    if (!plugin.isDirectory() || plugin.isSymbolicLink()) continue;
    const directory = join(generationRoot, plugin.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      if (entry.name === 'active.json' || entry.name === 'activation-journal.json') continue;
      const file = join(directory, entry.name);
      let value: Record<string, unknown> | null = null;
      try {
        value = object(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        value = null;
      }
      // Unparseable records are left for the store's own validation.
      if (!value) continue;
      const companions = Array.isArray(value['companions'])
        ? value['companions'].map(object).filter((item): item is Record<string, unknown> => item !== null)
        : [];
      records.push({
        pluginId: plugin.name,
        generationId: entry.name.slice(0, -'.json'.length),
        file,
        value,
        runtime: object(value['runtime']),
        companions,
        removed: false,
      });
    }
  }
  return records;
}

/** If the active pointer references a removed generation, promote the newest
 * surviving one (or drop the pointer) so startup never publishes a dangling
 * active generation. */
async function repairActivePointers(
  generationRoot: string,
  records: GenerationRecord[],
  report: RuntimeLayoutMigrationReport,
): Promise<void> {
  const byPlugin = new Map<string, GenerationRecord[]>();
  for (const record of records) {
    const list = byPlugin.get(record.pluginId) ?? [];
    list.push(record);
    byPlugin.set(record.pluginId, list);
  }
  for (const [pluginId, pluginRecords] of byPlugin) {
    const directory = join(generationRoot, pluginId);
    const removed = new Set(
      pluginRecords.filter(record => record.removed).map(record => record.generationId),
    );
    if (removed.size === 0) continue;
    const journalPath = join(directory, 'activation-journal.json');
    const journal = object(JSON.parse(await readFile(journalPath, 'utf8').then(String).catch(() => 'null')));
    if (journal && typeof journal['generationId'] === 'string' && removed.has(journal['generationId'])) {
      await rm(journalPath, { force: true });
    }
    const pointerPath = join(directory, 'active.json');
    const pointer = object(JSON.parse(await readFile(pointerPath, 'utf8').then(String).catch(() => 'null')));
    if (!pointer || typeof pointer['generationId'] !== 'string' || !removed.has(pointer['generationId'])) continue;
    const activatedAt = typeof pointer['activatedAt'] === 'string'
      ? pointer['activatedAt']
      : new Date().toISOString();
    const winner = pluginRecords
      .filter(record => !record.removed)
      .sort((left, right) => String(right.value['installedAt']).localeCompare(String(left.value['installedAt'])))[0];
    if (!winner) {
      await rm(pointerPath, { force: true });
      await fsyncDirectory(directory);
      report.activationsRepaired.push(pluginId);
      continue;
    }
    for (const record of pluginRecords) {
      if (record.removed) continue;
      const state = record === winner ? 'active' : record.value['state'] === 'active' ? 'retired' : null;
      if (!state) continue;
      record.value['state'] = state;
      record.value['activatedAt'] = state === 'active' ? activatedAt : record.value['activatedAt'];
      await writeFileAtomic(record.file, serialize(record.value));
    }
    await writeFileAtomic(pointerPath, serialize({
      schemaVersion: 1,
      pluginId,
      generationId: winner.generationId,
      activatedAt,
    }));
    await fsyncDirectory(directory);
    report.activationsRepaired.push(pluginId);
  }
}

/** Receipts are keyed by absolute tree directory; drop receipts whose tree no
 * longer exists so a stale key can never bless a different future tree. */
async function pruneReceipts(runtimeRoot: string): Promise<number> {
  const receiptsRoot = join(runtimeRoot, 'receipts');
  const live = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    live.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name));
    }
  };
  let rootEntries;
  try {
    rootEntries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of rootEntries) {
    if (RESERVED_ROOT_ENTRIES.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    await visit(join(runtimeRoot, entry.name));
  }
  let receipts;
  try {
    receipts = await readdir(receiptsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let pruned = 0;
  for (const receipt of receipts) {
    if (!receipt.isFile() || receipt.isSymbolicLink() || !RECEIPT_FILE.test(receipt.name)) continue;
    const path = join(receiptsRoot, receipt.name);
    if ([...live].some(directory => runtimeReceiptPath(runtimeRoot, directory) === path)) continue;
    await rm(path, { force: true });
    pruned++;
  }
  return pruned;
}
