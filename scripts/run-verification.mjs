import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error; // A restricted observer must not assume that the runtime is off.
  }
}

export function needsVerificationIsolation(root, isAlive = alive) {
  for (const file of ['services.json', 'desktop.json']) {
    const path = join(root, '.gian-runtime', file);
    if (!existsSync(path)) continue;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.worktree && realpathSync(state.worktree) !== realpathSync(root)) {
      throw new Error(`foreign GianDev ownership in ${path}`);
    }
    if ([state.supervisorPid, state.servicesPid, state.pid, ...(state.serviceGroupMembers ?? []).map(member => member.pid)].some(isAlive)) return true;
  }
  return false;
}

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

// A detached checkout preserves Git history/refs for affected selection and
// materializes dirty source too. It never links mutable dist or node_modules.
export function createVerificationSnapshot(root, parent) {
  mkdirSync(parent, { recursive: true });
  const runDir = mkdtempSync(join(parent, 'run-'));
  const checkout = join(runDir, 'source');
  git(root, ['worktree', 'add', '--detach', checkout, 'HEAD']);
  try {
    const patch = git(root, ['diff', '--binary', 'HEAD', '--']);
    if (patch) git(checkout, ['apply', '--binary', '-'], { input: patch });
    for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      const source = join(root, path);
      // Symlinks would point back to mutable source/output or outside the snapshot.
      if (lstatSync(source).isSymbolicLink()) throw new Error(`untracked symlink cannot be verified in isolation: ${path}`);
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      cpSync(source, join(checkout, path));
    }
    return { checkout, runDir, cleanup: () => git(root, ['worktree', 'remove', '--force', checkout]) };
  } catch (error) {
    git(root, ['worktree', 'remove', '--force', checkout]);
    throw error;
  }
}

export function verificationCommand(task, args) {
  const commands = {
    build: ['pnpm', ['-r', 'build']],
    typecheck: [process.execPath, ['scripts/typecheck.mjs']],
    test: [process.execPath, ['scripts/run-tests.mjs', '--scope', 'unit', '--scope', 'integration', '--quality-gates']],
    'test:all': [process.execPath, ['scripts/run-tests.mjs', '--scope', 'unit', '--scope', 'integration', '--scope', 'system', '--quality-gates']],
    'verify:quick': [process.execPath, ['scripts/run-affected-tests.mjs', '--stage', 'quick', '--execute']],
    'test:affected': [process.execPath, ['scripts/run-affected-tests.mjs', '--execute']],
    'verify:preview': [process.execPath, ['scripts/run-preview-verification.mjs']],
  };
  const command = commands[task];
  if (!command) throw new Error(`unknown verification task: ${task}`);
  return { command: command[0], args: [...command[1], ...args] };
}

export function main(argv = process.argv.slice(2), root = rootDir) {
  const [task, ...args] = argv;
  const command = verificationCommand(task, args);
  let snapshot;
  const env = { ...process.env };
  try {
    if (needsVerificationIsolation(root)) {
      snapshot = createVerificationSnapshot(root, join(root, '.gian-runtime', 'verification'));
      console.log(`[verification] GianDev stays running; isolated checkout: ${snapshot.checkout}`);
      // Verification must not inherit a live Gian/Provider runtime credential.
      for (const key of Object.keys(env)) if (key.startsWith('GIAN_')) delete env[key];
      const installed = spawnSync('pnpm', ['install', '--offline', '--frozen-lockfile'], {
        cwd: snapshot.checkout, env: { ...env, CI: 'true' }, stdio: 'inherit',
      });
      if (installed.error) throw installed.error;
      if (installed.status !== 0) throw new Error('isolated dependency install failed; live GianDev output was preserved');
    }
    const cwd = snapshot?.checkout ?? root;
    const result = spawnSync(command.command, command.args, { cwd, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (snapshot) {
      // Keep diagnostics even on failure, outside the disposable checkout.
      const artifacts = join(snapshot.runDir, 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      for (const path of ['output', 'test-results', 'playwright-report']) {
        if (existsSync(join(snapshot.checkout, path))) cpSync(join(snapshot.checkout, path), join(artifacts, path), { recursive: true });
      }
      writeFileSync(join(snapshot.runDir, 'verification.json'), JSON.stringify({ task, args, source: root, checkout: snapshot.checkout, artifacts }, null, 2) + '\n');
      snapshot.cleanup();
      console.log(`[verification] retained reports: ${relative(root, snapshot.runDir)}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = main(); } catch (error) {
    console.error(`[verification] ${error.message}`);
    process.exitCode = 1;
  }
}
