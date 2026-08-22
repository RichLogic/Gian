import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAffectedPlan, checkSelectionMap } from './test-selection.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseAffectedOptions(argv) {
  const options = {
    base: undefined,
    head: 'HEAD',
    changedFiles: [],
    stage: 'quick',
    execute: false,
    json: false,
    checkMap: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--base' || arg === '--head' || arg === '--changed-file' || arg === '--stage') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--base') options.base = value;
      else if (arg === '--head') options.head = value;
      else if (arg === '--changed-file') options.changedFiles.push(value);
      else options.stage = value;
      index += 1;
    } else if (arg === '--execute') options.execute = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--check-map') options.checkMap = true;
    else throw new Error(`unknown affected-test argument: ${arg}`);
  }
  if (!['quick', 'merge'].includes(options.stage)) {
    throw new Error(`unsupported affected-test stage: ${options.stage}`);
  }
  if (!options.checkMap && options.changedFiles.length === 0 && !options.base) {
    throw new Error('provide --base <revision> or at least one --changed-file <path>');
  }
  return options;
}

export function discoverChangedFiles(base, head = 'HEAD', cwd = rootDir) {
  const runGit = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.status}`);
    return result.stdout.split('\0').filter(Boolean);
  };
  const files = new Set(runGit([
    'diff', '--name-only', '--diff-filter=ACMRD', '-z', `${base}...${head}`,
  ]));
  if (head === 'HEAD') {
    for (const path of runGit(['diff', '--name-only', '--diff-filter=ACMRD', '-z', 'HEAD'])) files.add(path);
    for (const path of runGit(['ls-files', '--others', '--exclude-standard', '-z'])) files.add(path);
  }
  return [...files].sort();
}

function pnpmInvocation(args) {
  const pnpmEntry = process.env.npm_execpath;
  return pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry, ...args] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: rootDir, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 1}`);
}

export function affectedExecutionPlan(plan) {
  const commands = plan.checks.map(check => ({ kind: 'check', command: 'pnpm', args: [check.id] }));
  if (plan.runnableTests.length > 0) {
    const scopes = [...new Set(plan.runnableTests.map(entry => entry.scope))];
    commands.push({
      kind: 'tests',
      command: 'node',
      args: [
        'scripts/run-tests.mjs',
        ...scopes.flatMap(scope => ['--scope', scope]),
        ...plan.runnableTests.flatMap(entry => ['--file', entry.path]),
      ],
    });
  }
  return commands;
}

export function executeAffectedPlan(plan) {
  const env = sanitizedTestEnv();
  for (const command of affectedExecutionPlan(plan)) {
    if (command.command === 'pnpm') {
      const invocation = pnpmInvocation(command.args);
      run(invocation.command, invocation.args, env);
    } else {
      run(process.execPath, command.args, env);
    }
  }
}

function printTests(label, tests) {
  console.log(`${label}: ${tests.length}`);
  for (const entry of tests) {
    console.log(`  [${entry.scope}] ${entry.path}`);
    for (const reason of entry.reasons) console.log(`    because: ${reason}`);
  }
}

export function printAffectedPlan(plan) {
  console.log(`affected stage: ${plan.stage}`);
  console.log(`changed files: ${plan.changedFiles.length}`);
  for (const path of plan.changedFiles) console.log(`  ${path}`);
  console.log(`fallback full suite: ${plan.fallbackFull ? 'yes' : 'no'}`);
  console.log(`checks: ${plan.checks.length ? plan.checks.map(check => check.id).join(', ') : 'none'}`);
  printTests('runnable tests', plan.runnableTests);
  printTests('deferred tests', plan.deferredTests);
  console.log(`deferred entrypoints: ${plan.deferredEntrypoints.length}`);
  for (const entrypoint of plan.deferredEntrypoints) {
    console.log(`  ${entrypoint.id}: ${entrypoint.path}`);
    console.log(`    because: ${entrypoint.reason}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseAffectedOptions(argv);
  if (options.checkMap) {
    checkSelectionMap();
    console.log('test-selection: map is valid');
    return;
  }
  const changedFiles = options.changedFiles.length > 0
    ? options.changedFiles
    : discoverChangedFiles(options.base, options.head);
  if (changedFiles.length === 0) {
    console.log('affected tests: no changed files');
    return;
  }
  const plan = buildAffectedPlan(changedFiles, options.stage);
  if (options.json) console.log(JSON.stringify(plan, null, 2));
  else printAffectedPlan(plan);
  if (options.execute) executeAffectedPlan(plan);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
