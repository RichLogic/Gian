import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireQualityLock, QUALITY_LOCK_ENV } from './quality-lock.mjs';
import { acquireLocalVerification, LOCAL_VERIFICATION_TOKEN, localNodeTestArgs, localVitestArgs } from './local-verification.mjs';

test('local verification shares a slot across worktrees and nested runners retain it', t => {
  const root = mkdtempSync(join(tmpdir(), 'gian-local-verification-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const approved = { GIAN_ALLOW_LOCAL_VERIFICATION: '1' };
  const first = acquireLocalVerification('worktree A', approved, root);
  try {
    assert.throws(() => acquireLocalVerification('worktree B', approved, root), /already running/);
    assert.throws(() => acquireLocalVerification('bad inherited lease', {
      ...approved, [LOCAL_VERIFICATION_TOKEN]: 'wrong',
    }, root), /inheritance is invalid/);
    const nested = acquireLocalVerification('nested typecheck', first.env, root);
    nested.release();
    assert.throws(() => acquireLocalVerification('worktree B', approved, root), /already running/);
    // A preview/package quality token must not be confused with the local slot.
    assert.throws(() => acquireLocalVerification('foreign quality gate', {
      ...approved, [QUALITY_LOCK_ENV]: first.env[LOCAL_VERIFICATION_TOKEN],
    }, root), /already running/);
  } finally { first.release(); }
  acquireLocalVerification('next queued task', approved, root).release();
});

test('local verification rejects unselected runs without creating a slot; hosted workers are unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'gian-local-verification-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => acquireLocalVerification('not approved', {}, root), /Owner-selected/);
  assert.equal(existsSync(join(root, 'output')), false);
  const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
  acquireLocalVerification('hosted tests', hosted, root).release();
  assert.equal(existsSync(join(root, 'output')), false);
  assert.deepEqual(localNodeTestArgs({}), ['--test-concurrency=1']);
  assert.deepEqual(localVitestArgs({}), ['--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism']);
  assert.deepEqual(localNodeTestArgs(hosted), []);
  assert.deepEqual(localVitestArgs(hosted), []);
});

test('quality lock rejects a concurrent gate and supports inherited nested gates', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'gian-quality-lock-'));
  const first = acquireQualityLock({ command: 'quality:package', rootDir, token: 'outer' });
  try {
    assert.throws(
      () => acquireQualityLock({ command: 'quality:prepackage', rootDir, token: 'other' }),
      /quality gate already running: quality:package/,
    );

    const nested = acquireQualityLock({
      command: 'quality:prepackage',
      env: { [QUALITY_LOCK_ENV]: first.token },
      rootDir,
    });
    assert.equal(nested.owner, false);
    nested.release();
    assert.equal(existsSync(first.lockPath), true);
  } finally {
    first.release();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('quality lock reclaims a stale owner', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'gian-quality-lock-stale-'));
  const stale = acquireQualityLock({ command: 'old gate', pid: 41, rootDir, token: 'stale' });
  try {
    const current = acquireQualityLock({
      command: 'new gate',
      isProcessAlive: () => false,
      pid: 42,
      rootDir,
      token: 'current',
    });
    assert.equal(current.owner, true);
    assert.equal(current.token, 'current');
    current.release();
  } finally {
    stale.release();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
