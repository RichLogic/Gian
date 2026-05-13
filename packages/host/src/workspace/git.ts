import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const GIT_TIMEOUT = 60_000;

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
 * Run `git worktree add -b <branch> <path> <base>`. Throws on failure.
 * The new branch is created from base; if base doesn't exist, git fails.
 */
export function createWorktree(repo: string, path: string, branch: string, base: string): void {
  git(['worktree', 'add', '-b', branch, path, base], { cwd: repo });
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

/**
 * Remove a worktree (force) and delete its branch. Both operations are
 * tolerant of "already gone" states so callers can use this as a unified
 * cleanup hook.
 */
export function removeWorktree(repo: string, path: string, branch: string): void {
  if (existsSync(path)) {
    git(['worktree', 'remove', '--force', path], { cwd: repo, throwOnError: false });
    // If git refused (e.g. metadata mismatch), nuke the dir directly.
    if (existsSync(path)) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }
  // Prune stale worktree metadata before trying to delete the branch —
  // git refuses `branch -D` if the worktree is still considered active.
  git(['worktree', 'prune'], { cwd: repo, throwOnError: false });
  git(['branch', '-D', branch], { cwd: repo, throwOnError: false });
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
