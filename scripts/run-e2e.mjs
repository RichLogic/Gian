import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = join(rootDir, 'packages', 'host');
const webDir = join(rootDir, 'packages', 'web');
const janitorPath = join(rootDir, 'scripts', 'e2e-janitor.mjs');

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function delaySync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listenOnOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve an E2E port'));
        return;
      }
      resolvePort({ server, port: address.port });
    });
  });
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

async function reserveE2ePorts() {
  const reservations = await Promise.all([listenOnOpenPort(), listenOnOpenPort()]);
  const ports = reservations.map(reservation => reservation.port);
  await Promise.all(reservations.map(reservation => closeServer(reservation.server)));
  return ports;
}

export function createE2eEnvironment(source, { dataDir, hostPort, webPort }) {
  const clean = sanitizedTestEnv(source);
  delete clean.FORCE_COLOR;
  delete clean.NO_COLOR;
  return {
    ...clean,
    GIAN_DATA_DIR: dataDir,
    GIAN_E2E_DATA_DIR: dataDir,
    GIAN_E2E_EXTERNAL_SERVERS: '1',
    GIAN_E2E_ISOLATED: '1',
    GIAN_HOST: '127.0.0.1',
    GIAN_HOST_PORT: String(hostPort),
    GIAN_PORT: String(hostPort),
    GIAN_SKIP_PROXY_WARMUP: '1',
    GIAN_WEB_PORT: String(webPort),
  };
}

function startProcess(args, { cwd, env }) {
  return spawn(process.execPath, args, {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: 'inherit',
  });
}

function startJanitor(dataDir) {
  const janitor = spawn(process.execPath, [
    janitorPath,
    '--parent', String(process.pid),
    '--data-dir', dataDir,
  ], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  janitor.unref();
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return;
    }
    // The detached leader can exit before its Playwright workers, Proxy, or
    // PTY descendants. Address the process group even after the leader closes
    // so an interrupted quality gate cannot orphan those descendants.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processGroupAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessGroup(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(child) && Date.now() < deadline) await delay(100);
  return !processGroupAlive(child);
}

async function stopProcess(child) {
  if (!processGroupAlive(child)) return;
  signalProcessGroup(child, 'SIGTERM');
  if (await waitForProcessGroup(child, 15_000)) return;
  signalProcessGroup(child, 'SIGKILL');
  await waitForProcessGroup(child, 5_000);
}

async function waitForService(label, url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before becoming ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`${label} readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${label} did not become ready: ${lastError ?? 'timeout'}`);
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  const result = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolveResult({ signal, status }));
  });
  return { child, result };
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

function interruptedExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

export async function main(args = process.argv.slice(2)) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-e2e-'));
  startJanitor(dataDir);
  const [hostPort, webPort] = await reserveE2ePorts();
  const env = createE2eEnvironment(process.env, { dataDir, hostPort, webPort });
  const command = pnpmInvocation(['exec', 'playwright', 'test', ...args]);
  let host;
  let playwright;
  let web;
  let interruptedSignal;

  const emergencyCleanup = signal => {
    signalProcessGroup(playwright, signal);
    signalProcessGroup(web, 'SIGTERM');
    signalProcessGroup(host, 'SIGTERM');
    // Package-manager wrappers may exit on Ctrl+C before this runner's async
    // finally block completes. Give Host a moment to close SQLite before
    // removing the isolated directory synchronously; otherwise its shutdown
    // path can recreate the database after an eager removal.
    delaySync(500);
    rmSync(dataDir, { recursive: true, force: true });
  };
  const onSigint = () => {
    interruptedSignal = 'SIGINT';
    emergencyCleanup('SIGINT');
  };
  const onSigterm = () => {
    interruptedSignal = 'SIGTERM';
    emergencyCleanup('SIGTERM');
  };
  const onSighup = () => {
    interruptedSignal = 'SIGHUP';
    emergencyCleanup('SIGHUP');
  };
  const onExit = () => emergencyCleanup('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  if (process.platform !== 'win32') process.once('SIGHUP', onSighup);
  process.once('exit', onExit);

  console.log(`[e2e] isolated host=:${hostPort} web=:${webPort} data=${dataDir}`);
  try {
    host = startProcess(['dist/index.js'], { cwd: hostDir, env });
    web = startProcess(['node_modules/vite/bin/vite.js', 'preview'], { cwd: webDir, env });
    await Promise.all([
      waitForService('Host', `http://127.0.0.1:${hostPort}/health`, host),
      waitForService('Web', `http://127.0.0.1:${webPort}`, web),
    ]);
    if (interruptedSignal) return interruptedExitCode(interruptedSignal);

    const running = await runProcess(command.command, command.args, {
      cwd: rootDir,
      env,
    });
    playwright = running.child;
    const result = await running.result;
    if (interruptedSignal) return interruptedExitCode(interruptedSignal);
    return result.status ?? 1;
  } finally {
    await Promise.all([stopProcess(playwright), stopProcess(web), stopProcess(host)]);
    await rm(dataDir, { recursive: true, force: true });
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (process.platform !== 'win32') process.off('SIGHUP', onSighup);
    process.off('exit', onExit);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('[e2e] failed to start', error);
    process.exitCode = 1;
  }
}
