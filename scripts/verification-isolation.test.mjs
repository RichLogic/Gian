import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createVerificationSnapshot, main, needsVerificationIsolation } from './run-verification.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gian-verification-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Gian Test']);
  git(['config', 'user.email', 'gian-test@example.invalid']);
  git(['config', 'core.hooksPath', '/dev/null']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, '.gitignore'), '.gian-runtime/\nnode_modules/\n**/dist/\n');
  writeFileSync(join(root, 'changed.txt'), 'committed');
  writeFileSync(join(root, 'deleted.txt'), 'delete me');
  git(['add', '.']); git(['commit', '-m', 'fixture']);
  return { root, git };
}

test('verification materializes modified, deleted, and untracked files without sharing generated output', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'changed.txt'), 'dirty');
  rmSync(join(root, 'deleted.txt'));
  writeFileSync(join(root, 'new.txt'), 'new source');
  mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist', 'index.js'), 'live');
  const snapshot = createVerificationSnapshot(root, join(root, '.gian-runtime', 'verification'));
  try {
    assert.equal(readFileSync(join(snapshot.checkout, 'changed.txt'), 'utf8'), 'dirty');
    assert.equal(readFileSync(join(snapshot.checkout, 'new.txt'), 'utf8'), 'new source');
    assert.equal(existsSync(join(snapshot.checkout, 'deleted.txt')), false);
    assert.equal(existsSync(join(snapshot.checkout, 'dist')), false);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot.checkout, encoding: 'utf8' }), git(['rev-parse', 'HEAD']).toString());
  } finally { snapshot.cleanup(); }
  assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), 'live');
});

test('active and orphaned runtime records isolate verification; restricted process reads fail closed', t => {
  const { root } = fixture(t);
  const dir = join(root, '.gian-runtime'); mkdirSync(dir);
  writeFileSync(join(dir, 'services.json'), JSON.stringify({ worktree: root, supervisorPid: 10, servicesPid: 11, serviceGroupMembers: [{ pid: 12, startedAt: "fixture" }] }));
  assert.equal(needsVerificationIsolation(root, pid => pid === 10), true);
  assert.equal(needsVerificationIsolation(root, pid => pid === 11), true);
  assert.equal(needsVerificationIsolation(root, pid => pid === 12), true);
  assert.equal(needsVerificationIsolation(root, () => false), false);
  assert.throws(() => needsVerificationIsolation(root, () => { throw new Error('EPERM'); }), /EPERM/);
});

test('normal build runs in a separately installed checkout while live dist and source stay intact', t => {
  const { root, git } = fixture(t);
  mkdirSync(join(root, 'packages', 'fixture'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'verify-fixture', private: true, packageManager: 'pnpm@10.33.2' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(join(root, 'packages', 'fixture', 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node build.mjs' } }));
  writeFileSync(join(root, 'packages', 'fixture', 'build.mjs'), `import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true }); mkdirSync('dist'); writeFileSync('dist/index.js', 'verification');
mkdirSync('../../output', { recursive: true }); writeFileSync('../../output/proof.txt', process.cwd());\n`);
  execFileSync('pnpm', ['install', '--offline', '--lockfile-only'], { cwd: root, stdio: 'pipe', env: { ...process.env, CI: 'true' } });
  git(['add', '.']); git(['commit', '-m', 'build fixture']);
  mkdirSync(join(root, '.gian-runtime'));
  writeFileSync(join(root, '.gian-runtime', 'services.json'), JSON.stringify({ worktree: root, supervisorPid: process.pid }));
  const dist = join(root, 'packages', 'fixture', 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'index.js'), 'live');
  const before = git(['status', '--porcelain']).toString();
  assert.equal(main(['build'], root), 0);
  assert.equal(readFileSync(join(dist, 'index.js'), 'utf8'), 'live');
  assert.equal(git(['status', '--porcelain']).toString(), before);
  assert.equal(git(['worktree', 'list', '--porcelain']).toString().match(/^worktree /gm).length, 1);
});
