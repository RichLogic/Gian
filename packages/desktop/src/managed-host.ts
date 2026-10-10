import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, sep } from 'node:path';

export const DESKTOP_TOKEN_HEADER = 'X-Gian-Desktop-Token';

export interface ManagedHostPaths {
  hostEntry: string;
  webDist: string;
  dshBridgePackageDir: string;
  dataDir: string;
  logFile: string;
  devProxyPackagesDir?: string;
  devRuntimeAssetsDir?: string;
}

export interface ResolveManagedHostPathsOptions {
  hostEntry: string;
  resourcesPath: string;
  dataDir: string;
  sourceFirstDev?: boolean;
}

export interface StartManagedHostOptions {
  electronExecutable: string;
  paths: ManagedHostPaths;
  host: string;
  port: number;
  desktopToken: string;
  instanceId: string;
  githubBrokerSocket: string;
  remoteBrokerSocket: string;
  browserBrokerSocket: string;
  sourceFirstDev?: boolean;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export function resolveManagedHostPaths({
  hostEntry,
  resourcesPath,
  dataDir,
  sourceFirstDev = false,
}: ResolveManagedHostPathsOptions): ManagedHostPaths {
  return {
    hostEntry,
    webDist: join(resourcesPath, 'web'),
    dshBridgePackageDir: join(resourcesPath, 'dsh-bridge'),
    dataDir,
    logFile: join(dataDir, 'logs', 'desktop-host.log'),
    ...(sourceFirstDev ? {
      devProxyPackagesDir: join(resourcesPath, 'giandev', 'proxies'),
      devRuntimeAssetsDir: join(resourcesPath, 'giandev', 'runtime-assets'),
    } : {}),
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
  if (!existsSync(join(paths.dshBridgePackageDir, 'package.json'))) {
    throw new Error(`Bundled Gian DSH bridge is missing: ${paths.dshBridgePackageDir}`);
  }
  if (paths.devProxyPackagesDir && (!existsSync(paths.devProxyPackagesDir)
    || !paths.devRuntimeAssetsDir || !existsSync(join(paths.devRuntimeAssetsDir, 'runtime-assets.json')))) {
    throw new Error('GianDev source Proxy or complete Runtime assets are missing from the package.');
  }
}

export function shouldProvisionPackagedDevRuntimes(input: {
  devArtifact: boolean;
  productionDataSelected: boolean;
  smoke: boolean;
  dataDir: string;
  devDataDir: string;
}): boolean {
  return input.devArtifact
    && !input.productionDataSelected
    && (input.smoke ? input.dataDir !== input.devDataDir : input.dataDir === input.devDataDir);
}

export function buildManagedHostEnv({
  paths,
  host,
  port,
  desktopToken,
  instanceId,
  githubBrokerSocket,
  remoteBrokerSocket,
  browserBrokerSocket,
  sourceFirstDev = false,
  env = process.env,
}: Omit<StartManagedHostOptions, 'electronExecutable' | 'spawnProcess'>): NodeJS.ProcessEnv {
  const { GIAN_DEV_PROXY_PACKAGES_DIR: _proxyDir, GIAN_DEV_RUNTIME_ASSETS_DIR: _assetsDir,
    GIAN_PROVISION_DEV_RUNTIMES: provision, GIAN_DEV_RUNTIME_PROVISION_MODE: mode, ...parentEnv } = env;
  return {
    ...parentEnv,
    GIAN_DATA_DIR: paths.dataDir,
    GIAN_HOST: host,
    GIAN_PORT: String(port),
    GIAN_WEB_DIST: paths.webDist,
    GIAN_DSH_BRIDGE_PACKAGE_DIR: paths.dshBridgePackageDir,
    GIAN_DESKTOP_TOKEN: desktopToken,
    GIAN_DESKTOP_INSTANCE_ID: instanceId,
    GIAN_DESKTOP_GITHUB_BROKER_SOCKET: githubBrokerSocket,
    GIAN_DESKTOP_REMOTE_BROKER_SOCKET: remoteBrokerSocket,
    GIAN_DESKTOP_BROWSER_BROKER_SOCKET: browserBrokerSocket,
    GIAN_PARENT_MANAGED: '1',
    GIAN_MANAGED_PLUGINS: sourceFirstDev ? '0' : '1',
    ...(sourceFirstDev ? { GIAN_DEV_PROXY_PACKAGES_DIR: paths.devProxyPackagesDir,
      GIAN_DEV_RUNTIME_ASSETS_DIR: paths.devRuntimeAssetsDir,
      ...(provision === '1' ? { GIAN_PROVISION_DEV_RUNTIMES: '1' } : {}),
      ...(mode === 'isolated' && env.GIAN_DESKTOP_SMOKE_MANAGE_HOST === '1'
        ? { GIAN_DEV_RUNTIME_PROVISION_MODE: 'isolated' } : {}) } : {}),
  };
}

export function startManagedHost({
  electronExecutable,
  paths,
  host,
  port,
  desktopToken,
  instanceId,
  githubBrokerSocket,
  remoteBrokerSocket,
  browserBrokerSocket,
  sourceFirstDev = false,
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
        githubBrokerSocket,
        remoteBrokerSocket,
        browserBrokerSocket,
        sourceFirstDev,
        env,
      }),
      stdio: ['pipe', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
}
