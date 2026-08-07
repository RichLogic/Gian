import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  return {
    ...clean,
    GIAN_DATA_DIR: dataDir,
    GIAN_E2E_DATA_DIR: dataDir,
    GIAN_E2E_ISOLATED: '1',
    GIAN_HOST: '127.0.0.1',
    GIAN_HOST_PORT: String(hostPort),
    GIAN_PORT: String(hostPort),
    GIAN_SKIP_PROXY_WARMUP: '1',
    GIAN_WEB_PORT: String(webPort),
    NO_COLOR: '1',
  };
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

export async function main(args = process.argv.slice(2)) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-e2e-'));
  const [hostPort, webPort] = await reserveE2ePorts();
  const env = createE2eEnvironment(process.env, { dataDir, hostPort, webPort });
  const command = pnpmInvocation(['exec', 'playwright', 'test', ...args]);

  console.log(`[e2e] isolated host=:${hostPort} web=:${webPort} data=${dataDir}`);
  try {
    const result = spawnSync(command.command, command.args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
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
