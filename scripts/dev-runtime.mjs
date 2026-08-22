import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_HOST_PORT = 8991;
export const DEV_WEB_PORT = 5191;
export const DEV_HOST_URL = `http://127.0.0.1:${DEV_HOST_PORT}`;
export const DEV_WEB_URL = `http://127.0.0.1:${DEV_WEB_PORT}`;
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23ligpkx0f2qrz4B2k';

export const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseVersion = JSON.parse(
  readFileSync(join(rootDir, 'package.json'), 'utf8'),
).version;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export function resolveRuntimePaths(worktree = rootDir) {
  const runtimeDir = join(worktree, '.gian-runtime');
  const logsDir = join(runtimeDir, 'logs');
  return {
    runtimeDir,
    logsDir,
    servicesState: join(runtimeDir, 'services.json'),
    desktopState: join(runtimeDir, 'desktop.json'),
    supervisorLog: join(logsDir, 'supervisor.log'),
    desktopLog: join(logsDir, 'desktop.log'),
  };
}

function gitValue(worktree, args) {
  const result = spawnSync('git', args, {
    cwd: worktree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function resolveRuntimeIdentity(worktree = rootDir) {
  const branch = gitValue(worktree, ['branch', '--show-current']) || 'detached';
  const revision = gitValue(worktree, ['rev-parse', '--short=12', 'HEAD']) || 'unknown';
  const slug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || basename(worktree);
  const worktreeHash = createHash('sha256').update(worktree).digest('hex').slice(0, 8);
  return {
    runtimeId: `${slug}-${worktreeHash}`,
    worktree,
    branch,
    revision,
    label: `GianDev · ${branch}`,
  };
}

export function resolveDevEnvironment(
  env = process.env,
  identity = resolveRuntimeIdentity(),
) {
  const githubClientId = env.GIAN_GITHUB_CLIENT_ID?.trim()
    || DEFAULT_GITHUB_CLIENT_ID;
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIAN_')),
  );
  const proxyEntries = {};
  for (const key of [
    'GIAN_CC_PROXY_ENTRY',
    'GIAN_CODEX_PROXY_ENTRY',
    'GIAN_KIMI_PROXY_ENTRY',
    'GIAN_GROK_PROXY_ENTRY',
  ]) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value) proxyEntries[key] = value;
  }
  const isolatedDataDir = typeof env.GIAN_DEV_DATA_DIR === 'string'
    ? env.GIAN_DEV_DATA_DIR.trim()
    : '';
  const desktopUserDataDir = typeof env.GIAN_DESKTOP_USER_DATA_DIR === 'string'
    ? env.GIAN_DESKTOP_USER_DATA_DIR.trim()
    : '';
  const githubBrokerSocket = join(
    tmpdir(),
    `gian-github-${createHash('sha256').update(identity.runtimeId).digest('hex').slice(0, 24)}.sock`,
  );
  return {
    ...clean,
    ...proxyEntries,
    GIAN_HOST: '127.0.0.1',
    GIAN_PORT: String(DEV_HOST_PORT),
    GIAN_HOST_PORT: String(DEV_HOST_PORT),
    GIAN_WEB_PORT: String(DEV_WEB_PORT),
    GIAN_DATA_DIR: isolatedDataDir || join(homedir(), '.gian-dev'),
    ...(isolatedDataDir ? { GIAN_DEV_DATA_DIR: isolatedDataDir } : {}),
    ...(desktopUserDataDir ? { GIAN_DESKTOP_USER_DATA_DIR: desktopUserDataDir } : {}),
    GIAN_DESKTOP_HOST_URL: DEV_HOST_URL,
    GIAN_DESKTOP_WEB_URL: DEV_WEB_URL,
    GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT: '1',
    GIAN_GITHUB_CLIENT_ID: githubClientId,
    GIAN_DESKTOP_GITHUB_BROKER_SOCKET: githubBrokerSocket,
    GIAN_RELEASE_VERSION: releaseVersion,
    GIAN_DEV_RUNTIME_ID: identity.runtimeId,
    GIAN_DEV_WORKTREE: identity.worktree,
    GIAN_DESKTOP_LABEL: identity.label,
  };
}

export function parseDevArguments(args) {
  args = args.filter(arg => arg !== '--');
  if (args.length === 1 && args[0] === '--no-desktop') {
    return { command: 'up', target: null };
  }
  const command = args[0] ?? 'start';
  const target = args[1] ?? null;
  const allowed = new Set(['start', 'up', 'open', 'chrome', 'status', 'restart', 'down']);
  if (!allowed.has(command)) throw new Error(`unknown dev command: ${command}`);
  if (args.length > 2) throw new Error(`too many arguments for dev command: ${command}`);
  if (command !== 'restart' && target) {
    throw new Error(`${command} does not accept a target`);
  }
  if (command === 'restart' && target && !['all', 'desktop', 'services'].includes(target)) {
    throw new Error(`unknown restart target: ${target}`);
  }
  return { command, target };
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function request(url, json = false) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    return json ? await response.json() : true;
  } catch {
    return null;
  }
}

export async function stackReadiness(runtimeId) {
  const [hostBody, web] = await Promise.all([
    request(`${DEV_HOST_URL}/health`, true),
    request(DEV_WEB_URL),
  ]);
  return {
    host: hostBody?.ok === true,
    hostOwned: hostBody?.ok === true && hostBody?.devRuntimeId === runtimeId,
    hostBody,
    web: web === true,
  };
}

export function stopProcessGroup(pid, signal = 'SIGTERM') {
  if (!isProcessAlive(pid)) return false;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}

async function addFilesToHash(hash, path) {
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) await addFilesToHash(hash, entryPath);
    else if (entry.isFile()) {
      hash.update(entryPath.slice(rootDir.length));
      hash.update(await readFile(entryPath));
    }
  }
}

async function desktopSourceFingerprint() {
  const hash = createHash('sha256');
  for (const path of [
    join(rootDir, 'packages', 'desktop', 'src'),
    join(rootDir, 'packages', 'desktop', 'renderer'),
    join(rootDir, 'packages', 'desktop', 'package.json'),
    join(rootDir, 'packages', 'desktop', 'tsconfig.json'),
  ]) {
    if (statSync(path).isDirectory()) {
      await addFilesToHash(hash, path);
    } else {
      hash.update(path.slice(rootDir.length));
      hash.update(await readFile(path));
    }
  }
  return hash.digest('hex');
}

async function ensureRuntimeDirectories(paths) {
  await Promise.all([
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
  ]);
}

function spawnDetached(command, args, { env, logPath }) {
  const output = openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', output, output],
  });
  closeSync(output);
  child.unref();
  return child;
}

async function runForeground(command, args, env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.code ?? result.signal}`);
  }
}

async function ensureServices() {
  const identity = resolveRuntimeIdentity();
  const paths = resolveRuntimePaths();
  await ensureRuntimeDirectories(paths);

  const existing = await readJson(paths.servicesState);
  if (
    existing?.runtimeId === identity.runtimeId
    && isProcessAlive(existing.supervisorPid)
  ) {
    const readiness = await stackReadiness(identity.runtimeId);
    if (existing.status === 'ready' && readiness.hostOwned && readiness.web) {
      return { identity, paths, state: existing };
    }
    const recovered = await waitFor(async () => {
      const state = await readJson(paths.servicesState);
      const next = await stackReadiness(identity.runtimeId);
      return next.hostOwned && next.web ? state : null;
    }, 120_000);
    if (recovered) return { identity, paths, state: recovered };
    const finalState = await readJson(paths.servicesState);
    throw new Error(
      `GianDev services did not recover: ${finalState?.message ?? 'unknown error'}; `
      + `inspect ${paths.supervisorLog}`,
    );
  }

  const occupied = await stackReadiness(identity.runtimeId);
  if (occupied.host || occupied.web) {
    const owner = occupied.hostBody?.devWorktree
      ? ` by ${occupied.hostBody.devWorktree}`
      : '';
    throw new Error(
      `ports ${DEV_HOST_PORT}/${DEV_WEB_PORT} are already occupied${owner}, `
      + 'but are not owned by this worktree runtime; do not reuse or kill them blindly',
    );
  }

  await rm(paths.servicesState, { force: true });
  const supervisor = spawnDetached(
    process.execPath,
    [join(rootDir, 'scripts', 'dev-supervisor.mjs')],
    { env: resolveDevEnvironment(process.env, identity), logPath: paths.supervisorLog },
  );
  await writeJsonAtomic(paths.servicesState, {
    ...identity,
    hostUrl: DEV_HOST_URL,
    webUrl: DEV_WEB_URL,
    supervisorPid: supervisor.pid,
    servicesPid: null,
    status: 'starting',
    message: 'supervisor launched',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    restartCount: 0,
  });

  const ready = await waitFor(async () => {
    const state = await readJson(paths.servicesState);
    if (state?.status === 'degraded' || state?.status === 'stopped') {
      throw new Error(`GianDev startup failed: ${state.message ?? state.status}`);
    }
    if (!isProcessAlive(supervisor.pid)) {
      throw new Error(`GianDev supervisor exited; inspect ${paths.supervisorLog}`);
    }
    const readiness = await stackReadiness(identity.runtimeId);
    return state?.status === 'ready' && readiness.hostOwned && readiness.web
      ? state
      : null;
  }, 120_000);
  if (!ready) throw new Error(`GianDev startup timed out; inspect ${paths.supervisorLog}`);
  return { identity, paths, state: ready };
}

async function focusOrOpenDesktop(runtime) {
  const { identity, paths } = runtime;
  const env = resolveDevEnvironment(process.env, identity);
  const existing = await readJson(paths.desktopState);
  const sourceFingerprint = await desktopSourceFingerprint();
  if (
    existing?.runtimeId === identity.runtimeId
    && existing.sourceFingerprint === sourceFingerprint
    && isProcessAlive(existing.pid)
  ) {
    spawnDetached(
      pnpm,
      ['--filter', '@gian/desktop', 'start'],
      { env, logPath: paths.desktopLog },
    );
    console.log(`[gian-dev] GianDev is already running; focused ${identity.label}`);
    return existing;
  }

  if (existing?.pid && isProcessAlive(existing.pid)) {
    console.log('[gian-dev] desktop sources changed; replacing only the GianDev shell...');
    await stopDesktop(paths);
  }

  await rm(paths.desktopState, { force: true });
  console.log('[gian-dev] building the desktop shell...');
  await runForeground(pnpm, ['--filter', '@gian/desktop', 'build'], env);
  const desktop = spawnDetached(
    pnpm,
    ['--filter', '@gian/desktop', 'start'],
    { env, logPath: paths.desktopLog },
  );
  const state = {
    runtimeId: identity.runtimeId,
    worktree: identity.worktree,
    label: identity.label,
    pid: desktop.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
    logPath: paths.desktopLog,
    sourceFingerprint,
  };
  await writeJsonAtomic(paths.desktopState, state);
  await delay(1_500);
  if (!isProcessAlive(desktop.pid)) {
    throw new Error(`GianDev desktop exited during startup; inspect ${paths.desktopLog}`);
  }
  console.log(`[gian-dev] opened ${identity.label}`);
  return state;
}

async function stopDesktop(paths) {
  const state = await readJson(paths.desktopState);
  if (!state?.pid || !isProcessAlive(state.pid)) {
    await rm(paths.desktopState, { force: true });
    return false;
  }
  stopProcessGroup(state.pid);
  const stopped = await waitFor(() => !isProcessAlive(state.pid), 10_000);
  if (!stopped) throw new Error(`GianDev desktop pid ${state.pid} did not stop`);
  await rm(paths.desktopState, { force: true });
  return true;
}

async function stopServices(paths) {
  const state = await readJson(paths.servicesState);
  if (!state?.supervisorPid || !isProcessAlive(state.supervisorPid)) return false;
  process.kill(state.supervisorPid, 'SIGTERM');
  const stopped = await waitFor(() => !isProcessAlive(state.supervisorPid), 15_000);
  if (!stopped) throw new Error(`GianDev supervisor pid ${state.supervisorPid} did not stop`);
  return true;
}

async function showStatus() {
  const identity = resolveRuntimeIdentity();
  const paths = resolveRuntimePaths();
  const [services, desktop, readiness] = await Promise.all([
    readJson(paths.servicesState),
    readJson(paths.desktopState),
    stackReadiness(identity.runtimeId),
  ]);
  const supervisorAlive = isProcessAlive(services?.supervisorPid);
  const desktopAlive = isProcessAlive(desktop?.pid);
  const serviceStatus = (
    supervisorAlive && readiness.hostOwned && readiness.web
      ? 'ready'
      : services?.status ?? 'stopped'
  );
  console.log(`GianDev runtime: ${identity.runtimeId}`);
  console.log(`Worktree:        ${identity.worktree}`);
  console.log(`Branch/revision: ${identity.branch} @ ${identity.revision}`);
  console.log(`Services:        ${serviceStatus}${supervisorAlive ? ` (supervisor ${services.supervisorPid})` : ''}`);
  console.log(`Host:            ${readiness.hostOwned ? 'ready' : readiness.host ? 'foreign' : 'stopped'} ${DEV_HOST_URL}`);
  console.log(`Web:             ${readiness.web ? 'ready' : 'stopped'} ${DEV_WEB_URL}`);
  console.log(`Desktop:         ${desktopAlive ? `running (pid ${desktop.pid})` : 'stopped'}`);
  console.log(`Logs:            ${paths.logsDir}`);
  if (services?.message && serviceStatus !== 'ready') {
    console.log(`Detail:          ${services.message}`);
  }
  return { identity, paths, services, desktop, readiness };
}

async function openChrome() {
  await ensureServices();
  const command = process.platform === 'darwin'
    ? ['open', ['-a', 'Google Chrome', DEV_WEB_URL]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', DEV_WEB_URL]]
      : ['xdg-open', [DEV_WEB_URL]];
  const child = spawn(command[0], command[1], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[gian-dev] opened browser-only debug surface at ${DEV_WEB_URL}`);
}

async function start() {
  const runtime = await ensureServices();
  console.log(`[gian-dev] services ready at ${DEV_HOST_URL} and ${DEV_WEB_URL}`);
  await focusOrOpenDesktop(runtime);
}

async function up() {
  const runtime = await ensureServices();
  console.log(`[gian-dev] services ready for ${runtime.identity.label}`);
  console.log(`[gian-dev] web debug URL: ${DEV_WEB_URL}`);
}

async function down() {
  const paths = resolveRuntimePaths();
  const desktopStopped = await stopDesktop(paths);
  const servicesStopped = await stopServices(paths);
  console.log(
    `[gian-dev] stopped desktop=${desktopStopped ? 'yes' : 'already stopped'}, `
    + `services=${servicesStopped ? 'yes' : 'already stopped'}`,
  );
}

async function restart(target) {
  const paths = resolveRuntimePaths();
  if (target === 'desktop') {
    await stopDesktop(paths);
    await focusOrOpenDesktop(await ensureServices());
    return;
  }
  if (target === 'services') {
    await stopServices(paths);
    await ensureServices();
    console.log('[gian-dev] services restarted');
    return;
  }
  await down();
  await start();
}

export async function main(args = process.argv.slice(2)) {
  const { command, target } = parseDevArguments(args);
  switch (command) {
    case 'start': return start();
    case 'up': return up();
    case 'open': return focusOrOpenDesktop(await ensureServices());
    case 'chrome': return openChrome();
    case 'status': return showStatus();
    case 'restart': return restart(target ?? 'all');
    case 'down': return down();
    default: throw new Error(`unhandled dev command: ${command}`);
  }
}

export function appendLogLine(path, line) {
  if (!existsSync(dirname(path))) return;
  const stream = createWriteStream(path, { flags: 'a' });
  stream.end(`${line}\n`);
}
