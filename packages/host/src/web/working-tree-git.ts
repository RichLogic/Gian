import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runGit } from '../workspace/async-command.js';

export type GitPendingOperation =
  | { kind: 'merge'; mergeHead: string }
  | { kind: 'rebase' }
  | { kind: 'cherry-pick'; head: string }
  | { kind: 'revert'; head: string }
  | null;

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectResult(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolveResult(value)),
      error => finish(() => rejectResult(error)),
    );
  });
}

async function safeGit(
  path: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, {
      cwd: path,
      timeoutMs: 2_000,
      ...(signal ? { signal } : {}),
    });
    return stdout.trim();
  } catch (error) {
    // Read-only repo discovery tolerates ordinary Git failures, but request
    // cancellation must stop the multi-probe pending-operation scan instead
    // of starting each remaining subprocess while the mutation lock is held.
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function gitBranchAtAsync(path: string): Promise<string | null> {
  return (await safeGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null;
}

export async function gitPendingOpAtAsync(
  path: string,
  signal?: AbortSignal,
): Promise<GitPendingOperation> {
  const merge = await safeGit(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], signal);
  if (merge) return { kind: 'merge', mergeHead: merge };

  const gitDir = await safeGit(path, ['rev-parse', '--git-dir'], signal);
  if (gitDir) {
    const dir = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
    try {
      await withAbort(
        Promise.any([
          access(resolve(dir, 'rebase-merge')),
          access(resolve(dir, 'rebase-apply')),
        ]),
        signal,
      );
      return { kind: 'rebase' };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Neither rebase state directory exists.
    }
  }

  const cherry = await safeGit(
    path,
    ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'],
    signal,
  );
  if (cherry) return { kind: 'cherry-pick', head: cherry };
  const revert = await safeGit(
    path,
    ['rev-parse', '--verify', '--quiet', 'REVERT_HEAD'],
    signal,
  );
  if (revert) return { kind: 'revert', head: revert };
  return null;
}

export async function gitInfoAtAsync(path: string): Promise<{
  isRepo: boolean;
  remote: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  lastCommit: { hash: string; message: string; age: string } | null;
  modifiedCount: number;
  pendingOp: GitPendingOperation;
}> {
  const inside = await safeGit(path, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return {
      isRepo: false, remote: null, defaultBranch: null,
      currentBranch: null, lastCommit: null, modifiedCount: 0, pendingOp: null,
    };
  }

  const [remote, defaultBranchRaw, currentBranch, last, status, pendingOp] = await Promise.all([
    safeGit(path, ['remote', 'get-url', 'origin']),
    safeGit(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    gitBranchAtAsync(path),
    safeGit(path, ['log', '-1', '--format=%h\x1f%s\x1f%cr']),
    safeGit(path, ['status', '--porcelain']),
    gitPendingOpAtAsync(path),
  ]);

  const remoteHuman = remote
    ? remote
      .replace(/^git@([^:]+):/, '$1/')
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '')
    : null;
  const defaultBranch = defaultBranchRaw
    ? defaultBranchRaw.replace(/^origin\//, '')
    : null;
  let lastCommit: { hash: string; message: string; age: string } | null = null;
  if (last) {
    const [hash, message, age] = last.split('\x1f');
    if (hash && message && age) lastCommit = { hash, message, age };
  }
  const modifiedCount = status ? status.split('\n').filter(line => line.trim()).length : 0;
  return {
    isRepo: true,
    remote: remoteHuman,
    defaultBranch,
    currentBranch,
    lastCommit,
    modifiedCount,
    pendingOp,
  };
}

export async function claudeMdInfoAtAsync(path: string): Promise<{ exists: boolean; lines: number; mtime: string | null }> {
  try {
    const file = resolve(path, 'CLAUDE.md');
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { exists: true, lines: content.split('\n').length, mtime: info.mtime.toISOString() };
  } catch {
    return { exists: false, lines: 0, mtime: null };
  }
}

// Working-tree id for an EXTERNAL worktree (created outside Gian, discovered
// via `git worktree list`): ext:<workspaceId>:<base64url(abs path)>. The id
// is stateless — resolveWorkingTree re-validates membership against git on
// every call, so a removed worktree's id simply stops resolving.
export function extTreeId(workspaceId: string, path: string): string {
  return `ext:${workspaceId}:${Buffer.from(path, 'utf8').toString('base64url')}`;
}
