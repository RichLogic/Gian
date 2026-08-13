import { spawn } from 'node:child_process';
import {
  DEV_HOST_URL,
  DEV_WEB_URL,
  appendLogLine,
  isProcessAlive,
  resolveDevEnvironment,
  resolveRuntimeIdentity,
  resolveRuntimePaths,
  rootDir,
  stackReadiness,
  stopProcessGroup,
  writeJsonAtomic,
} from './dev-runtime.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const identity = resolveRuntimeIdentity();
const paths = resolveRuntimePaths();
const env = resolveDevEnvironment(process.env, identity);
const startedAt = new Date().toISOString();

let services = null;
let stopping = false;
let restartCount = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function spawnGroup(args) {
  return spawn(pnpm, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
}

async function writeState(status, message, extra = {}) {
  await writeJsonAtomic(paths.servicesState, {
    ...identity,
    hostUrl: DEV_HOST_URL,
    webUrl: DEV_WEB_URL,
    supervisorPid: process.pid,
    servicesPid: services?.pid ?? null,
    status,
    message,
    startedAt,
    updatedAt: new Date().toISOString(),
    restartCount,
    ...extra,
  });
}

async function runBuild() {
  await writeState('building', 'building shared contracts and proxy entrypoints');
  const child = spawnGroup([
    '-r',
    '--filter', '@gian/shared',
    '--filter', '@gian/cc-proxy',
    '--filter', '@gian/codex-proxy',
    '--filter', '@gian/kimi-proxy',
    '--filter', '@gian/grok-proxy',
    'build',
  ]);
  services = child;
  const result = await waitForExit(child);
  services = null;
  if (result.code !== 0) {
    throw new Error(`dependency build exited with ${result.code ?? result.signal}`);
  }
}

async function waitUntilReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    if (!isProcessAlive(services?.pid)) {
      throw new Error('service group exited before readiness');
    }
    const readiness = await stackReadiness(identity.runtimeId);
    if (readiness.hostOwned && readiness.web) return;
    await delay(300);
  }
  throw new Error(`services did not become ready at ${DEV_HOST_URL} and ${DEV_WEB_URL}`);
}

async function waitUntilExitOrUnhealthy(child) {
  let failures = 0;
  while (!stopping && isProcessAlive(child.pid)) {
    const readiness = await stackReadiness(identity.runtimeId);
    failures = readiness.hostOwned && readiness.web ? 0 : failures + 1;
    if (failures >= 5) return { unhealthy: true };
    await delay(2_000);
  }
  return { unhealthy: false };
}

function stopServices() {
  if (services?.pid) stopProcessGroup(services.pid);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await writeState('stopping', 'received shutdown request');
  stopServices();
}

process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

async function supervise() {
  await runBuild();
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts && !stopping; attempt += 1) {
    await writeState('starting', `starting service group (attempt ${attempt}/${maximumAttempts})`);
    services = spawnGroup([
      '-r',
      '--parallel',
      '--filter', '!@gian/desktop',
      '--filter', '!gian',
      '--if-present',
      'dev',
    ]);
    await waitUntilReady();
    await writeState('ready', 'Host and Web are healthy');

    const outcome = await Promise.race([
      waitForExit(services).then(result => ({ source: 'exit', result })),
      waitUntilExitOrUnhealthy(services).then(result => ({ source: 'health', result })),
    ]);
    if (stopping) break;

    const reason = outcome.source === 'exit'
      ? `service group exited with ${outcome.result.code ?? outcome.result.signal}`
      : 'Host or Web failed five consecutive health checks';
    if (attempt === maximumAttempts) {
      await writeState('degraded', `${reason}; restart limit reached`);
      break;
    }
    restartCount += 1;
    await writeState('degraded', `${reason}; bounded restart ${restartCount}/${maximumAttempts - 1}`);
    stopServices();
    await Promise.race([waitForExit(services), delay(5_000)]);
    await delay(Math.min(5_000, restartCount * 1_500));
  }

  if (stopping) {
    await delay(300);
    await writeState('stopped', 'stopped by dev:down');
    return;
  }
  throw new Error('service restart limit reached');
}

supervise().catch(async error => {
  const message = error instanceof Error ? error.message : String(error);
  appendLogLine(paths.supervisorLog, `[gian-dev] supervisor failed: ${message}`);
  try {
    await writeState(stopping ? 'stopped' : 'degraded', stopping ? 'stopped by dev:down' : message);
  } catch {
    // The log still preserves the original failure when state persistence fails.
  }
  stopServices();
  process.exitCode = stopping ? 0 : 1;
});
