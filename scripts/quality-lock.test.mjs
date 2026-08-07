import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireQualityLock, QUALITY_LOCK_ENV } from './quality-lock.mjs';

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
