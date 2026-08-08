import { runGit, withRepoMutationLock } from './async-command.js';

const GIT_READ_TIMEOUT = 5_000;
const GIT_MUTATION_TIMEOUT = 60_000;

/**
 * Detect the default branch of `repo`. Tries, in order:
 *   1. origin/HEAD symref (the canonical answer if there's a remote)
 *   2. presence of `main` or `master` locally
 *   3. fallback: 'main'
 * Runs without blocking the Host request/event loop.
 */
export async function detectDefaultBranchAsync(repo: string): Promise<string> {
  try {
    const { stdout } = await runGit(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repo, timeoutMs: GIT_READ_TIMEOUT },
    );
    const ref = stdout.trim();
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  } catch {
    // No remote HEAD — probe the conventional local branches below.
  }

  for (const candidate of ['main', 'master']) {
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
