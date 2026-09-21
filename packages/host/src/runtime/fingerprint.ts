import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { isCanonicalAbsolutePath } from '@gian/shared';

import {
  assertAuthorizedFilesystemIdentity,
  authorizedConfigHomeDir,
  ConfigHomeIdentityError,
  isAuthorizedConfigHome,
} from './config-home.js';

export const MAX_RUNTIME_FINGERPRINT_FILES = 4_096;
export const MAX_RUNTIME_FINGERPRINT_BYTES = 64 * 1024 * 1024;
// A user-selected standalone CLI (e.g. Claude/Kimi) can embed its runtime.
// Give that one file its own bounded streaming budget; directory/content
// traversal still shares the smaller aggregate budget below.
export const MAX_RUNTIME_LAUNCHER_BYTES = 512 * 1024 * 1024;
export const MAX_RUNTIME_FINGERPRINT_ENTRIES = 8_192;
export const MAX_RUNTIME_FINGERPRINT_DEPTH = 8;

type FingerprintBudget = { files: number; bytes: number; entries: number; maxBytes?: number };

export type RuntimeContentRoot = {
  path: string;
  mode: 'file' | 'directory';
};

export class RuntimeFingerprintError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeFingerprintError';
    this.code = code;
  }
}

function assertCanonicalPath(path: string, label: string): void {
  if (!isCanonicalAbsolutePath(path)) {
    throw new RuntimeFingerprintError(
      'RUNTIME_ROOT_INVALID',
      `${label} must be a canonical absolute path.`,
    );
  }
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !relativePath.startsWith('..'));
}

function anchorsFor(selectedPath: string, configHome: string | null): string[] {
  const anchors = [selectedPath, dirname(selectedPath)];
  if (configHome) anchors.push(configHome);
  return anchors;
}

function isAnchored(rootPath: string, selectedPath: string, configHome: string | null): boolean {
  return anchorsFor(selectedPath, configHome).some((anchor) => (
    rootPath === anchor || isContained(anchor, rootPath)
  ));
}

function countEntry(budget: FingerprintBudget): void {
  budget.entries += 1;
  if (budget.entries > MAX_RUNTIME_FINGERPRINT_ENTRIES) {
    throw new RuntimeFingerprintError(
      'RUNTIME_FINGERPRINT_BUDGET',
      `Runtime content exceeded the ${MAX_RUNTIME_FINGERPRINT_ENTRIES} entry budget.`,
    );
  }
}

function assertSameIdentity(before: Stats, after: Stats, path: string): void {
  if (after.ino !== before.ino || after.dev !== before.dev) {
    throw new RuntimeFingerprintError(
      'RUNTIME_ROOT_INVALID',
      `Runtime content was retargeted: ${path}`,
    );
  }
}

async function hashRegularFile(
  path: string,
  expected: Stats,
  budget: FingerprintBudget,
): Promise<{ digest: string; bytes: number }> {
  const maxBytes = budget.maxBytes ?? MAX_RUNTIME_FINGERPRINT_BYTES;
  if (expected.size > maxBytes - budget.bytes) {
    throw new RuntimeFingerprintError(
      'RUNTIME_FINGERPRINT_BUDGET',
      `Runtime content exceeded the ${maxBytes} byte budget.`,
    );
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const after = await handle.stat();
    if (!after.isFile()) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_INVALID',
        `Runtime content root is not a regular file: ${path}`,
      );
    }
    assertSameIdentity(expected, after, path);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      if (budget.bytes + bytes > maxBytes) {
        throw new RuntimeFingerprintError(
          'RUNTIME_FINGERPRINT_BUDGET',
          `Runtime content exceeded the ${maxBytes} byte budget.`,
        );
      }
      hash.update(buffer);
    }
    const final = await handle.stat();
    assertSameIdentity(expected, final, path);
    return { digest: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}

async function assertStableDirectory(path: string, expected: Stats): Promise<void> {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_DIRECTORY ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const after = await handle.stat();
    if (!after.isDirectory()) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_INVALID',
        `Runtime directory root must be a regular directory: ${path}`,
      );
    }
    assertSameIdentity(expected, after, path);
  } finally {
    await handle.close();
  }
}

async function walkDirectory(
  root: string,
  current: string,
  depth: number,
  budget: FingerprintBudget,
  parts: string[],
): Promise<void> {
  if (depth > MAX_RUNTIME_FINGERPRINT_DEPTH) {
    throw new RuntimeFingerprintError(
      'RUNTIME_FINGERPRINT_BUDGET',
      `Runtime content exceeded the depth budget of ${MAX_RUNTIME_FINGERPRINT_DEPTH}.`,
    );
  }
  const dirInfo = await lstat(current);
  await assertStableDirectory(current, dirInfo);
  const entries = (await readdir(current)).sort((left, right) => left.localeCompare(right));
  const afterList = await lstat(current);
  assertSameIdentity(dirInfo, afterList, current);
  for (const name of entries) {
    const child = resolve(current, name);
    if (!isContained(root, child) || !isCanonicalAbsolutePath(child)) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_ESCAPE',
        `Runtime content root escaped its declared directory: ${child}`,
      );
    }
    const info = await lstat(child);
    if (info.isSymbolicLink() || info.isSocket() || info.isFIFO() || info.isCharacterDevice() || info.isBlockDevice()) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_INVALID',
        `Runtime content root contains a rejected special path: ${child}`,
      );
    }
    countEntry(budget);
    if (info.isDirectory()) {
      parts.push(`dir:${relative(root, child) || '.'}`);
      await walkDirectory(root, child, depth + 1, budget, parts);
      continue;
    }
    if (!info.isFile()) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_INVALID',
        `Runtime content root is not a regular file: ${child}`,
      );
    }
    budget.files += 1;
    if (budget.files > MAX_RUNTIME_FINGERPRINT_FILES) {
      throw new RuntimeFingerprintError(
        'RUNTIME_FINGERPRINT_BUDGET',
        `Runtime content exceeded the ${MAX_RUNTIME_FINGERPRINT_FILES} file budget.`,
      );
    }
    const { digest, bytes } = await hashRegularFile(child, info, budget);
    budget.bytes += bytes;
    if (budget.bytes > MAX_RUNTIME_FINGERPRINT_BYTES) {
      throw new RuntimeFingerprintError(
        'RUNTIME_FINGERPRINT_BUDGET',
        `Runtime content exceeded the ${MAX_RUNTIME_FINGERPRINT_BYTES} byte budget.`,
      );
    }
    parts.push(`file:${relative(root, child)}:${info.size}:${digest}`);
  }
}

async function fingerprintRoot(
  root: RuntimeContentRoot,
  selectedPath: string,
  allowSelectedLauncherSymlink: boolean,
  budget: FingerprintBudget,
): Promise<string[]> {
  let info: Stats;
  try {
    info = await lstat(root.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_MISSING',
        `Runtime content root is missing: ${root.path}`,
      );
    }
    throw error;
  }
  if (info.isSocket() || info.isFIFO() || info.isCharacterDevice() || info.isBlockDevice()) {
    throw new RuntimeFingerprintError(
      'RUNTIME_ROOT_INVALID',
      `Runtime content root is a special file: ${root.path}`,
    );
  }
  if (root.mode === 'file') {
    if (info.isSymbolicLink()) {
      if (!allowSelectedLauncherSymlink || root.path !== selectedPath) {
        throw new RuntimeFingerprintError(
          'RUNTIME_ROOT_INVALID',
          `Runtime content root must not be a symlink: ${root.path}`,
        );
      }
      const resolved = await realpath(root.path);
      const resolvedInfo = await lstat(resolved);
      if (!resolvedInfo.isFile() || resolvedInfo.isSymbolicLink()) {
        throw new RuntimeFingerprintError(
          'RUNTIME_ROOT_INVALID',
          `Selected Runtime launcher does not resolve to a regular file: ${root.path}`,
        );
      }
      budget.files += 1;
      if (budget.files > MAX_RUNTIME_FINGERPRINT_FILES) {
        throw new RuntimeFingerprintError(
          'RUNTIME_FINGERPRINT_BUDGET',
          `Runtime content exceeded the ${MAX_RUNTIME_FINGERPRINT_FILES} file budget.`,
        );
      }
      const { digest, bytes } = await hashRegularFile(resolved, resolvedInfo, budget);
      budget.bytes += bytes;
      return [`launcher:${root.path}:${info.mode}:${info.size}:${digest}`];
    }
    if (!info.isFile()) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_INVALID',
        `Runtime file root is not a regular file: ${root.path}`,
      );
    }
    budget.files += 1;
    if (budget.files > MAX_RUNTIME_FINGERPRINT_FILES) {
      throw new RuntimeFingerprintError(
        'RUNTIME_FINGERPRINT_BUDGET',
        `Runtime content exceeded the ${MAX_RUNTIME_FINGERPRINT_FILES} file budget.`,
      );
    }
    countEntry(budget);
    const { digest, bytes } = await hashRegularFile(root.path, info, budget);
    budget.bytes += bytes;
    return [`file:${root.path}:${info.size}:${digest}`];
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RuntimeFingerprintError(
      'RUNTIME_ROOT_INVALID',
      `Runtime directory root must be a regular directory: ${root.path}`,
    );
  }
  countEntry(budget);
  const parts = [`dir:${root.path}`];
  await walkDirectory(root.path, root.path, 0, budget, parts);
  return parts;
}

export async function hostRuntimeFingerprint(input: {
  selectedPath: string;
  configHome: string | null;
  contentRoots: readonly RuntimeContentRoot[];
  homeDir?: string;
}): Promise<string> {
  assertCanonicalPath(input.selectedPath, 'selected Runtime path');
  const homeDir = input.homeDir ?? authorizedConfigHomeDir();
  if (input.configHome !== null) {
    assertCanonicalPath(input.configHome, 'configHome');
    if (!isAuthorizedConfigHome(input.configHome, input.selectedPath, homeDir)) {
      throw new RuntimeFingerprintError(
        'RUNTIME_CONFIG_HOME_INVALID',
        'configHome must be a Host-authorized user or config location.',
      );
    }
    try {
      await assertAuthorizedFilesystemIdentity(input.configHome, input.selectedPath, homeDir);
    } catch (error) {
      throw new RuntimeFingerprintError(
        'RUNTIME_CONFIG_HOME_INVALID',
        error instanceof ConfigHomeIdentityError
          ? error.message
          : 'configHome escaped its authorized identity roots.',
      );
    }
  }
  if (input.contentRoots.length === 0) {
    throw new RuntimeFingerprintError('RUNTIME_ROOT_INVALID', 'Runtime probe must declare at least one content root.');
  }
  const seen = new Set<string>();
  const sorted = [...input.contentRoots].sort((left, right) => left.path.localeCompare(right.path));
  const parts: string[] = [];
  const budget = { files: 0, bytes: 0, entries: 0 };
  for (const root of sorted) {
    assertCanonicalPath(root.path, 'content root');
    if (seen.has(root.path)) {
      throw new RuntimeFingerprintError('RUNTIME_ROOT_INVALID', `Duplicate Runtime content root: ${root.path}`);
    }
    seen.add(root.path);
    if (!isAnchored(root.path, input.selectedPath, input.configHome)) {
      throw new RuntimeFingerprintError(
        'RUNTIME_ROOT_ESCAPE',
        `Runtime content root is not anchored to the selected Runtime or config home: ${root.path}`,
      );
    }
    const isSelectedLauncher = root.path === input.selectedPath && root.mode === 'file';
    if (!isSelectedLauncher) {
      try {
        await assertAuthorizedFilesystemIdentity(root.path, input.selectedPath, homeDir);
      } catch (error) {
        throw new RuntimeFingerprintError(
          'RUNTIME_ROOT_ESCAPE',
          error instanceof ConfigHomeIdentityError
            ? error.message
            : `Runtime content root escaped its authorized identity roots: ${root.path}`,
        );
      }
    }
    const rootBudget = isSelectedLauncher
      ? { files: 0, bytes: 0, entries: 0, maxBytes: MAX_RUNTIME_LAUNCHER_BYTES }
      : budget;
    parts.push(...await fingerprintRoot(root, input.selectedPath, true, rootBudget));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
