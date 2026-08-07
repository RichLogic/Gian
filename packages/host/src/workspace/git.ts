import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const GIT_TIMEOUT = 60_000;
const execFileAsync = promisify(execFile);

interface ExecOpts {
  cwd?: string;
  /** Throw on non-zero exit. Default true. */
  throwOnError?: boolean;
}

function git(args: string[], opts: ExecOpts = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      timeout: GIT_TIMEOUT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (opts.throwOnError === false) return '';
    throw err;
  }
}

/**
 * Detect the default branch of `repo`. Tries, in order:
 *   1. origin/HEAD symref (the canonical answer if there's a remote)
 *   2. presence of `main` or `master` locally
 *   3. fallback: 'main'
 */
export function detectDefaultBranch(repo: string): string {
  try {
    const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo });
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  } catch { /* no remote — try local */ }

  for (const candidate of ['main', 'master']) {
    const out = git(['rev-parse', '--verify', candidate], { cwd: repo, throwOnError: false });
    if (out) return candidate;
  }
  return 'main';
}

/**
 * Merge `branch` into the current branch of `repo`. Uses --no-ff so the
 * merge always shows up in history. Caller chooses where to run this
 * (typically the workspace root, on the base branch).
 *
 * Returns nothing on success; throws on conflict / failure with stderr
 * captured in err.message.
 */
export function mergeBranch(repo: string, branch: string, base: string): void {
  // Make sure we're on the base branch first.
  git(['checkout', base], { cwd: repo });
  git(['merge', '--no-ff', branch], { cwd: repo });
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
 * separated by blank lines.
 */
export function parseWorktreeListPorcelain(out: string): GitWorktreeInfo[] {
  const result: GitWorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string | null } = {};
  const flush = (): void => {
    if (current.path) {
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
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return result;
}

/**
 * List every worktree of the repo at `repoPath` (main tree first, then
 * linked worktrees) via `git worktree list --porcelain`. Returns [] for a
 * non-repo / git failure — callers treat discovery as best-effort.
 */
export function listGitWorktrees(repoPath: string): GitWorktreeInfo[] {
  const out = git(['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    throwOnError: false,
  });
  if (!out) return [];
  return parseWorktreeListPorcelain(out);
}

/** Non-blocking variant for request paths that fan out across workspaces. */
export async function listGitWorktreesAsync(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      timeout: GIT_TIMEOUT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout ? parseWorktreeListPorcelain(stdout.trim()) : [];
  } catch {
    return [];
  }
}

/** True if `repo` is the toplevel of a git working tree. */
export function isGitRepo(repo: string): boolean {
  try {
    const out = git(['rev-parse', '--show-toplevel'], { cwd: repo });
    return out.length > 0;
  } catch {
    return false;
  }
}
