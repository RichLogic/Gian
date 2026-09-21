import {
  lstat,
  mkdir,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

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

export type KimiGuardKind =
  | 'KIMI_STORE_UNKNOWN_SCHEMA'
  | 'KIMI_STORE_CORRUPT'
  | 'KIMI_STORE_DOWNGRADE'
  | 'KIMI_STORE_OWNER_MISSING'
  | 'KIMI_STORE_INCOMPATIBLE'
  | 'KIMI_ACTIVATION_UNPROBEABLE'
  | 'KIMI_ACTIVATION_WRITE_FAILED';

export function compareKimiVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new KimiDataVersionError(
      'KIMI_STORE_INCOMPATIBLE',
      `Kimi reported an unsupported semantic version (${JSON.stringify(left)}, ${JSON.stringify(right)}).`,
    );
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export class KimiDataVersionError extends Error {
  readonly code: string;
  readonly kind: KimiGuardKind;

  constructor(kind: KimiGuardKind, message: string) {
    super(message);
    this.name = 'KimiDataVersionError';
    this.kind = kind;
    this.code = kind.startsWith('KIMI_ACTIVATION_') ? kind : 'DATA_VERSION_INCOMPATIBLE';
  }
}

async function existingDirectoryEntries(path: string): Promise<string[] | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new KimiDataVersionError(
        'KIMI_STORE_CORRUPT',
        `Kimi compatibility path is not a real directory: ${path}`,
      );
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
      throw new KimiDataVersionError('KIMI_STORE_INCOMPATIBLE', 'KIMI_CODE_HOME must be an absolute path.');
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

  /**
   * Detects session-store compatibility conditions without blocking. The CLI
   * is authoritative for whether its own store can be opened (ADR-0080), so
   * every condition — downgrade, unknown owner, corrupt or unknown Gian
   * bookkeeping metadata — is reported to the caller for observability and
   * never thrown.
   */
  async evaluateCompatibility(
    candidateVersion: string,
    observedStoreOwnerVersion?: string,
  ): Promise<KimiDataVersionError[]> {
    const candidate = parseVersion(candidateVersion);
    if (!candidate) {
      return [new KimiDataVersionError(
        'KIMI_STORE_INCOMPATIBLE',
        `Kimi reported an unsupported semantic version: ${JSON.stringify(candidateVersion)}.`,
      )];
    }
    let recordedFloor: string | null;
    let hasSessionData: boolean;
    try {
      [recordedFloor, hasSessionData] = await Promise.all([
        this.readRecordedFloor(),
        this.hasSessionData(),
      ]);
    } catch (error) {
      return [error instanceof KimiDataVersionError
        ? error
        : new KimiDataVersionError(
          'KIMI_STORE_CORRUPT',
          error instanceof Error ? error.message : String(error),
        )];
    }

    const conditions: KimiDataVersionError[] = [];
    let floor = recordedFloor;
    if (observedStoreOwnerVersion) {
      if (!parseVersion(observedStoreOwnerVersion)) {
        conditions.push(new KimiDataVersionError(
          'KIMI_STORE_INCOMPATIBLE',
          `The Kimi session store owner reported an unsupported version: ${JSON.stringify(observedStoreOwnerVersion)}.`,
        ));
      } else if (!floor || compareKimiVersions(observedStoreOwnerVersion, floor) > 0) {
        floor = observedStoreOwnerVersion;
      }
    }
    if (hasSessionData && !floor) {
      conditions.push(new KimiDataVersionError(
        'KIMI_STORE_OWNER_MISSING',
        'Kimi session data exists, but its last compatible CLI version cannot be established.',
      ));
    }
    if (floor && compareKimiVersions(candidate.raw, floor) < 0) {
      conditions.push(new KimiDataVersionError(
        'KIMI_STORE_DOWNGRADE',
        `Kimi ${candidate.raw} is older than the session store's last observed version ${floor}.`,
      ));
    }
    return conditions;
  }

  async recordActivation(version: string): Promise<void> {
    if (!parseVersion(version)) {
      throw new KimiDataVersionError(
        'KIMI_STORE_INCOMPATIBLE',
        `Refusing to record an unsupported Kimi version: ${JSON.stringify(version)}.`,
      );
    }
    // Version-named immutable records make the floor monotonic even when
    // multiple Host processes acquire compatible runtimes concurrently.
    await this.readRecordedFloor();
    try {
      await mkdir(this.versionRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new KimiDataVersionError(
        'KIMI_ACTIVATION_WRITE_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
    const target = join(this.versionRoot, version);
    try {
      await writeFile(target, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new KimiDataVersionError(
          'KIMI_ACTIVATION_WRITE_FAILED',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const record = await lstat(target);
    if (!record.isFile() || record.isSymbolicLink()) {
      throw new KimiDataVersionError(
        'KIMI_STORE_CORRUPT',
        `Kimi session-store compatibility version is not an immutable file: ${JSON.stringify(version)}.`,
      );
    }
  }

  private async readRecordedFloor(): Promise<string | null> {
    const rootEntries = await existingDirectoryEntries(this.compatibilityRoot);
    if (rootEntries === null) return null;
    if (rootEntries.some(entry => entry !== COMPATIBILITY_SCHEMA)) {
      throw new KimiDataVersionError(
        'KIMI_STORE_UNKNOWN_SCHEMA',
        'Kimi session-store compatibility metadata uses an unknown schema.',
      );
    }
    if (!rootEntries.includes(COMPATIBILITY_SCHEMA)) return null;
    const versions = await existingDirectoryEntries(this.versionRoot);
    if (versions === null) {
      throw new KimiDataVersionError(
        'KIMI_STORE_CORRUPT',
        'Kimi session-store compatibility schema path is invalid.',
      );
    }
    let floor: string | null = null;
    for (const version of versions) {
      if (!parseVersion(version)) {
        throw new KimiDataVersionError(
          'KIMI_STORE_UNKNOWN_SCHEMA',
          `Kimi session-store compatibility metadata contains an unknown version: ${JSON.stringify(version)}.`,
        );
      }
      const record = await lstat(join(this.versionRoot, version));
      if (!record.isFile() || record.isSymbolicLink()) {
        throw new KimiDataVersionError(
          'KIMI_STORE_CORRUPT',
          `Kimi session-store compatibility version is not an immutable file: ${JSON.stringify(version)}.`,
        );
      }
      if (!floor || compareKimiVersions(version, floor) > 0) floor = version;
    }
    return floor;
  }
}
