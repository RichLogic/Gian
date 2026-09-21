import { lstat } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';

import { isCanonicalAbsolutePath } from '@gian/shared';
import type { RuntimeLease } from './types.js';

const SYSTEM_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function companionPath(binaryPath: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of [dirname(process.execPath), dirname(binaryPath), process.env.PATH, ...SYSTEM_PATHS]) {
    for (const entry of (value ?? '').split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      entries.push(trimmed);
    }
  }
  return entries.join(delimiter);
}

export class SavedPathRuntimeError extends Error {
  readonly code: string;

  constructor(message: string, code = 'RUNTIME_SAVED_PATH_INVALID') {
    super(message);
    this.name = 'SavedPathRuntimeError';
    this.code = code;
  }
}

/**
 * Explicit v2/v3 boundary: accept only a Host-saved canonical absolute
 * regular file. No PATH scan, no `--version`, no installer.
 */
export async function assertSavedAbsoluteRuntimePath(path: string): Promise<void> {
  if (!isCanonicalAbsolutePath(path)) {
    throw new SavedPathRuntimeError('Saved Runtime path must be a canonical absolute path.');
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SavedPathRuntimeError(
        `Saved Runtime path is missing: ${path}`,
        'RUNTIME_SAVED_PATH_MISSING',
      );
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SavedPathRuntimeError('Saved Runtime path must be a regular file.');
  }
}

/** Exact v2/v3 compatibility lease. It carries only the already persisted
 * path and a deterministic companion PATH; it never scans or probes a
 * provider and owns no long-lived mutation claim. */
export async function createSavedPathRuntimeLease(
  path: string,
  version: string,
): Promise<RuntimeLease> {
  await assertSavedAbsoluteRuntimePath(path);
  return {
    binaryPath: path,
    version,
    source: 'override',
    env: Object.freeze({ PATH: companionPath(path) }),
    release: async () => undefined,
  };
}
