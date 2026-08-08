import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const activeWorkspaceTargets = new Map<string, symbol>();
export const WORKSPACE_PATH_RESERVATION_TIMEOUT_MS = 5_000;

export class WorkspacePathReservationError extends Error {
  constructor() {
    super('workspace path initialization is already in progress');
    this.name = 'WorkspacePathReservationError';
  }
}

export type WorkspacePathResolutionFailure = 'timed_out' | 'aborted';

export class WorkspacePathResolutionError extends Error {
  constructor(readonly reason: WorkspacePathResolutionFailure) {
    super(reason === 'timed_out'
      ? 'workspace path resolution timed out'
      : 'workspace path resolution was aborted');
    this.name = 'WorkspacePathResolutionError';
  }
}

export interface WorkspacePathReservationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function realpathBefore(
  path: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new WorkspacePathResolutionError('aborted'));
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new WorkspacePathResolutionError('timed_out'));
  }
  const operation = realpath(path);
  return new Promise<string>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => rejectResult(new WorkspacePathResolutionError('aborted')));
    };
    const timer = setTimeout(
      () => finish(() => rejectResult(new WorkspacePathResolutionError('timed_out'))),
      remainingMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolveResult(value)),
      error => finish(() => rejectResult(error)),
    );
  });
}

async function canonicalWorkspaceTarget(
  path: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existingAncestor = await realpathBefore(cursor, deadlineAt, signal);
      return join(existingAncestor, ...missingSegments);
    } catch (error) {
      if (error instanceof WorkspacePathResolutionError) throw error;
      // Only a genuinely missing path component may be rebuilt beneath its
      // nearest existing ancestor. Permission, symlink-loop, and I/O errors
      // mean the filesystem identity is unknown and must fail closed.
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Resolve a workspace path to its filesystem identity. Existing symlinks are
 * collapsed through realpath; missing suffixes are rebuilt beneath the nearest
 * existing canonical ancestor so freshly provisioned targets are stable too. */
export async function canonicalWorkspacePath(
  path: string,
  options: WorkspacePathReservationOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? WORKSPACE_PATH_RESERVATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  return canonicalWorkspaceTarget(path, Date.now() + timeoutMs, options.signal);
}

/**
 * Fail-fast, process-local reservation for workspace provisioning/adoption.
 * The token-aware release cannot accidentally clear a later owner's entry.
 */
export async function reserveWorkspacePath(
  path: string,
  options: WorkspacePathReservationOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? WORKSPACE_PATH_RESERVATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  const deadlineAt = Date.now() + timeoutMs;
  const key = await canonicalWorkspaceTarget(path, deadlineAt, options.signal);
  if (options.signal?.aborted) throw new WorkspacePathResolutionError('aborted');
  if (Date.now() >= deadlineAt) throw new WorkspacePathResolutionError('timed_out');
  if (activeWorkspaceTargets.has(key)) {
    throw new WorkspacePathReservationError();
  }
  const token = Symbol(key);
  activeWorkspaceTargets.set(key, token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeWorkspaceTargets.get(key) === token) {
      activeWorkspaceTargets.delete(key);
    }
  };
}
