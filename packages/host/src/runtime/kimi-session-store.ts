import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type {
  CliRuntimeProvider,
  InstalledRuntime,
  RuntimeProbe,
  RuntimeProcessGroupProtector,
} from './types.js';

const COMPATIBILITY_DIRECTORY = '.gian-session-store-compat';
const COMPATIBILITY_SCHEMA = 'v1';

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? null,
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareKimiVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new KimiDataVersionError(
      `Kimi reported an unsupported semantic version (${JSON.stringify(left)}, ${JSON.stringify(right)}).`,
    );
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export class KimiDataVersionError extends Error {
  readonly code = 'DATA_VERSION_INCOMPATIBLE';

  constructor(message: string) {
    super(message);
    this.name = 'KimiDataVersionError';
  }
}

async function existingDirectoryEntries(path: string): Promise<string[] | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new KimiDataVersionError(`Kimi compatibility path is not a real directory: ${path}`);
    }
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class KimiSessionStoreGuard {
  readonly kimiCodeHome: string;
  private readonly compatibilityRoot: string;
  private readonly versionRoot: string;

  constructor(kimiCodeHome: string) {
    if (!isAbsolute(kimiCodeHome)) {
      throw new KimiDataVersionError('KIMI_CODE_HOME must be an absolute path.');
    }
    this.kimiCodeHome = kimiCodeHome;
    this.compatibilityRoot = join(kimiCodeHome, COMPATIBILITY_DIRECTORY);
    this.versionRoot = join(this.compatibilityRoot, COMPATIBILITY_SCHEMA);
  }

  async hasSessionData(): Promise<boolean> {
    try {
      if ((await stat(join(this.kimiCodeHome, 'session_index.jsonl'))).size > 0) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    try {
      return (await readdir(join(this.kimiCodeHome, 'sessions'))).length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }

  async assertCompatible(candidateVersion: string, observedStoreOwnerVersion?: string): Promise<void> {
    const candidate = parseVersion(candidateVersion);
    if (!candidate) {
      throw new KimiDataVersionError(
        `Kimi reported an unsupported semantic version: ${JSON.stringify(candidateVersion)}.`,
      );
    }
    const [recordedFloor, hasSessionData] = await Promise.all([
      this.readRecordedFloor(),
      this.hasSessionData(),
    ]);

    let floor = recordedFloor;
    if (observedStoreOwnerVersion) {
      if (!parseVersion(observedStoreOwnerVersion)) {
        throw new KimiDataVersionError(
          `The Kimi session store owner reported an unsupported version: ${JSON.stringify(observedStoreOwnerVersion)}.`,
        );
      }
      if (!floor || compareKimiVersions(observedStoreOwnerVersion, floor) > 0) {
        floor = observedStoreOwnerVersion;
      }
    }
    if (hasSessionData && !floor) {
      throw new KimiDataVersionError(
        'Kimi session data exists, but its last compatible CLI version cannot be established. '
          + 'Activate the official Kimi binary from the same KIMI_CODE_HOME before using another runtime.',
      );
    }
    if (floor && compareKimiVersions(candidate.raw, floor) < 0) {
      throw new KimiDataVersionError(
        `Kimi ${candidate.raw} cannot open a session store last observed at ${floor}; automatic downgrade is blocked.`,
      );
    }
  }

  async recordActivation(version: string): Promise<void> {
    if (!parseVersion(version)) {
      throw new KimiDataVersionError(
        `Refusing to record an unsupported Kimi version: ${JSON.stringify(version)}.`,
      );
    }
    // Version-named immutable records make the floor monotonic even when
    // multiple Host processes acquire compatible runtimes concurrently.
    await this.readRecordedFloor();
    await mkdir(this.versionRoot, { recursive: true, mode: 0o700 });
    const target = join(this.versionRoot, version);
    try {
      await writeFile(target, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const record = await lstat(target);
    if (!record.isFile() || record.isSymbolicLink()) {
      throw new KimiDataVersionError(
        `Kimi session-store compatibility version is not an immutable file: ${JSON.stringify(version)}.`,
      );
    }
  }

  private async readRecordedFloor(): Promise<string | null> {
    const rootEntries = await existingDirectoryEntries(this.compatibilityRoot);
    if (rootEntries === null) return null;
    if (rootEntries.some(entry => entry !== COMPATIBILITY_SCHEMA)) {
      throw new KimiDataVersionError('Kimi session-store compatibility metadata uses an unknown schema.');
    }
    if (!rootEntries.includes(COMPATIBILITY_SCHEMA)) return null;
    const versions = await existingDirectoryEntries(this.versionRoot);
    if (versions === null) {
      throw new KimiDataVersionError('Kimi session-store compatibility schema path is invalid.');
    }
    let floor: string | null = null;
    for (const version of versions) {
      if (!parseVersion(version)) {
        throw new KimiDataVersionError(
          `Kimi session-store compatibility metadata contains an unknown version: ${JSON.stringify(version)}.`,
        );
      }
      const record = await lstat(join(this.versionRoot, version));
      if (!record.isFile() || record.isSymbolicLink()) {
        throw new KimiDataVersionError(
          `Kimi session-store compatibility version is not an immutable file: ${JSON.stringify(version)}.`,
        );
      }
      if (!floor || compareKimiVersions(version, floor) > 0) floor = version;
    }
    return floor;
  }
}

export class KimiSessionStoreRuntimeProvider implements CliRuntimeProvider {
  readonly id = 'kimi' as const;
  private readonly guard: KimiSessionStoreGuard;

  constructor(private readonly delegate: CliRuntimeProvider, kimiCodeHome: string) {
    if (delegate.id !== 'kimi') {
      throw new TypeError('Kimi session-store guard can only wrap the Kimi runtime provider.');
    }
    this.guard = new KimiSessionStoreGuard(kimiCodeHome);
  }

  inspectInstalled(): Promise<InstalledRuntime[]> {
    return this.delegate.inspectInstalled();
  }

  async probe(
    runtime: InstalledRuntime,
    protector?: RuntimeProcessGroupProtector,
  ): Promise<RuntimeProbe> {
    const candidate = await this.delegate.probe(runtime, protector);
    let observedStoreOwnerVersion: string | undefined;
    if (await this.guard.hasSessionData()) {
      const officialBinary = join(this.guard.kimiCodeHome, 'bin', 'kimi');
      try {
        await access(officialBinary, constants.X_OK);
        const [candidatePath, officialPath] = await Promise.all([
          realpath(candidate.binaryPath),
          realpath(officialBinary),
        ]);
        observedStoreOwnerVersion = candidatePath === officialPath
          ? candidate.version
          : (await this.delegate.probe({
            cli: 'kimi',
            binaryPath: officialBinary,
            source: 'official-user',
          }, protector)).version;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new KimiDataVersionError(
            `The Kimi session store owner could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    await this.guard.assertCompatible(candidate.version, observedStoreOwnerVersion);
    return candidate;
  }

  async activate(runtime: RuntimeProbe): Promise<void> {
    await this.delegate.activate?.(runtime);
    await this.guard.recordActivation(runtime.version);
  }

  managedEnv(): Readonly<Record<string, string>> {
    return this.delegate.managedEnv();
  }

  snapshot(runtime: InstalledRuntime | RuntimeProbe): Promise<string> {
    if (!this.delegate.snapshot) {
      throw new Error('Wrapped Kimi runtime provider does not support content snapshots.');
    }
    return this.delegate.snapshot(runtime);
  }
}
