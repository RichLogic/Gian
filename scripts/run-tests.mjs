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

  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry) {
    run(process.execPath, [pnpmEntry, '-r', '--if-present', 'test'], env);
  } else {
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-r', '--if-present', 'test'], env);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
