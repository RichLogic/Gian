import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function gitBranchAt(path: string): string | null {
  try {
    const out = execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch { return null; }
}

/**
 * Detect "I'm in the middle of an operation" states that leave the index in
 * a half-baked spot — typically because a merge/rebase/cherry-pick hit
 * conflicts. We surface this in the UI so the user knows why their tools
 * are stuck instead of silently working on a poisoned tree.
 */
export function gitPendingOpAt(path: string):
  | { kind: 'merge'; mergeHead: string }
  | { kind: 'rebase' }
  | { kind: 'cherry-pick'; head: string }
  | { kind: 'revert'; head: string }
  | null {
  function tryRevParse(ref: string): string | null {
    try {
      const out = execFileSync('git', ['-C', path, 'rev-parse', '--verify', '--quiet', ref], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } catch { return null; }
  }
  const merge = tryRevParse('MERGE_HEAD');
  if (merge) return { kind: 'merge', mergeHead: merge };
  // `rebase-merge` (interactive / merge backend) and `rebase-apply` (am)
  // are directories under .git, not refs. Easiest probe is `git status
  // --porcelain=v2` header lines, but checking the filesystem is faster.
  try {
    const gitDir = execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], {
      timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (gitDir) {
      const dir = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
      if (existsSync(resolve(dir, 'rebase-merge')) || existsSync(resolve(dir, 'rebase-apply'))) {
        return { kind: 'rebase' };
      }
    }
  } catch { /* swallow — non-rebase path falls through */ }
  const cherry = tryRevParse('CHERRY_PICK_HEAD');
  if (cherry) return { kind: 'cherry-pick', head: cherry };
  const revert = tryRevParse('REVERT_HEAD');
  if (revert) return { kind: 'revert', head: revert };
  return null;
}

export function gitInfoAt(path: string): {
  isRepo: boolean;
  remote: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  lastCommit: { hash: string; message: string; age: string } | null;
  modifiedCount: number;
  pendingOp: ReturnType<typeof gitPendingOpAt>;
} {
  function safe(args: string[]): string | null {
    try {
      return execFileSync('git', ['-C', path, ...args], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  }
  const inside = safe(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return {
      isRepo: false, remote: null, defaultBranch: null,
      currentBranch: null, lastCommit: null, modifiedCount: 0, pendingOp: null,
    };
  }
  const remote = safe(['remote', 'get-url', 'origin']);
  let remoteHuman: string | null = null;
  if (remote) {
    // git@github.com:user/repo.git → github.com/user/repo
    // https://github.com/user/repo.git → github.com/user/repo
    remoteHuman = remote
      .replace(/^git@([^:]+):/, '$1/')
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '');
  }
  const defaultBranchRaw = safe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = defaultBranchRaw ? defaultBranchRaw.replace(/^origin\//, '') : null;
  const currentBranch = gitBranchAt(path);
  const last = safe(['log', '-1', '--format=%h\x1f%s\x1f%cr']);
  let lastCommit: { hash: string; message: string; age: string } | null = null;
  if (last) {
    const [hash, message, age] = last.split('\x1f');
    if (hash && message && age) lastCommit = { hash, message, age };
  }
  const status = safe(['status', '--porcelain']);
  const modifiedCount = status ? status.split('\n').filter(l => l.trim()).length : 0;
  const pendingOp = gitPendingOpAt(path);
  return { isRepo: true, remote: remoteHuman, defaultBranch, currentBranch, lastCommit, modifiedCount, pendingOp };
}

export function claudeMdInfoAt(path: string): { exists: boolean; lines: number; mtime: string | null } {
  try {
    const file = resolve(path, 'CLAUDE.md');
    const content = readFileSync(file, 'utf8');
    const stat = statSync(file);
    return { exists: true, lines: content.split('\n').length, mtime: stat.mtime.toISOString() };
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


