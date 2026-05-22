// Branch parsing helpers extracted from `web/app.ts` so they can be
// exercised by GIT-002 / INV-015 tests without booting createApp.
//
// `listLocalBranches` runs `git for-each-ref refs/heads` with a stable
// formatted line shape and parses the result. `parseTrack` decodes the
// upstream/track segment into `{ ahead, behind, gone }`. Both are pure
// over their inputs; the only impure piece is the subprocess call inside
// `listLocalBranches`. The web route adds Gian-session linkage on top of
// what this module returns.

import { execFileSync } from 'node:child_process';

export interface BranchTrack {
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface LocalBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  lastCommit: { hash: string; subject: string; age: string } | null;
  worktreePath: string | null;
  /** True when the branch was auto-created by a Gian session worktree.
   *  Matches both the new `worktree/*` prefix and the legacy `gian/*`
   *  prefix used in older versions, so historical branches still flag
   *  correctly in the Git panel filter. */
  isWorktreeBranch: boolean;
}

/**
 * Decode the `%(upstream:track)` segment returned by
 * `git for-each-ref` into structured counts. The format is one of:
 *   empty            → no upstream tracking configured
 *   `[gone]`         → upstream branch was deleted
 *   `[ahead N]`      → only ahead
 *   `[behind N]`     → only behind
 *   `[ahead N, behind M]` → both
 */
export function parseTrack(track: string): BranchTrack {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (/\[gone\]/.test(track)) return { ahead: 0, behind: 0, gone: true };
  const aheadM = track.match(/ahead (\d+)/);
  const behindM = track.match(/behind (\d+)/);
  return {
    ahead: aheadM ? parseInt(aheadM[1]!, 10) : 0,
    behind: behindM ? parseInt(behindM[1]!, 10) : 0,
    gone: false,
  };
}

/** ASCII US separator used between for-each-ref format fields. */
const FIELD_SEP = '\x1f';

/**
 * List local branches of `repoPath` with ahead/behind/upstream/worktree
 * metadata. Returns `[]` on any git failure (matches the web route's
 * `try/catch → []` behavior).
 */
export function listLocalBranches(repoPath: string): LocalBranch[] {
  const fmt = [
    '%(refname:short)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(objectname:short)',
    '%(contents:subject)',
    '%(committerdate:relative)',
    '%(worktreepath)',
  ].join(FIELD_SEP);
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', repoPath, 'for-each-ref', '--format=' + fmt, 'refs/heads'], {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseForEachRefLine);
}

/**
 * Exposed for unit tests. Splits one already-fetched `git for-each-ref`
 * line into a `LocalBranch` shape. Total purity — no I/O.
 */
export function parseForEachRefLine(line: string): LocalBranch {
  const [name, upstream, track, sha, subject, age, worktreePath] = line.split(FIELD_SEP);
  const { ahead, behind, gone } = parseTrack(track ?? '');
  return {
    name: name ?? '',
    upstream: upstream || null,
    ahead,
    behind,
    gone,
    lastCommit: sha ? { hash: sha, subject: subject ?? '', age: age ?? '' } : null,
    worktreePath: worktreePath || null,
    isWorktreeBranch:
      (name ?? '').startsWith('worktree/') || (name ?? '').startsWith('gian/'),
  };
}

export interface RemoteBranch {
  fullName: string;
  remote: string;
  branch: string;
  lastCommit: { hash: string; subject: string; age: string };
  hasLocalTracking: boolean;
}

/**
 * Helper used by the `/api/workspaces/:id/remote-branches` route. Pulled
 * out so the filter-by-search + symref-skip behavior can be unit-tested
 * without driving the full route.
 */
export function buildRemoteBranchList(params: {
  rawForEachRef: string;
  localBranchNames: ReadonlySet<string>;
  search?: string;
}): RemoteBranch[] {
  const { rawForEachRef, localBranchNames, search } = params;
  const needle = (search ?? '').trim().toLowerCase();
  return rawForEachRef
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, sha, subject, age, symref] = line.split(FIELD_SEP);
      return {
        name: name ?? '',
        sha: sha ?? '',
        subject: subject ?? '',
        age: age ?? '',
        symref: symref ?? '',
      };
    })
    // Skip symrefs (e.g. `origin/HEAD → origin/main`) and explicit /HEAD entries —
    // they collapse onto the underlying branch and only confuse the picker.
    .filter((r) => r.name && !r.symref && !r.name.endsWith('/HEAD'))
    .map((r) => {
      const slash = r.name.indexOf('/');
      const remote = slash > 0 ? r.name.slice(0, slash) : '';
      const branch = slash > 0 ? r.name.slice(slash + 1) : r.name;
      return {
        fullName: r.name,
        remote,
        branch,
        lastCommit: { hash: r.sha, subject: r.subject, age: r.age },
        hasLocalTracking: localBranchNames.has(branch),
      };
    })
    .filter((r) => !needle || r.fullName.toLowerCase().includes(needle) || r.branch.toLowerCase().includes(needle));
}

/** Format string used to render a remote-branches `for-each-ref` line.
 *  Kept here so test fixtures stay in lockstep with the production format. */
export const REMOTE_BRANCHES_FOR_EACH_REF_FMT = [
  '%(refname:short)',
  '%(objectname:short)',
  '%(contents:subject)',
  '%(committerdate:relative)',
  '%(symref)',
].join(FIELD_SEP);

export { FIELD_SEP };
