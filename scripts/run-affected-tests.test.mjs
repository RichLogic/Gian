import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { planAcceptance } from './run-giandev-acceptance.mjs';

test('scoped acceptance rejects unknown groups and does not expand a selected group', () => {
  assert.throws(() => planAcceptance([]), /Select at least/);
  assert.throws(() => planAcceptance(['all']), /Unknown acceptance/);
  assert.throws(() => planAcceptance(['__proto__']), /Unknown acceptance/);
  const files = planAcceptance(['agent-defaults', 'agent-defaults']);
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.includes('packages/web/test/agents-view.test.tsx'));
  assert.equal(files.some(path => path.includes('/kimi-proxy/')), false);
  assert.equal(files.some(path => path.includes('/e2e/')), false);
});
import {
  affectedExecutionPlan,
  discoverChangedFiles,
  parseAffectedOptions,
} from './run-affected-tests.mjs';

test('affected options require an explicit diff base or changed path', () => {
  assert.throws(() => parseAffectedOptions([]), /provide --base/);
  assert.deepEqual(parseAffectedOptions([
    '--base', 'main', '--head', 'topic', '--stage', 'merge', '--execute', '--json',
  ]), {
    base: 'main',
    head: 'topic',
    changedFiles: [],
    stage: 'merge',
    execute: true,
    json: true,
    checkMap: false,
  });
  assert.deepEqual(parseAffectedOptions(['--changed-file', 'a', '--changed-file', 'b']).changedFiles, ['a', 'b']);
  assert.equal(parseAffectedOptions(['--', '--changed-file', 'a']).changedFiles[0], 'a');
  assert.throws(() => parseAffectedOptions(['--stage', 'preview', '--changed-file', 'a']), /unsupported/);
});

test('execution plan uses exact catalog files and selected scopes', () => {
  const commands = affectedExecutionPlan({
    checks: [{ id: 'typecheck' }],
    runnableTests: [
      { path: 'a.test.ts', scope: 'unit' },
      { path: 'b.test.ts', scope: 'integration' },
    ],
  });
  assert.deepEqual(commands[0], { kind: 'check', command: 'pnpm', args: ['typecheck'] });
  assert.deepEqual(commands[1], {
    kind: 'tests',
    command: 'node',
    args: [
      'scripts/run-tests.mjs', '--scope', 'unit', '--scope', 'integration',
      '--file', 'a.test.ts', '--file', 'b.test.ts',
    ],
  });
});

test('root typecheck builds declaration dependencies before recursive checks', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.typecheck, 'node scripts/run-verification.mjs typecheck');
  const source = readFileSync(new URL('./typecheck.mjs', import.meta.url), 'utf8');
  assert.match(source, /'shared', 'proxy-protocol', 'proxy-catalog-contract', 'remote-protocol', 'chat-ui', 'tool-cli', 'tool-mcp', null/);
  assert.match(source, /\['-r', 'typecheck'\]/);
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('changed files are discovered from a constructed base and head diff', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gian-affected-git-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'tests@gian.local']);
  git(cwd, ['config', 'user.name', 'Gian Tests']);
  writeFileSync(join(cwd, 'kept.txt'), 'base\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, 'kept.txt'), 'changed\n');
  writeFileSync(join(cwd, 'added.txt'), 'added\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'head']);
  writeFileSync(join(cwd, 'working.txt'), 'untracked\n');
  assert.deepEqual(discoverChangedFiles(base, 'HEAD', cwd), ['added.txt', 'kept.txt', 'working.txt']);
});
