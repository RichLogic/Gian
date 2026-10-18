import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../catalog/atomic.js';
import { ManagedRuntimeInstallError } from './errors.js';

interface FileIdentity { path: string; sha256: string; size: number; executable: boolean }
interface ArtifactReceipt {
  schemaVersion: 1;
  artifactSha256: string;
  entryRelativePath: string;
  files: FileIdentity[];
}

/** Every path component must remain a real directory below the managed root.
 * A legacy launcher occupying a candidate directory is absent, not deletable. */
export async function ownedRuntimeDirectory(root: string, path: string): Promise<boolean> {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== path) {
    throw new ManagedRuntimeInstallError('RUNTIME_PATH_OUTSIDE_STORE', 'Runtime recipe escaped its managed root.');
  }
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ManagedRuntimeInstallError('RUNTIME_PATH_OUTSIDE_STORE', 'Runtime directory contains a symlink.');
      }
      if (!info.isDirectory()) return false;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }
  return await realpath(path) === join(await realpath(root), rel);
}

export async function runtimeFileInventory(root: string): Promise<FileIdentity[]> {
  const files: FileIdentity[] = [];
  let total = 0;
  let nodes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error('Runtime tree exceeds the depth limit.');
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++nodes > 100_000) throw new Error('Runtime tree exceeds the entry limit.');
      const path = join(directory, item.name);
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(path, depth + 1);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        total += info.size;
        if (files.length >= 65_536 || total > 768 * 1024 * 1024) throw new Error('Runtime tree exceeds the byte limit.');
        const bytes = await readFile(path);
        files.push({
          path: relative(root, path).split('\\\\').join('/'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          executable: Boolean(info.mode & 0o111),
        });
      } else {
        throw new Error('Runtime tree contains a symlink or special file.');
      }
    }
  };
  await visit(root, 0);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Receipts are keyed by the absolute Runtime tree directory, so a tree move
 * must re-key (not rewrite) its receipt. */
export function runtimeReceiptPath(root: string, directory: string): string {
  const key = createHash('sha256').update(directory).digest('hex');
  return join(root, 'receipts', `${key}.json`);
}

export interface RuntimeArtifactReceipt {
  schemaVersion: 1;
  artifactSha256: string;
  entryRelativePath: string;
  files: FileIdentity[];
}

function parseRuntimeArtifactReceipt(value: unknown): RuntimeArtifactReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as RuntimeArtifactReceipt;
  if (receipt.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(receipt.artifactSha256 ?? '')) return null;
  if (!safeReceiptPath(receipt.entryRelativePath) || !Array.isArray(receipt.files)) return null;
  if (receipt.files.length > 65_536) return null;
  for (const file of receipt.files) {
    if (!file || typeof file !== 'object') return null;
    if (!safeReceiptPath(file.path) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) return null;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.executable !== 'boolean') return null;
  }
  return receipt;
}

function safeReceiptPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1_024
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').some(part => part === '' || part === '.' || part === '..');
}

/** Host-owned install receipt for one generation directory. A missing,
 * swapped, or unbounded receipt is not an identity. */
export async function readRuntimeArtifactReceipt(
  root: string,
  directory: string,
): Promise<RuntimeArtifactReceipt | null> {
  try {
    if (!await ownedRuntimeDirectory(root, directory)) return null;
    if (!await ownedRuntimeDirectory(root, join(root, 'receipts'))) return null;
    const path = runtimeReceiptPath(root, directory);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return null;
    return parseRuntimeArtifactReceipt(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export async function verifiedRuntimeReuse(
  root: string, directory: string, artifactSha256: string, entryRelativePath: string,
): Promise<boolean> {
  if (!await ownedRuntimeDirectory(root, directory)) return false;
  const path = runtimeReceiptPath(root, directory);
  try {
    if (!await ownedRuntimeDirectory(root, join(root, 'receipts'))) return false;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return false;
    const receipt = JSON.parse(await readFile(path, 'utf8')) as ArtifactReceipt;
    if (receipt.schemaVersion !== 1 || receipt.artifactSha256 !== artifactSha256
      || receipt.entryRelativePath !== entryRelativePath || !Array.isArray(receipt.files)) return false;
    const files = await runtimeFileInventory(directory);
    return files.some(file => file.path === entryRelativePath && file.executable)
      && JSON.stringify(files) === JSON.stringify(receipt.files);
  } catch {
    return false;
  }
}

export async function recordRuntimeArtifact(
  root: string, directory: string, artifactSha256: string, entryRelativePath: string,
  files: FileIdentity[],
): Promise<void> {
  const receipts = join(root, 'receipts');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  if (!await ownedRuntimeDirectory(root, receipts)) throw new Error('Runtime receipt root is not owned.');
  const receipt: ArtifactReceipt = { schemaVersion: 1, artifactSha256, entryRelativePath, files };
  await writeFileAtomic(runtimeReceiptPath(root, directory), Buffer.from(JSON.stringify(receipt)));
}

export async function sameRuntimeTree(directory: string, expected: FileIdentity[]): Promise<boolean> {
  try {
    return JSON.stringify(await runtimeFileInventory(directory)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
