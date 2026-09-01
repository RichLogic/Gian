// Coverage for agent-created worktree auto-detection:
//   - detectWorktreeAddPath: parses `git worktree add` out of shell command
//     strings (the command carried by command_execution events from cc Bash
//     tool_use, codex commandExecution, and kimi ACP execute tool_calls).
//   - parseWorktreeListPorcelain / listGitWorktrees: the `git worktree list
//     --porcelain` discovery that backs ext: working-tree ids and the
//     membership validation behind both resolveWorkingTree and the session
//     detection hook.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { detectWorktreeAddPath } from '../src/session/worktree-detect.js';
import {
  listGitWorktreesAsync,
  parseWorktreeListPorcelain,
} from '../src/workspace/git.js';
import { createGitRepo } from './fixtures/git-repo.js';

// ---------------------------------------------------------------------------
// detectWorktreeAddPath — positive shapes
// ---------------------------------------------------------------------------

test('detect: plain invocation returns the path', () => {
  assert.equal(detectWorktreeAddPath('git worktree add /tmp/wt'), '/tmp/wt');
});

test('detect: -b / -B branch flags consume their value; path is first positional', () => {
  assert.equal(detectWorktreeAddPath('git worktree add -b feature/x /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add -B feature/x /tmp/wt'), '/tmp/wt');
});

test('detect: trailing commit-ish is ignored (path is the FIRST positional)', () => {
  assert.equal(detectWorktreeAddPath('git worktree add -b feature/x /tmp/wt main'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add /tmp/wt origin/main'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add -b x /tmp/wt HEAD~1'), '/tmp/wt');
});

test('detect: boolean flags are skipped', () => {
  assert.equal(detectWorktreeAddPath('git worktree add --detach /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add -d /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add --force --quiet /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add --track -b x /tmp/wt origin/x'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add --lock /tmp/wt'), '/tmp/wt');
});

test('detect: value flags with inline = form are skipped', () => {
  assert.equal(detectWorktreeAddPath('git worktree add --orphan=scratch /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add --reason "why not" /tmp/wt'), '/tmp/wt');
});

test('detect: -- separator terminates flag parsing', () => {
  assert.equal(detectWorktreeAddPath('git worktree add -- /tmp/wt'), '/tmp/wt');
});

test('detect: git -C <repo> prefix is honored; relative path anchors at the repo', () => {
  assert.equal(detectWorktreeAddPath('git -C /repo worktree add /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git -C /repo worktree add ../wt'), resolve('/repo', '../wt'));
  assert.equal(detectWorktreeAddPath('git -C /repo -c core.x=1 worktree add wt'), resolve('/repo', 'wt'));
});

test('detect: quoted paths keep their spaces', () => {
  assert.equal(detectWorktreeAddPath('git worktree add "/tmp/my wt"'), '/tmp/my wt');
  assert.equal(detectWorktreeAddPath("git worktree add '/tmp/my wt'"), '/tmp/my wt');
  assert.equal(detectWorktreeAddPath('git worktree add -b "feat/x" "/tmp/my wt"'), '/tmp/my wt');
  assert.equal(detectWorktreeAddPath('git worktree add /tmp/my\\ wt'), '/tmp/my wt');
});

test('detect: ~ expands against the home directory', () => {
  assert.equal(
    detectWorktreeAddPath('git worktree add ~/Coding/worktrees/x'),
    `${homedir()}/Coding/worktrees/x`,
  );
  assert.equal(detectWorktreeAddPath('git worktree add ~'), homedir());
  // ~ must not expand mid-path.
  assert.equal(detectWorktreeAddPath('git worktree add /tmp/~x'), '/tmp/~x');
});

test('detect: compound commands — any segment may carry the git invocation', () => {
  assert.equal(detectWorktreeAddPath('cd /repo && git worktree add /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('echo hi; git worktree add /tmp/wt'), '/tmp/wt');
  assert.equal(detectWorktreeAddPath('git worktree add /tmp/wt && echo done'), '/tmp/wt');
});

test('detect: unwraps sh, bash, and zsh command strings used by agent runtimes', () => {
  assert.equal(
    detectWorktreeAddPath(
      "/bin/zsh -lc 'git worktree add -b fix/trace-pinned-header /tmp/trace-wt main'",
    ),
    '/tmp/trace-wt',
  );
  assert.equal(
    detectWorktreeAddPath('bash -lc "cd /repo && git worktree add /tmp/bash-wt"'),
    '/tmp/bash-wt',
  );
  assert.equal(
    detectWorktreeAddPath("sh -c 'git worktree add /tmp/sh-wt'"),
    '/tmp/sh-wt',
  );
  assert.equal(
    detectWorktreeAddPath("zsh -l -c 'git worktree add /tmp/zsh-wt'"),
    '/tmp/zsh-wt',
  );
  assert.equal(
    detectWorktreeAddPath("bash -o posix -lc 'git worktree add /tmp/bash-option-wt'"),
    '/tmp/bash-option-wt',
  );
  assert.equal(
    detectWorktreeAddPath("bash -lc \"/bin/sh -c 'git worktree add /tmp/nested-wt'\""),
    '/tmp/nested-wt',
  );
});

// ---------------------------------------------------------------------------
// detectWorktreeAddPath — negative shapes
// ---------------------------------------------------------------------------

test('detect: non-matching commands return null', () => {
  for (const cmd of [
    'git worktree list',
    'git worktree list --porcelain',
    'git worktree remove /tmp/wt',
    'git worktree prune',
    'git add .',
    'git status',
    'git commit -m "worktree add"',
    'git worktree',
    'git',
    'ls',
    'echo "git worktree add /tmp/x"',
    'git worktree add',           // no path at all
    'git worktree add -b x',      // flag value consumed, no path left
    'git worktree add ../wt',     // relative path without -C anchor
    'git -C worktree add /tmp/x', // malformed: -C value is "worktree" → subcommand mismatch
    "zsh -lc 'echo git worktree add /tmp/x'",
    'bash -lc',
    "bash ./script.sh -c 'git worktree add /tmp/x'",
    "python -c 'git worktree add /tmp/x'",
  ]) {
    assert.equal(detectWorktreeAddPath(cmd), null, `expected null for: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// parseWorktreeListPorcelain — pure parser
// ---------------------------------------------------------------------------

test('porcelain: main + linked + detached entries parse correctly', () => {
  const out = [
    'worktree /repo/main',
    'HEAD aaaa1111',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD bbbb2222',
    'branch refs/heads/feature/x',
    '',
    'worktree /repo/wt-detached',
    'HEAD cccc3333',
    'detached',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktreeListPorcelain(out), [
    { path: '/repo/main', head: 'aaaa1111', branch: 'main' },
    { path: '/repo/wt-feature', head: 'bbbb2222', branch: 'feature/x' },
    { path: '/repo/wt-detached', head: 'cccc3333', branch: null },
  ]);
});

test('porcelain: bare entry yields empty head and null branch', () => {
  const out = ['worktree /repo/bare', 'bare', ''].join('\n');
  assert.deepEqual(parseWorktreeListPorcelain(out), [
    { path: '/repo/bare', head: '', branch: null },
  ]);
});

test('porcelain: prunable ghost entries are omitted', () => {
  const out = [
    'worktree /repo/main',
    'HEAD aaaa1111',
    'branch refs/heads/main',
    '',
    'worktree /repo/missing',
    'HEAD bbbb2222',
    'branch refs/heads/stale',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktreeListPorcelain(out), [
    { path: '/repo/main', head: 'aaaa1111', branch: 'main' },
  ]);
});

test('porcelain: empty input yields no entries', () => {
  assert.deepEqual(parseWorktreeListPorcelain(''), []);
});

// ---------------------------------------------------------------------------
// listGitWorktreesAsync — real git fixture, mirroring git-002's approach
// ---------------------------------------------------------------------------

test('listGitWorktreesAsync: non-repo path yields [] (never throws)', async () => {
  assert.deepEqual(await listGitWorktreesAsync('/this/path/is/not/a/repo'), []);
});

test('async worktree discovery enumerates main, branched, and detached worktrees', async () => {
  const repo = createGitRepo({ initialBranch: 'main' });
  const branchedPath = `${repo.path}-wt-branched`;
  const detachedPath = `${repo.path}-wt-detached`;
  try {
    repo.git(['worktree', 'add', '-b', 'feature/agent', branchedPath, 'main']);
    repo.git(['worktree', 'add', '--detach', detachedPath, 'main']);
    try {
      const list = await listGitWorktreesAsync(repo.path);
      assert.equal(list.length, 3);
      assert.deepEqual(await listGitWorktreesAsync(repo.path), list,
        'repeat non-blocking discovery preserves the established parser contract');

      // macOS tmpdir resolves through /private — compare resolved forms.
      assert.equal(realpathSync(list[0]!.path), realpathSync(repo.path),
        'main tree is listed first');
      assert.equal(list[0]!.branch, 'main');
      assert.ok(list[0]!.head.length >= 7, 'HEAD sha populated');

      const branched = list.find(w => w.branch === 'feature/agent');
      assert.ok(branched, 'branched worktree enumerated');
      assert.equal(realpathSync(branched!.path), realpathSync(branchedPath));

      const detached = list.find(w => realpathSync(w.path) === realpathSync(detachedPath));
      assert.ok(detached, 'detached worktree enumerated');
      assert.equal(detached!.branch, null, 'detached HEAD has no branch');
      assert.ok(detached!.head.length >= 7);
    } finally {
      repo.git(['worktree', 'remove', '--force', branchedPath]);
      repo.git(['worktree', 'remove', '--force', detachedPath]);
      repo.git(['branch', '-D', 'feature/agent']);
    }
  } finally {
    repo.cleanup();
  }
});
