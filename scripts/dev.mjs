import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_HOST_URL = 'http://127.0.0.1:8991';
export const DEV_WEB_URL = 'http://127.0.0.1:5191';
// OAuth Client IDs are public identifiers, not secrets. Keep GianDev usable
// from Finder, Codex, and launchd shells that do not inherit a developer's
// ad-hoc environment; forks can still override this value explicitly.
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23ligpkx0f2qrz4B2k';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export function resolveDevEnvironment(env = process.env) {
  const githubClientId = env.GIAN_GITHUB_CLIENT_ID?.trim()
    || DEFAULT_GITHUB_CLIENT_ID;
  // Drop every inherited GIAN_* var before pinning the dev values: a shell
  // launched from the production Gian desktop carries GIAN_DESKTOP_TOKEN,
  // GIAN_PARENT_MANAGED, GIAN_WEB_DIST, GIAN_PORT=8990, … — leaking them makes
  // the GianDev host enforce the production desktop token (readiness probe
  // gets `desktop_client_required`), serve the production web dist, and shut
  // down when the parent's stdin closes (2026-08-05). The honored overrides
  // (GIAN_DEV_DATA_DIR, GIAN_GITHUB_CLIENT_ID) are read from `env` directly
  // and re-set explicitly below.
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIAN_')),
  );
  return {
    ...clean,
    GIAN_HOST: '127.0.0.1',
    GIAN_PORT: '8991',
    GIAN_HOST_PORT: '8991',
    GIAN_WEB_PORT: '5191',
    GIAN_DATA_DIR: env.GIAN_DEV_DATA_DIR ?? join(homedir(), '.gian-dev'),
    GIAN_DESKTOP_HOST_URL: DEV_HOST_URL,
    GIAN_DESKTOP_WEB_URL: DEV_WEB_URL,
    GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT: '1',
    GIAN_GITHUB_CLIENT_ID: githubClientId,
  };
}

export function parseDevArguments(args) {
  const unknown = args.filter(arg => arg !== '--no-desktop');
  if (unknown.length > 0) {
    throw new Error(`unknown dev option: ${unknown.join(', ')}`);
  }
  return { desktop: !args.includes('--no-desktop') };
}

async function requestReady(url, validate) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    return validate ? validate(await response.json()) : true;
  } catch {
    return false;
  }
}

async function stackReadiness() {
  const [host, web] = await Promise.all([
    requestReady(`${DEV_HOST_URL}/health`, body => body?.ok === true),
    requestReady(DEV_WEB_URL),
  ]);
  return { host, web };
}

function spawnGroup(args, env) {
  return spawn(pnpm, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
}

function stopGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
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

async function runCommand(args, env) {
  const child = spawnGroup(args, env);
  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(`${pnpm} ${args.join(' ')} exited with ${result.code ?? result.signal}`);
  }
}

async function waitForStack(services, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (services.exitCode !== null || services.signalCode !== null) {
      throw new Error('GianDev services exited before becoming ready');
    }
    const readiness = await stackReadiness();
    if (readiness.host && readiness.web) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`GianDev did not become ready at ${DEV_HOST_URL} and ${DEV_WEB_URL}`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDevArguments(args);
  const env = resolveDevEnvironment();
  const initial = await stackReadiness();
  if (initial.host !== initial.web) {
    throw new Error(
      `partial GianDev stack detected (host=${initial.host}, web=${initial.web}); stop it before restarting`,
    );
  }

  let services = null;
  let desktop = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopGroup(desktop);
    stopGroup(services);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    if (!initial.host) {
      console.log('[gian-dev] building shared contracts and proxy entrypoints...');
      await runCommand([
        '-r',
        '--filter', '@gian/shared',
        '--filter', '@gian/cc-proxy',
        '--filter', '@gian/codex-proxy',
        '--filter', '@gian/kimi-proxy',
        'build',
      ], env);

      console.log(`[gian-dev] starting services on ${DEV_HOST_URL} and ${DEV_WEB_URL}...`);
      services = spawnGroup([
        '-r',
        '--parallel',
        '--filter', '!@gian/desktop',
        // Exclusion-only filters also select the workspace ROOT package, whose
        // "dev" script is this very script — without `!gian` the services
        // group recursively re-runs dev.mjs, which wipes shared/dist mid-boot
        // and races the outer Vite for port 5191 (2026-08-05).
        '--filter', '!gian',
        '--if-present',
        'dev',
      ], env);
      await waitForStack(services);
    } else {
      console.log('[gian-dev] reusing the running 8991/5191 development stack');
    }

    if (!options.desktop) {
      console.log(`[gian-dev] ready at ${DEV_WEB_URL} (desktop disabled)`);
      if (!services) return;
      await waitForExit(services);
      return;
    }

    console.log('[gian-dev] launching the GianDev desktop app...');
    desktop = spawnGroup(['--filter', '@gian/desktop', 'dev'], env);
    const outcome = services
      ? await Promise.race([
          waitForExit(desktop).then(result => ({ source: 'desktop', result })),
          waitForExit(services).then(result => ({ source: 'services', result })),
        ])
      : { source: 'desktop', result: await waitForExit(desktop) };
    if (outcome.source === 'services' && !stopping) {
      throw new Error(
        `GianDev services exited with ${outcome.result.code ?? outcome.result.signal}`,
      );
    }
    if (outcome.source === 'desktop' && outcome.result.code !== 0 && !stopping) {
      throw new Error(`GianDev desktop exited with ${outcome.result.code ?? outcome.result.signal}`);
    }
  } finally {
    stop();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(error => {
    console.error(`[gian-dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
