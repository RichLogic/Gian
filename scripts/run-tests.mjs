import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function sanitizedTestEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith('GIAN_')),
  );
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main() {
  const env = sanitizedTestEnv();
  const scriptTests = readdirSync(join(rootDir, 'scripts'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join('scripts', name));

  run(process.execPath, ['--test', ...scriptTests], env);

  // Static UI-operation gate (proposal §7 Phase 4): strict mode — a direct
  // mutation from a view or an unclassified Host command fails the chain
  // here, locally and in CI (`pnpm test`, release workflow "Verify source").
  run(process.execPath, ['scripts/check-ui-operations.mjs', '--strict'], env);

  const pnpmEntry = process.env.npm_execpath;
  const pnpm = pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] };
  // Dependents resolve @gian/shared through its dist declarations, and the
  // proxy suites test built output — build shared first so a fresh checkout
  // passes (mirrors scripts/dev.mjs).
  run(pnpm.command, [...pnpm.args, '--filter', '@gian/shared', 'build'], env);
  run(pnpm.command, [...pnpm.args, '-r', '--if-present', 'test'], env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
