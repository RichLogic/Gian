import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const checker = join(dirname(fileURLToPath(import.meta.url)), 'check-traceability.js');

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

function fixtureMatrix() {
  const ranked = Array.from({ length: 10 }, (_, index) => `| ${index + 1} | fixture risk |`);
  return [
    '# Traceability fixture',
    '',
    '| ID | Requirement | Risk | Method | Code | Evidence | Status | GAP |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| CI-999 | fixture gate | 低 | integration | `scripts/change.mjs` | `scripts/evidence.test.mjs` | COVERED | - |',
    '',
    '## Top 10 未覆盖风险',
    '',
    '| Rank | Risk |',
    '| --- | --- |',
    ...ranked,
    '',
  ].join('\n');
}

function traceabilityEnv(overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ![
      'GITHUB_BASE_REF',
      'GITHUB_EVENT_PATH',
      'TRACEABILITY_BASE',
      'TRACEABILITY_BASE_REF',
      'TRACEABILITY_NOT_REQUIRED',
    ].includes(key)),
  );
  return { ...env, ...overrides };
}

test('changed-file gate rejects a relevant base diff and permits only the explicit bypass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-traceability-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'docs', 'quality'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'docs', 'quality', 'traceability.md'), fixtureMatrix());
  await writeFile(join(root, 'scripts', 'change.mjs'), 'export const value = 1;\n');
  await writeFile(join(root, 'scripts', 'evidence.test.mjs'), '// fixture evidence\n');

  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'ci-fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'CI Fixture']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'base']);
  const base = await git(root, ['rev-parse', 'HEAD']);

  await writeFile(join(root, 'scripts', 'change.mjs'), 'export const value = 2;\n');
  await git(root, ['add', 'scripts/change.mjs']);
  await git(root, ['commit', '--quiet', '-m', 'relevant change']);

  await assert.rejects(
    execFileAsync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: traceabilityEnv({ TRACEABILITY_BASE_REF: base }),
    }),
    error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /product\/test\/script changes require/);
      assert.match(error.stderr, /scripts\/change\.mjs/);
      return true;
    },
  );

  const bypass = await execFileAsync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    env: traceabilityEnv({
      TRACEABILITY_BASE_REF: base,
      TRACEABILITY_NOT_REQUIRED: '1',
    }),
  });
  assert.match(bypass.stdout, /changed-file gate bypassed by TRACEABILITY_NOT_REQUIRED=1/);
});

test('curated public source skips the gate when internal docs are omitted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-traceability-curated-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'change.mjs'), 'export const value = 1;\n');

  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'ci-fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'CI Fixture']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'curated public source']);
  const base = await git(root, ['rev-parse', 'HEAD']);

  await writeFile(join(root, 'scripts', 'change.mjs'), 'export const value = 2;\n');
  await git(root, ['add', 'scripts/change.mjs']);
  await git(root, ['commit', '--quiet', '-m', 'relevant change']);

  const curated = await execFileAsync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    env: traceabilityEnv({ TRACEABILITY_BASE_REF: base }),
  });
  assert.match(curated.stdout, /curated public source omits internal docs; traceability gate skipped/);
});

test('a private tree still fails closed when the matrix file is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-traceability-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, 'AGENTS.md'), '# private tree\n');
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'ci-fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'CI Fixture']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'private tree without matrix']);

  await assert.rejects(
    execFileAsync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: traceabilityEnv(),
    }),
    error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /docs\/quality\/traceability\.md is missing/);
      return true;
    },
  );
});
