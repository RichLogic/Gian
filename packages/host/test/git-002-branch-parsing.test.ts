// Coverage for traceability rows:
//   GIT-002 — `/api/workspaces/:id/branches` and
//             `/api/workspaces/:id/remote-branches` must compute
//             ahead/behind/gone, worktreePath, isWorktreeBranch, remote
//             HEAD filtering, and local-tracking detection correctly.
//   INV-015 — Branch parsing must stay stable across main + worktree +
//             session-owned branch shapes (`worktree/*`, legacy `gian/*`).
//
// We test `workspace/git-branches.ts` directly: pure parsers
// (`parseTrack`, `parseForEachRefLine`, `buildRemoteBranchList`) plus a
// `listLocalBranches` end-to-end against a real git fixture. The route
// wrappers in `web/app.ts` are thin and add only the session-table JOIN
// on top — that piece is covered by WT-001 already.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseTrack,
  parseForEachRefLine,
  buildRemoteBranchList,
  listLocalBranches,
  FIELD_SEP,
} from '../src/workspace/git-branches.js';
import { realpathSync } from 'node:fs';
import { createGitRepo, bareUpstream } from './fixtures/git-repo.js';

// ---------------------------------------------------------------------------
// parseTrack — covers every shape `%(upstream:track)` produces
// ---------------------------------------------------------------------------

test('GIT-002: parseTrack returns zeros for an empty / no-upstream segment', () => {
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
});

test('GIT-002: parseTrack flags `[gone]` upstream (deleted remote branch)', () => {
  assert.deepEqual(parseTrack('[gone]'), { ahead: 0, behind: 0, gone: true });
});

test('GIT-002: parseTrack reads ahead/behind counts in either order', () => {
  assert.deepEqual(parseTrack('[ahead 3]'),               { ahead: 3, behind: 0, gone: false });
  assert.deepEqual(parseTrack('[behind 5]'),              { ahead: 0, behind: 5, gone: false });
  assert.deepEqual(parseTrack('[ahead 7, behind 2]'),     { ahead: 7, behind: 2, gone: false });
  assert.deepEqual(parseTrack('[behind 2, ahead 7]'),     { ahead: 7, behind: 2, gone: false });
});

test('GIT-002: parseTrack handles double-digit counts', () => {
  assert.deepEqual(parseTrack('[ahead 42, behind 1234]'), { ahead: 42, behind: 1234, gone: false });
});

// ---------------------------------------------------------------------------
// parseForEachRefLine — covers prefix + worktreepath columns
// ---------------------------------------------------------------------------

function refLine(parts: {
  name?: string;
  upstream?: string;
  track?: string;
  sha?: string;
  subject?: string;
  age?: string;
  worktreepath?: string;
}): string {
  return [
    parts.name ?? '',
    parts.upstream ?? '',
    parts.track ?? '',
    parts.sha ?? '',
    parts.subject ?? '',
    parts.age ?? '',
    parts.worktreepath ?? '',
  ].join(FIELD_SEP);
}

test('GIT-002: parseForEachRefLine flags `worktree/*` and legacy `gian/*` prefixes', () => {
  const w = parseForEachRefLine(refLine({ name: 'worktree/abcd1234', sha: 'deadbeef' }));
  assert.equal(w.isWorktreeBranch, true);
  const g = parseForEachRefLine(refLine({ name: 'gian/legacy-flow', sha: 'cafebabe' }));
  assert.equal(g.isWorktreeBranch, true,
    'legacy `gian/*` branches must still flag — INV-015 says the registry must be stable across renames');
  const plain = parseForEachRefLine(refLine({ name: 'feature/x', sha: '12345678' }));
  assert.equal(plain.isWorktreeBranch, false);
  const dev = parseForEachRefLine(refLine({ name: 'develop', sha: '12345678' }));
  assert.equal(dev.isWorktreeBranch, false,
    '`develop` accidentally shares no prefix; must NOT be flagged');
});

test('GIT-002: parseForEachRefLine surfaces upstream, worktreepath, lastCommit fields', () => {
  const line = refLine({
    name: 'feature/x',
    upstream: 'origin/feature/x',
    track: '[ahead 2, behind 1]',
    sha: 'abc12345',
    subject: 'feat: add bar',
    age: '3 hours ago',
    worktreepath: '/tmp/worktree/feature-x',
  });
  const b = parseForEachRefLine(line);
  assert.equal(b.name, 'feature/x');
  assert.equal(b.upstream, 'origin/feature/x');
  assert.equal(b.ahead, 2);
  assert.equal(b.behind, 1);
  assert.equal(b.gone, false);
  assert.deepEqual(b.lastCommit, { hash: 'abc12345', subject: 'feat: add bar', age: '3 hours ago' });
  assert.equal(b.worktreePath, '/tmp/worktree/feature-x');
});

test('GIT-002: parseForEachRefLine returns lastCommit=null when objectname is missing', () => {
  const b = parseForEachRefLine(refLine({ name: 'orphan' }));
  assert.equal(b.lastCommit, null,
    'sha-less ref must yield null lastCommit so the picker can hide it gracefully');
});

test('GIT-002: parseForEachRefLine normalizes empty upstream and worktreepath to null', () => {
  const b = parseForEachRefLine(refLine({ name: 'main', sha: 'ff00ff00' }));
  assert.equal(b.upstream, null);
  assert.equal(b.worktreePath, null);
});

// ---------------------------------------------------------------------------
// buildRemoteBranchList — covers the remote-branches transform
// ---------------------------------------------------------------------------

function remoteLine(parts: {
  name?: string;
  sha?: string;
  subject?: string;
  age?: string;
  symref?: string;
}): string {
  return [
    parts.name ?? '',
    parts.sha ?? '',
    parts.subject ?? '',
    parts.age ?? '',
    parts.symref ?? '',
  ].join(FIELD_SEP);
}

test('GIT-002: buildRemoteBranchList strips origin/HEAD (and any explicit /HEAD entry) and symref aliases', () => {
  const raw = [
    remoteLine({ name: 'origin', sha: 'deadbeef', symref: 'refs/remotes/origin/main' }),
    remoteLine({ name: 'origin/HEAD', sha: 'deadbeef' }),
    remoteLine({ name: 'origin/main', sha: 'aaaa1111', subject: 'main work', age: '1 day ago' }),
    remoteLine({ name: 'origin/feature/x', sha: 'bbbb2222', subject: 'feat x', age: '2 days ago' }),
  ].join('\n');

  const out = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: new Set() });
  const names = out.map((b) => b.fullName).sort();
  assert.deepEqual(names, ['origin/feature/x', 'origin/main'],
    'symref aliases (origin) AND explicit /HEAD entries must be filtered out');
});

test('GIT-002: buildRemoteBranchList sets hasLocalTracking when a local branch shares the short name', () => {
  const raw = remoteLine({ name: 'origin/main', sha: '11112222' });
  const out = buildRemoteBranchList({
    rawForEachRef: raw,
    localBranchNames: new Set(['main', 'develop']),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.hasLocalTracking, true,
    'when a local branch with the same short name exists, hasLocalTracking must flip true');
  assert.equal(out[0]!.remote, 'origin');
  assert.equal(out[0]!.branch, 'main');
});

test('GIT-002: buildRemoteBranchList applies the case-insensitive search filter against full and short names', () => {
  const raw = [
    remoteLine({ name: 'origin/main', sha: '11112222' }),
    remoteLine({ name: 'origin/feature/auth', sha: '33334444' }),
    remoteLine({ name: 'upstream/feature/auth', sha: '55556666' }),
  ].join('\n');

  const main = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: new Set(), search: 'MAIN' });
  assert.deepEqual(main.map((b) => b.fullName), ['origin/main'],
    'search must be case-insensitive');

  const auth = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: new Set(), search: 'auth' });
  assert.deepEqual(auth.map((b) => b.fullName).sort(), ['origin/feature/auth', 'upstream/feature/auth']);

  const empty = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: new Set(), search: '' });
  assert.equal(empty.length, 3, 'empty search matches everything');
});

// ---------------------------------------------------------------------------
// listLocalBranches — drive a real git fixture end-to-end
// ---------------------------------------------------------------------------

test('GIT-002: listLocalBranches returns [] for a non-repo path (graceful failure mode)', () => {
  const out = listLocalBranches('/this/path/is/not/a/repo');
  assert.deepEqual(out, [],
    'non-repo path must yield empty list, never throw');
});

test('GIT-002: listLocalBranches reports every local branch with correct names and isWorktreeBranch flags', () => {
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    repo.createBranch('worktree/abcd1234');
    repo.createBranch('gian/legacy');
    repo.createBranch('feature/x');

    const branches = listLocalBranches(repo.path).sort((a, b) => a.name.localeCompare(b.name));
    const byName = Object.fromEntries(branches.map((b) => [b.name, b]));

    for (const expected of ['main', 'worktree/abcd1234', 'gian/legacy', 'feature/x']) {
      assert.ok(byName[expected], `${expected} must be enumerated`);
    }
    assert.equal(byName['worktree/abcd1234']!.isWorktreeBranch, true);
    assert.equal(byName['gian/legacy']!.isWorktreeBranch, true);
    assert.equal(byName['feature/x']!.isWorktreeBranch, false);
    assert.equal(byName['main']!.isWorktreeBranch, false);
  } finally {
    repo.cleanup();
  }
});

test('INV-015: branch parsing stays stable across main + worktree + session-owned branches', () => {
  // INV-015 is the durability claim: regardless of how many worktrees exist
  // or what's checked out where, the per-branch fields are stable. We drive
  // a real worktree-add to force `%(worktreepath)` to populate.
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    repo.commit('a.txt', 'a', 'a');

    // Create a worktree-occupied branch under `worktree/*`.
    const wtPath = `${repo.path}-wt`;
    repo.git(['worktree', 'add', '-b', 'worktree/feature-y', wtPath, 'main']);

    try {
      const branches = listLocalBranches(repo.path);
      const wt = branches.find((b) => b.name === 'worktree/feature-y');
      assert.ok(wt, 'worktree branch must be enumerated from the main repo');
      assert.ok(wt!.worktreePath && wt!.worktreePath.endsWith('-wt'),
        'worktreePath must point at the active worktree dir so the Git panel can link it');
      assert.equal(wt!.isWorktreeBranch, true);
      assert.equal(wt!.ahead, 0, 'fresh worktree branch has no divergence yet');
      assert.equal(wt!.behind, 0);
      assert.equal(wt!.gone, false);

      // main branch metadata stays untouched. macOS realpath resolves tmpdir
      // through /private, so compare via the resolved form.
      const main = branches.find((b) => b.name === 'main');
      assert.ok(main);
      assert.equal(main!.isWorktreeBranch, false);
      const expectedMainPath = realpathSync(repo.path);
      const actualMainPath = main!.worktreePath ? realpathSync(main!.worktreePath) : '';
      assert.equal(actualMainPath, expectedMainPath,
        'main branch worktreePath resolves to the workspace root itself');
    } finally {
      repo.git(['worktree', 'remove', '--force', wtPath]);
      repo.git(['branch', '-D', 'worktree/feature-y']);
    }
  } finally {
    repo.cleanup();
  }
});

test('GIT-002: listLocalBranches against a repo with an origin populates upstream + ahead', () => {
  // Create a bare upstream, set up the working tree with origin pointing
  // at it, and verify the upstream ref + ahead count.
  //
  // We don't assert `behind=0` here: the fixture's bare seed has its own
  // commit that the local repo doesn't share, so the two `main` branches
  // already diverge from the start. The contract we care about for this
  // row is that ahead/behind/upstream populate at all — exact divergence
  // counts depend on fixture seeding which is incidental.
  const bare = bareUpstream({ seedBranch: 'main' });
  try {
    const repo = createGitRepo({ initialBranch: 'main', origin: bare.path });
    try {
      repo.setUpstream('origin', 'main');
      repo.commit('local.txt', 'local change', 'local commit');

      const branches = listLocalBranches(repo.path);
      const main = branches.find((b) => b.name === 'main');
      assert.ok(main);
      assert.equal(main!.upstream, 'origin/main',
        'upstream must reflect the configured tracking ref');
      assert.ok(main!.ahead >= 1,
        `expected ahead >= 1 after a local commit; got ${main!.ahead}`);
      assert.equal(main!.gone, false,
        'a reachable upstream must NOT be marked `gone`');
    } finally {
      repo.cleanup();
    }
  } finally {
    bare.cleanup();
  }
});

test('GIT-002: listLocalBranches flags `[gone]` when the upstream ref is deleted from the bare', () => {
  const bare = bareUpstream({ seedBranch: 'main' });
  try {
    const repo = createGitRepo({ initialBranch: 'main', origin: bare.path });
    try {
      // Push a feature branch upstream, then delete it remotely.
      repo.checkout('feature/disposable', { create: true });
      repo.commit('f.txt', 'f', 'feature commit');
      repo.git(['push', '-u', 'origin', 'feature/disposable']);
      repo.git(['push', 'origin', '--delete', 'feature/disposable']);
      // Local branch still has tracking config but the remote ref is gone.
      repo.git(['fetch', '--prune']);

      const branches = listLocalBranches(repo.path);
      const feat = branches.find((b) => b.name === 'feature/disposable');
      assert.ok(feat);
      assert.equal(feat!.gone, true,
        '`[gone]` upstream must surface so the Git panel can prompt the user to clean up');
    } finally {
      repo.cleanup();
    }
  } finally {
    bare.cleanup();
  }
});
