import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog } from './test-catalog.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED_SCOPES = new Set(['unit', 'integration', 'system']);

export function sanitizedTestEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith('GIAN_')),
  );
}

export function parseRunOptions(argv, defaultScopes = ['unit', 'integration']) {
  const scopes = [];
  const files = [];
  let qualityGates = false;
  let listOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scope') {
      const scope = argv[index + 1];
      if (!scope) throw new Error('--scope requires a value');
      if (!SUPPORTED_SCOPES.has(scope)) throw new Error(`unsupported test scope: ${scope}`);
      scopes.push(scope);
      index += 1;
    } else if (arg === '--file') {
      const path = argv[index + 1];
      if (!path) throw new Error('--file requires a value');
      files.push(path);
      index += 1;
    } else if (arg === '--quality-gates') {
      qualityGates = true;
    } else if (arg === '--list') {
      listOnly = true;
    } else {
      throw new Error(`unknown test runner argument: ${arg}`);
    }
  }
  return {
    scopes: [...new Set(scopes.length > 0 ? scopes : defaultScopes)],
    files: [...new Set(files)],
    qualityGates,
    listOnly,
  };
}

export function selectCatalogEntries(entries, scopes, files = []) {
  const selected = new Set(scopes);
  const requestedFiles = new Set(files);
  if (requestedFiles.size > 0) {
    const catalogFiles = new Set(entries.map(entry => entry.path));
    const unknown = [...requestedFiles].filter(path => !catalogFiles.has(path));
    if (unknown.length > 0) throw new Error(`unknown catalog test file(s): ${unknown.join(', ')}`);
  }
  return entries.filter(entry => selected.has(entry.scope)
    && (requestedFiles.size === 0 || requestedFiles.has(entry.path)));
}

function pnpmInvocation(args) {
  const pnpmEntry = process.env.npm_execpath;
  return pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry, ...args] }
    : {
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args,
      };
}

function run(command, args, env, cwd = rootDir) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 1}`);
  }
}

function runPnpm(args, env, cwd = rootDir) {
  const invocation = pnpmInvocation(args);
  run(invocation.command, invocation.args, env, cwd);
}

function entriesForRunner(entries, runner) {
  return entries.filter(entry => entry.runner === runner).map(entry => entry.path);
}

function runNodeTests(paths, env, extraArgs = [], cwd = rootDir) {
  if (paths.length === 0) return;
  run(process.execPath, ['--test', ...extraArgs, ...paths], env, cwd);
}

function distTestPath(path, packageRoot) {
  const relativePath = relative(packageRoot, join(rootDir, path)).replace(/\.ts$/, '.js');
  return join(packageRoot, 'dist', relativePath);
}

export function builtPackageTestPlan(paths, packageRoot) {
  return {
    cwd: packageRoot,
    paths: paths.map(path => distTestPath(path, packageRoot)),
  };
}

function runBuiltPackageTests(entries, runner, packageName, packageRoot, env, extraArgs = []) {
  const paths = entriesForRunner(entries, runner);
  if (paths.length === 0) return;
  runPnpm(['--filter', packageName, 'build'], env);
  const plan = builtPackageTestPlan(paths, packageRoot);
  runNodeTests(
    plan.paths,
    env,
    extraArgs,
    plan.cwd,
  );
}

function runnerSummary(entries, scopes) {
  const counts = Object.fromEntries(scopes.map(scope => [scope, 0]));
  for (const entry of entries) counts[entry.scope] += 1;
  return scopes.map(scope => `${scope}=${counts[scope]}`).join(' ');
}

export function main(argv = process.argv.slice(2)) {
  const env = sanitizedTestEnv();
  const { catalog, entries } = loadValidatedCatalog();
  const options = parseRunOptions(argv, catalog.defaultScopes);
  const selected = selectCatalogEntries(entries, options.scopes, options.files);

  console.log(`test scopes: ${options.scopes.join(', ')}`);
  console.log(`test files: ${selected.length} (${runnerSummary(selected, options.scopes)})`);
  if (options.listOnly) {
    for (const entry of selected) console.log(`${entry.scope}\t${entry.runner}\t${entry.path}`);
    return;
  }

  runNodeTests(entriesForRunner(selected, 'scripts-node'), env);
  if (options.qualityGates) {
    run(process.execPath, ['scripts/check-ui-operations.mjs', '--strict'], env);
  }

  const nonScriptEntries = selected.filter(entry => entry.runner !== 'scripts-node');
  if (nonScriptEntries.length === 0) return;

  // Host, Web, Desktop, Shared, and all Proxy tests resolve @gian/shared from
  // its built declarations. Build it once before dispatching package runners.
  runPnpm(['--filter', '@gian/shared', 'build'], env);

  const proxyRunners = new Set([
    'proxy-protocol-node',
    'cc-proxy-node',
    'codex-proxy-node',
    'kimi-proxy-node',
    'grok-proxy-node',
    'dsh-bridge-node',
    'dsh-proxy-node',
  ]);
  if (selected.some(entry => entry.runner === 'host-node-tsx' || proxyRunners.has(entry.runner))) {
    runPnpm(['--filter', '@gian/proxy-protocol', 'build'], env);
  }

  runNodeTests(entriesForRunner(selected, 'shared-node'), env);
  const toolCliPaths = entriesForRunner(selected, 'tool-cli-node');
  const toolMcpPaths = entriesForRunner(selected, 'tool-mcp-node');
  const hostSelected = selected.some(entry => entry.runner === 'host-node-tsx');
  if (toolCliPaths.length > 0 || toolMcpPaths.length > 0 || hostSelected) {
    runPnpm(['--filter', '@gian/tool-cli', 'build'], env);
  }
  if (toolCliPaths.length > 0) {
    runNodeTests(toolCliPaths, env);
  }
  if (toolMcpPaths.length > 0 || hostSelected) {
    runPnpm(['--filter', '@gian/tool-mcp', 'build'], env);
  }
  if (toolMcpPaths.length > 0) {
    runNodeTests(toolMcpPaths, env);
  }
  const hostRoot = join(rootDir, 'packages', 'host');
  const hostPaths = entriesForRunner(selected, 'host-node-tsx')
    .map(path => relative(hostRoot, join(rootDir, path)));
  runNodeTests(
    hostPaths,
    env,
    ['--import', 'tsx', '--test-reporter', 'spec'],
    hostRoot,
  );

  const desktopRoot = join(rootDir, 'packages', 'desktop');
  const desktopPaths = entriesForRunner(selected, 'desktop-node-tsx')
    .map(path => relative(desktopRoot, join(rootDir, path)));
  runNodeTests(desktopPaths, env, ['--import', 'tsx'], desktopRoot);

  const webPaths = entriesForRunner(selected, 'web-vitest')
    .map(path => relative(join(rootDir, 'packages', 'web'), join(rootDir, path)));
  if (webPaths.length > 0) {
    runPnpm(['exec', 'vitest', 'run', ...webPaths], env, join(rootDir, 'packages', 'web'));
  }

  const protocolPaths = entriesForRunner(selected, 'proxy-protocol-node');
  if (protocolPaths.length > 0) {
    runNodeTests(protocolPaths.map(path => distTestPath(path, join(rootDir, 'packages', 'proxy-protocol'))), env);
  }
  runBuiltPackageTests(
    selected,
    'cc-proxy-node',
    '@gian/cc-proxy',
    join(rootDir, 'packages', 'proxies', 'cc-proxy'),
    env,
    ['--test-concurrency=1'],
  );
  runBuiltPackageTests(
    selected,
    'codex-proxy-node',
    '@gian/codex-proxy',
    join(rootDir, 'packages', 'proxies', 'codex-proxy'),
    env,
  );
  runBuiltPackageTests(
    selected,
    'kimi-proxy-node',
    '@gian/kimi-proxy',
    join(rootDir, 'packages', 'proxies', 'kimi-proxy'),
    env,
  );
  runBuiltPackageTests(
    selected,
    'grok-proxy-node',
    '@gian/grok-proxy',
    join(rootDir, 'packages', 'proxies', 'grok-proxy'),
    env,
  );
  runBuiltPackageTests(
    selected,
    'dsh-bridge-node',
    '@gian/dsh-bridge',
    join(rootDir, 'packages', 'proxies', 'dsh-bridge'),
    env,
  );
  runBuiltPackageTests(
    selected,
    'dsh-proxy-node',
    '@gian/dsh-proxy',
    join(rootDir, 'packages', 'proxies', 'dsh-proxy'),
    env,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
