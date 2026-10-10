import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { recordRuntimeArtifact, runtimeFileInventory, verifiedRuntimeReuse } from './artifact-reuse.js';
import { devRuntimeCoordinates, type DevRuntimeCoordinate } from './dev-runtime-coordinates.js';
import { downloadDevRuntimeAsset } from './dev-runtime-assets.js';
import { ManagedRuntimeInstallError } from './errors.js';
import { extractManagedRuntimeArchive } from './safe-extract.js';
import { packageDirectoryFromEntry } from './trusted-launch.js';

export type { DevRuntimeCoordinate };

export interface DevRuntimeDeclaration {
  pluginId: string;
  runtimeId: string;
  versions: readonly string[];
}

export interface ProvisionedDevRuntime {
  pluginId: string;
  runtimeId: string;
  version: string;
  entryPath: string;
  artifactSha256: string;
  entryRelativePath?: string;
}

const COORDINATES: readonly DevRuntimeCoordinate[] = devRuntimeCoordinates;

export function devRuntimeDataDirectory(homeDir = homedir()): string {
  return join(homeDir, '.gian-dev');
}

export function shouldProvisionDevRuntimes(env: NodeJS.ProcessEnv): boolean {
  return env.GIAN_PROVISION_DEV_RUNTIMES === '1'
    && (env.GIAN_DESKTOP_SMOKE_MANAGE_HOST !== '1' || env.GIAN_DEV_RUNTIME_PROVISION_MODE === 'isolated');
}

export function preferProvisionedRuntime(
  certified: string | null,
  pluginId: string,
  provisioned: ReadonlyMap<string, string>,
): string | null {
  return certified ?? provisioned.get(pluginId) ?? null;
}

export function selectDevRuntimeCoordinates(
  declarations: readonly DevRuntimeDeclaration[],
  coordinates: readonly DevRuntimeCoordinate[] = COORDINATES,
): DevRuntimeCoordinate[] {
  const selected: DevRuntimeCoordinate[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.versions.length === 0) {
      throw new Error(`${declaration.pluginId} does not declare a Runtime version.`);
    }
    for (const version of declaration.versions) {
      const coordinate = coordinates.find(item => (
        item.runtimeId === declaration.runtimeId && item.version === version
      ));
      if (!coordinate || coordinate.pluginId !== declaration.pluginId) {
        throw new Error(
          `${declaration.pluginId} Runtime ${declaration.runtimeId} ${version} has no pinned GianDev CLI coordinate.`,
        );
      }
      const key = `${coordinate.pluginId}\0${coordinate.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(coordinate);
    }
  }
  return selected;
}

export async function assertGianDevRuntimeDataDir(
  dataDir: string,
  homeDir: string,
  mode: 'giandev' | 'isolated',
): Promise<void> {
  const devDir = resolve(devRuntimeDataDirectory(homeDir));
  const productionDir = resolve(join(homeDir, '.gian'));
  const requested = resolve(dataDir);
  if (requested === productionDir) {
    throw new Error('Refusing to provision Runtimes into production ~/.gian.');
  }
  if (mode === 'giandev' && requested !== devDir) {
    throw new Error('GianDev Runtime provisioning only writes ~/.gian-dev/runtimes.');
  }
  if (mode === 'isolated' && (requested === devDir || requested === productionDir)) {
    throw new Error('Isolated Runtime provisioning cannot use Gian data directories.');
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  if ((await lstat(requested)).isSymbolicLink()) {
    throw new Error('GianDev data directory must not be a symlink.');
  }
}

export async function declarationsFromProxyEntries(
  entries: Readonly<Record<string, string>>,
): Promise<DevRuntimeDeclaration[]> {
  const declarations: DevRuntimeDeclaration[] = [];
  for (const entry of Object.values(entries)) {
    const directory = await packageDirectoryFromEntry(entry);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      id?: unknown;
      runtime?: { id?: unknown; verifiedVersions?: unknown };
    };
    const versions = manifest.runtime?.verifiedVersions;
    if (typeof manifest.id !== 'string' || typeof manifest.runtime?.id !== 'string' || !Array.isArray(versions)) {
      throw new Error(`Proxy entry has no Runtime declaration: ${entry}`);
    }
    declarations.push({
      pluginId: manifest.id,
      runtimeId: manifest.runtime.id,
      versions: versions.filter((version): version is string => typeof version === 'string'),
    });
  }
  return declarations;
}

function runtimeTree(dataDir: string, coordinate: DevRuntimeCoordinate): string {
  return join(dataDir, 'runtimes', coordinate.runtimeId, coordinate.version, coordinate.asset.sha256);
}

async function defaultProbe(executable: string): Promise<string> {
  const script = /\.(?:cjs|mjs|js)$/.test(executable);
  const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(script ? process.execPath : executable, script ? [executable, '--version'] : ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let received = 0;
    const collect = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > 64 * 1024) child.kill('SIGKILL');
      else chunks.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      done({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
  if (result.code !== 0) {
    throw new Error(`Runtime version probe failed (${result.code ?? 'unknown'}).`);
  }
  const version = result.output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
  if (!version) throw new Error('Runtime version probe did not report a semantic version.');
  return version;
}

async function installCoordinate(
  dataDir: string,
  coordinate: DevRuntimeCoordinate,
  download: (asset: DevRuntimeCoordinate['asset']) => Promise<Buffer>,
  probe: (executable: string) => Promise<string>,
): Promise<string> {
  const runtimeRoot = join(dataDir, 'runtimes');
  const directory = runtimeTree(dataDir, coordinate);
  const entryPath = join(directory, coordinate.entryRelativePath);
  if (await verifiedRuntimeReuse(runtimeRoot, directory, coordinate.asset.sha256, coordinate.entryRelativePath)) {
    return entryPath;
  }
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const staging = join(runtimeRoot, `.provision-${randomUUID()}`);
  try {
    const bytes = await download(coordinate.asset);
    if (bytes.length !== coordinate.asset.size) {
      throw new ManagedRuntimeInstallError('RUNTIME_SIZE_MISMATCH', `${coordinate.runtimeId} artifact size does not match its coordinate.`);
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== coordinate.asset.sha256) {
      throw new ManagedRuntimeInstallError('RUNTIME_DIGEST_MISMATCH', `${coordinate.runtimeId} artifact digest does not match its coordinate.`);
    }
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const stagedEntry = join(staging, coordinate.entryRelativePath);
    if (coordinate.format === 'raw') {
      await mkdir(dirname(stagedEntry), { recursive: true, mode: 0o700 });
      await writeFile(stagedEntry, bytes, { mode: 0o600 });
      await chmod(stagedEntry, 0o700);
    } else {
      await extractManagedRuntimeArchive(bytes, staging);
      await chmod(stagedEntry, 0o700);
    }
    const observed = await probe(stagedEntry);
    if (observed !== coordinate.version) {
      throw new ManagedRuntimeInstallError('RUNTIME_VERSION_MISMATCH', `${coordinate.runtimeId} reported ${observed}, expected ${coordinate.version}.`);
    }
    const inventory = await runtimeFileInventory(staging);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await rename(staging, directory);
    await recordRuntimeArtifact(runtimeRoot, directory, digest, coordinate.entryRelativePath, inventory);
    return entryPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function provisionDevRuntimes(input: {
  dataDir: string;
  homeDir?: string;
  mode?: 'giandev' | 'isolated';
  declarations?: readonly DevRuntimeDeclaration[];
  coordinates?: readonly DevRuntimeCoordinate[];
  download?: (asset: DevRuntimeCoordinate['asset']) => Promise<Buffer>;
  probe?: (executable: string) => Promise<string>;
  /** Host startup records the failure and keeps the CLIs that succeeded.
   * A local package build leaves this unset and stops on the first failure. */
  continueOnError?: boolean;
}): Promise<ProvisionedDevRuntime[]> {
  const homeDir = input.homeDir ?? homedir();
  const mode = input.mode ?? 'giandev';
  await assertGianDevRuntimeDataDir(input.dataDir, homeDir, mode);
  const declarations = input.declarations ?? COORDINATES.map(coordinate => ({
    pluginId: coordinate.pluginId,
    runtimeId: coordinate.runtimeId,
    versions: [coordinate.version],
  }));
  const selected = selectDevRuntimeCoordinates(declarations, input.coordinates ?? COORDINATES);
  const download = input.download ?? downloadDevRuntimeAsset;
  const probe = input.probe ?? defaultProbe;
  const installed: ProvisionedDevRuntime[] = [];
  for (const coordinate of selected) {
    console.log(`[gian] provisioning ${coordinate.runtimeId} ${coordinate.version} into ${input.dataDir}/runtimes`);
    try {
      const entryPath = await installCoordinate(input.dataDir, coordinate, download, probe);
      installed.push({
        pluginId: coordinate.pluginId,
        runtimeId: coordinate.runtimeId,
        version: coordinate.version,
        entryPath,
        artifactSha256: coordinate.asset.sha256,
        entryRelativePath: coordinate.entryRelativePath,
      });
    } catch (error) {
      if (!input.continueOnError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gian] ${coordinate.runtimeId} ${coordinate.version} was not provisioned: ${message}`);
    }
  }
  return installed;
}
