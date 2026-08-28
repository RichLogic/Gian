import { runGit, withRepoMutationLock } from './async-command.js';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const GIT_READ_TIMEOUT = 5_000;
const GIT_MUTATION_TIMEOUT = 60_000;

/**
 * Detect the default compare branch of `repo`. Tries, in order:
 *   1. origin/HEAD symref (the canonical answer if there's a remote)
 *   2. presence of `origin/main` or `origin/master`
 *   3. presence of `main` or `master` locally
 *   4. fallback: 'main'
 * Runs without blocking the Host request/event loop.
 */
export async function detectDefaultBranchAsync(repo: string): Promise<string> {
  try {
    const { stdout } = await runGit(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repo, timeoutMs: GIT_READ_TIMEOUT },
    );
    const ref = stdout.trim();
    if (ref.startsWith('origin/')) return ref;
  } catch {
    // No remote HEAD — probe the conventional local branches below.
  }

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--verify', candidate],
        { cwd: repo, timeoutMs: GIT_READ_TIMEOUT },
      );
      if (stdout.trim()) return candidate;
    } catch {
      // Candidate is absent.
    }
  }
  return 'main';
}

/**
 * Merge `branch` into the current branch of `repo`. Uses --no-ff so the
 * merge always shows up in history. Caller chooses where to run this
 * (typically the workspace root, on the base branch).
 *
 * Throws on conflict / failure with stderr captured in err.message.
 */
export async function mergeBranchAsync(
  repo: string,
  branch: string,
  base: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await withRepoMutationLock(repo, async () => {
    await runGit(
      ['checkout', base],
      { cwd: repo, timeoutMs: GIT_MUTATION_TIMEOUT, ...options },
    );
    await runGit(
      ['merge', '--no-ff', branch],
      { cwd: repo, timeoutMs: GIT_MUTATION_TIMEOUT, ...options },
    );
  }, options);
}

export interface GitWorktreeInfo {
  /** Absolute path of the worktree (main tree included). */
  path: string;
  /** Short branch name, or null when HEAD is detached (or bare). */
  branch: string | null;
  /** HEAD commit SHA ('' for a bare entry). */
  head: string;
}

/**
 * Parse `git worktree list --porcelain` output. Exported for tests; the
 * record grammar is one block per worktree:
 *   worktree <path>
 *   HEAD <sha>
 *   branch refs/heads/<name>   |   detached   |   bare
 *   prunable <reason>          (stale registration; omitted from results)
 * separated by blank lines.
 */
export function parseWorktreeListPorcelain(out: string): GitWorktreeInfo[] {
  const result: GitWorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string | null; prunable?: boolean } = {};
  const flush = (): void => {
    if (current.path && !current.prunable) {
      result.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
      });
    }
    current = {};
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref;
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return result;
}

/**
 * List every worktree without blocking. Returns [] for a non-repo / git
 * failure because discovery callers treat it as best-effort.
 */
export async function listGitWorktreesAsync(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await runGit(['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      timeoutMs: GIT_READ_TIMEOUT,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    return stdout ? parseWorktreeListPorcelain(stdout.trim()) : [];
  } catch {
    return [];
  }
}

/** Non-blocking repository probe for request paths. */
export async function isGitRepoAsync(repo: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(
      ['rev-parse', '--show-toplevel'],
      { cwd: repo, timeoutMs: GIT_READ_TIMEOUT },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export type GitWorktreeCreateFailure =
  | 'invalid-base'
  | 'invalid-branch'
  | 'path-conflict'
  | 'repository-conflict';

export class GitWorktreeCreateError extends Error {
  constructor(
    readonly kind: GitWorktreeCreateFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GitWorktreeCreateError';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a linked checkout under a caller-owned managed root. The complete
 *  validate/inspect/add sequence holds the repository mutation lock so two
 *  Host requests cannot select the same branch or target concurrently. */
export async function createGitWorktreeAsync(input: {
  repoPath: string;
  managedRoot: string;
  directoryName: string;
  branch: string;
  baseRef: string;
  signal?: AbortSignal;
}): Promise<{ path: string; branch: string; baseRef: string; created: boolean }> {
  return withRepoMutationLock(input.repoPath, async () => {
    try {
      await runGit(['check-ref-format', '--branch', input.branch], {
        cwd: input.repoPath,
        timeoutMs: GIT_READ_TIMEOUT,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new GitWorktreeCreateError('invalid-branch', `Invalid Git branch: ${input.branch}`);
    }
    if (input.baseRef.startsWith('-') || /[\0\r\n]/.test(input.baseRef)) {
      throw new GitWorktreeCreateError('invalid-base', 'Invalid Git base revision');
    }
    let baseCommit: string;
    try {
      baseCommit = (await runGit(
        ['rev-parse', '--verify', '--end-of-options', `${input.baseRef}^{commit}`],
        {
          cwd: input.repoPath,
          timeoutMs: GIT_READ_TIMEOUT,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      )).stdout.trim();
    } catch {
      throw new GitWorktreeCreateError(
        'invalid-base',
        `Git base revision does not exist: ${input.baseRef}`,
      );
    }

    await mkdir(input.managedRoot, { recursive: true });
    const current = await listGitWorktreesAsync(input.repoPath);
    const existingBranch = current.find(worktree => worktree.branch === input.branch);
    if (existingBranch) {
      const existingName = basename(existingBranch.path);
      const managedName = existingName === input.directoryName
        || new RegExp(`^${input.directoryName}-(?:[2-9]|[1-9][0-9]+)$`).test(existingName);
      if (
        dirname(existingBranch.path) === input.managedRoot
        && managedName
      ) {
        return {
          path: existingBranch.path,
          branch: input.branch,
          baseRef: input.baseRef,
          created: false,
        };
      }
      throw new GitWorktreeCreateError(
        'repository-conflict',
        `Branch is already checked out in another worktree: ${input.branch}`,
      );
    }

    const registeredPaths = new Set(current.map(worktree => worktree.path));
    let target = join(input.managedRoot, input.directoryName);
    for (let suffix = 2; registeredPaths.has(target) || await pathExists(target); suffix += 1) {
      if (suffix > 100) {
        throw new GitWorktreeCreateError('path-conflict', 'No managed worktree directory is available');
      }
      target = join(input.managedRoot, `${input.directoryName}-${suffix}`);
    }

    let localBranchCommit: string | null = null;
    try {
      localBranchCommit = (await runGit(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${input.branch}^{commit}`],
        {
          cwd: input.repoPath,
          timeoutMs: GIT_READ_TIMEOUT,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      )).stdout.trim();
    } catch {
      // A missing local branch is the normal new-worktree path.
    }
    if (localBranchCommit && localBranchCommit !== baseCommit) {
      throw new GitWorktreeCreateError(
        'repository-conflict',
        `Branch already exists at another commit: ${input.branch}`,
      );
    }

    try {
      await runGit(
        localBranchCommit
          ? ['worktree', 'add', target, input.branch]
          : ['worktree', 'add', '-b', input.branch, target, input.baseRef],
        {
          cwd: input.repoPath,
          timeoutMs: GIT_MUTATION_TIMEOUT,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch {
      throw new GitWorktreeCreateError(
        'repository-conflict',
        `Git could not create worktree for branch: ${input.branch}`,
      );
    }
    const created = (await listGitWorktreesAsync(input.repoPath)).find(worktree => (
      worktree.path === target && worktree.branch === input.branch
    ));
    if (!created) {
      throw new GitWorktreeCreateError(
        'repository-conflict',
        'Git did not register the managed worktree',
      );
    }
    return { path: target, branch: input.branch, baseRef: input.baseRef, created: true };
  }, { ...(input.signal ? { signal: input.signal } : {}) });
}
