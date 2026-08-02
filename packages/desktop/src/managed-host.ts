import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, sep } from 'node:path';

export const DESKTOP_TOKEN_HEADER = 'X-Gian-Desktop-Token';

export interface ManagedHostPaths {
  hostEntry: string;
  webDist: string;
  dataDir: string;
  logFile: string;
}

export interface ResolveManagedHostPathsOptions {
  hostEntry: string;
  resourcesPath: string;
  dataDir: string;
}

export interface StartManagedHostOptions {
  electronExecutable: string;
  paths: ManagedHostPaths;
  host: string;
  port: number;
  desktopToken: string;
  instanceId: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export function resolveManagedHostPaths({
  hostEntry,
  resourcesPath,
  dataDir,
}: ResolveManagedHostPathsOptions): ManagedHostPaths {
  return {
    hostEntry,
    webDist: join(resourcesPath, 'web'),
    dataDir,
    logFile: join(dataDir, 'logs', 'desktop-host.log'),
  };
}

export function resolveUnpackedAppPath(path: string): string {
  return path.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
}

export function validateManagedHostPaths(paths: ManagedHostPaths): void {
  if (!existsSync(paths.hostEntry)) {
    throw new Error(`Bundled Gian Host is missing: ${paths.hostEntry}`);
  }
  if (!existsSync(join(paths.webDist, 'index.html'))) {
    throw new Error(`Bundled Gian Web assets are missing: ${paths.webDist}`);
  }
}

export function buildManagedHostEnv({
  paths,
  host,
  port,
  desktopToken,
  instanceId,
  env = process.env,
}: Omit<StartManagedHostOptions, 'electronExecutable' | 'spawnProcess'>): NodeJS.ProcessEnv {
  return {
    ...env,
    GIAN_DATA_DIR: paths.dataDir,
    GIAN_HOST: host,
    GIAN_PORT: String(port),
    GIAN_WEB_DIST: paths.webDist,
    GIAN_DESKTOP_TOKEN: desktopToken,
    GIAN_DESKTOP_INSTANCE_ID: instanceId,
    GIAN_PARENT_MANAGED: '1',
    GIAN_MANAGED_PLUGINS: '1',
  };
}

export function startManagedHost({
  electronExecutable,
  paths,
  host,
  port,
  desktopToken,
  instanceId,
  env = process.env,
  spawnProcess = spawn,
}: StartManagedHostOptions): ChildProcess {
  validateManagedHostPaths(paths);
  mkdirSync(join(paths.dataDir, 'logs'), { recursive: true });

  const logFd = openSync(paths.logFile, 'a');
  try {
    return spawnProcess(electronExecutable, [paths.hostEntry], {
      env: buildManagedHostEnv({
        paths,
        host,
        port,
        desktopToken,
        instanceId,
        env,
      }),
      stdio: ['pipe', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
}
