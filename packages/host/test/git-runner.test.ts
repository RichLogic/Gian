import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyGitFailure, GitCommandError, runGit } from '../src/workspace/git-runner.js';
import { createGitRepo } from './fixtures/git-repo.js';

test('GIT-HISTORY-003: async runner does not block Host event-loop timers', async () => {
  const repo = createGitRepo();
  try {
    repo.git(['config', 'alias.gian-slow', '!sleep 0.15']);
    let timerFired = false;
    const timer = new Promise<void>(resolve => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 20));
    const command = runGit(repo.path, ['gian-slow'], { timeoutMs: 2_000 });
    await timer;
    assert.equal(timerFired, true);
    await command;
  } finally {
    repo.cleanup();
  }
});

test('GIT-HISTORY-003: runner terminates a timed-out Git child with a typed error', async () => {
  const repo = createGitRepo();
  try {
    repo.git(['config', 'alias.gian-slow', '!sleep 2']);
    await assert.rejects(
      runGit(repo.path, ['gian-slow'], { timeoutMs: 20 }),
      (error: unknown) => error instanceof GitCommandError && error.kind === 'timeout',
    );
  } finally {
    repo.cleanup();
  }
});

test('GIT-HISTORY-003: runner enforces output caps and supports explicit diff truncation', async () => {
  const repo = createGitRepo();
  try {
    repo.commit('large.txt', 'x'.repeat(32_000), 'large output');
    await assert.rejects(
      runGit(repo.path, ['show', 'HEAD:large.txt'], { maxStdoutBytes: 128 }),
      (error: unknown) => error instanceof GitCommandError && error.kind === 'output-limit',
    );
    const truncated = await runGit(repo.path, ['show', 'HEAD:large.txt'], {
      maxStdoutBytes: 128,
      truncateStdout: true,
    });
    assert.equal(Buffer.byteLength(truncated.stdout), 128);
    assert.equal(truncated.truncated, true);
  } finally {
    repo.cleanup();
  }
});

test('GIT-HISTORY-003: runner classifies non-repositories and honors pre-aborted signals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-git-runner-'));
  try {
    await assert.rejects(
      runGit(dir, ['status']),
      (error: unknown) => error instanceof GitCommandError && error.kind === 'not-repository',
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runGit(dir, ['status'], { signal: controller.signal }),
      (error: unknown) => error instanceof GitCommandError && error.kind === 'aborted',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GIT-HISTORY-003: runner classifies credential failures without exposing remote stderr', () => {
  assert.equal(classifyGitFailure("fatal: Authentication failed for 'https://token@example.invalid/repo'"), 'authentication');
  assert.equal(classifyGitFailure('git@example.invalid: Permission denied (publickey).'), 'authentication');
  assert.equal(classifyGitFailure('fatal: bad object deadbeef'), 'not-found');
});
