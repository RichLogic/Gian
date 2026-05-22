// Shared git fixture for host tests that need a real on-disk repo. Tests
// drive `git` via subprocess (the production code does the same), so this
// helper never tries to virtualize git semantics — it just lays down a
// real working tree under a tmpdir with the structure each test asks for.
//
// Used by:
//   - test/wt-001-worktree-lifecycle.test.ts (WT-001 / WT-003 / INV-013)
//   - test/git-002-branch-parsing.test.ts   (GIT-002 / INV-015)
//   - test/sec-014-file-boundary.test.ts    (SEC-014, future)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitRepoOptions {
  /** Initial commit message. Defaults to 'init'. */
  initialMessage?: string;
  /** Initial branch name. Defaults to 'main'. */
  initialBranch?: string;
  /** Optional secondary repo to register as `origin` remote.
   *  Use `bareUpstream()` to create one. */
  origin?: string;
  /** Extra files to seed at HEAD ({ relPath: content }). README.md is
   *  always seeded so the initial commit has something to track. */
  files?: Record<string, string>;
}

export interface GitRepo {
  /** Absolute path to the working tree. */
  path: string;
  /** Run a git subcommand in the repo. Mirrors the production helper
   *  signature (no shell, no PATH lookup, throws on non-zero). */
  git(args: string[]): string;
  /** Create + commit a file. Returns the new HEAD SHA. */
  commit(relPath: string, content: string, message?: string): string;
  /** Create a local branch off the current HEAD without checking it out. */
  createBranch(name: string, base?: string): void;
  /** Check out a branch (creating it if missing). */
  checkout(branch: string, opts?: { create?: boolean }): void;
  /** Set up an upstream tracking relationship for the current branch. */
  setUpstream(remote: string, branch: string): void;
  /** Clean up the on-disk repo. Safe to call multiple times. */
  cleanup(): void;
}

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: {
      ...process.env,
      // Stable identity so commit SHAs don't depend on local user config.
      GIT_AUTHOR_NAME: 'Gian Test',
      GIT_AUTHOR_EMAIL: 'gian-test@example.invalid',
      GIT_COMMITTER_NAME: 'Gian Test',
      GIT_COMMITTER_EMAIL: 'gian-test@example.invalid',
      // Suppress hint output that breaks parsers expecting clean stdout.
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

/**
 * Create a brand-new git repo in a tmpdir with one initial commit.
 *
 * The repo lives under a per-test tmpdir and is removed by `cleanup()`.
 * `core.hooksPath` is set to /dev/null so user-global hooks (commit-msg
 * linters etc.) never run inside the fixture.
 */
export function createGitRepo(opts: GitRepoOptions = {}): GitRepo {
  const initialBranch = opts.initialBranch ?? 'main';
  const initialMessage = opts.initialMessage ?? 'init';
  const root = mkdtempSync(join(tmpdir(), 'gian-gitfx-'));

  run(root, ['init', '--initial-branch', initialBranch]);
  run(root, ['config', 'core.hooksPath', '/dev/null']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  run(root, ['config', 'tag.gpgsign', 'false']);

  // Seed README.md + caller-provided files so the initial commit has
  // tracked content. Git refuses to create a branch on an empty repo.
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  run(root, ['add', '-A']);
  run(root, ['commit', '-m', initialMessage]);

  if (opts.origin) {
    run(root, ['remote', 'add', 'origin', opts.origin]);
    run(root, ['fetch', 'origin']);
  }

  const repo: GitRepo = {
    path: root,
    git(args) { return run(root, args); },
    commit(rel, content, message = `update ${rel}`) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
      run(root, ['add', rel]);
      run(root, ['commit', '-m', message]);
      return run(root, ['rev-parse', 'HEAD']);
    },
    createBranch(name, base) {
      run(root, ['branch', name, ...(base ? [base] : [])]);
    },
    checkout(branch, { create } = {}) {
      run(root, create ? ['checkout', '-b', branch] : ['checkout', branch]);
    },
    setUpstream(remote, branch) {
      run(root, ['branch', '--set-upstream-to', `${remote}/${branch}`]);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return repo;
}

/**
 * Create a bare repo intended to be used as `origin` for another working
 * tree. Returns the absolute path. Caller is responsible for cleanup via
 * the returned `cleanup` callback.
 *
 * `seedBranch` (default 'main') is materialized by initializing a
 * throwaway working tree, committing once, and pushing into the bare. Bare
 * repos can't accept commits directly.
 */
export function bareUpstream(opts: { seedBranch?: string } = {}): { path: string; cleanup: () => void } {
  const seedBranch = opts.seedBranch ?? 'main';
  const root = mkdtempSync(join(tmpdir(), 'gian-gitfx-bare-'));
  run(root, ['init', '--bare', '--initial-branch', seedBranch]);

  // Push one initial commit so the bare has at least one ref. Without this
  // a worktree using the bare as origin sees `origin/HEAD` resolve nowhere.
  const seedWorkspace = mkdtempSync(join(tmpdir(), 'gian-gitfx-seed-'));
  try {
    run(seedWorkspace, ['init', '--initial-branch', seedBranch]);
    run(seedWorkspace, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(seedWorkspace, 'README.md'), '# seed\n');
    run(seedWorkspace, ['add', '-A']);
    run(seedWorkspace, [
      '-c', 'user.name=Gian Seed', '-c', 'user.email=gian-seed@example.invalid',
      'commit', '-m', 'seed',
    ]);
    run(seedWorkspace, ['remote', 'add', 'origin', root]);
    run(seedWorkspace, ['push', '-u', 'origin', seedBranch]);
  } finally {
    rmSync(seedWorkspace, { recursive: true, force: true });
  }

  // Mark the seeded branch as the bare's HEAD so consumer clones see a
  // canonical default branch.
  run(root, ['symbolic-ref', 'HEAD', `refs/heads/${seedBranch}`]);

  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
