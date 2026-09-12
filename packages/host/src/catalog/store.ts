import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  CATALOG_ASSET_MANIFEST_FILE,
  MAX_CATALOG_ASSET_FILE_COUNT,
  MAX_CATALOG_BUNDLE_BYTES,
  verifyCatalogBundleFiles,
} from '@gian/proxy-catalog-contract';
import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import { fsyncDirectory, writeFileAtomic } from './atomic.js';
import type { CatalogSnapshot } from './types.js';

const execFileAsync = promisify(execFile);
const CURRENT_POINTER = 'current';
const WATERMARK = 'watermark';
const GENERATIONS = 'generations';
const STAGING = 'staging';
const CLAIMS_DIR = 'ingest-claims';
const GENERATION_ETAG = 'etag';
const MAX_POINTER_BYTES = 32;
const MAX_LOCK_BYTES = 1024;
const CLAIM_NAME = /^claim-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CatalogIngestClaim {
  schemaVersion: 1;
  token: string;
  pid: number;
  processIdentity: string;
  createdAt: string;
}

export type CatalogProcessProbe =
  | { state: 'live'; identity: string }
  | { state: 'dead' }
  | { state: 'unknown' };

export class CatalogIngestBusyError extends Error {
  readonly code = 'CATALOG_INGEST_BUSY';
  constructor() {
    super('Another Catalog ingest is already in progress.');
    this.name = 'CatalogIngestBusyError';
  }
}

export class CatalogWatermarkError extends Error {
  readonly code = 'CATALOG_WATERMARK_INVALID';
  constructor(message = 'Catalog watermark is missing or invalid.') {
    super(message);
    this.name = 'CatalogWatermarkError';
  }
}

export class CatalogProcessIdentityError extends Error {
  readonly code = 'CATALOG_PROCESS_IDENTITY';
  constructor(message = 'Catalog ingest could not establish a fail-closed process identity.') {
    super(message);
    this.name = 'CatalogProcessIdentityError';
  }
}

export class CatalogStore {
  private snapshotValue: CatalogSnapshot = emptySnapshot();

  constructor(
    private readonly options: {
      rootDir: string;
      policy: OfficialCatalogSourcePolicy;
      afterLock?: () => Promise<void>;
      afterWatermarkWrite?: () => Promise<void>;
      beforeUnlinkClaim?: (path: string) => Promise<void>;
      beforeReleaseClaim?: (path: string) => Promise<void>;
      probeProcess?: (pid: number) => Promise<CatalogProcessProbe>;
    },
  ) {}

  snapshot(): CatalogSnapshot {
    return this.snapshotValue;
  }

  async open(): Promise<CatalogSnapshot> {
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    const pointer = await this.readCurrentPointer();
    if (pointer !== null) {
      const current = await this.readGeneration(pointer);
      if (current) {
        this.snapshotValue = current;
        return current;
      }
    }
    for (const sequence of await this.listValidSequences()) {
      if (sequence === pointer) continue;
      const opened = await this.readGeneration(sequence);
      if (opened) {
        this.snapshotValue = opened;
        return opened;
      }
    }
    this.snapshotValue = emptySnapshot();
    return this.snapshotValue;
  }

  async ingest(files: Map<string, Buffer>, etag?: string | null): Promise<CatalogSnapshot> {
    const release = await this.acquireLock();
    let outcome: { ok: true; value: CatalogSnapshot } | { ok: false; error: unknown } | undefined;
    try {
      await this.options.afterLock?.();
      const index = verifyCatalogBundleFiles({
        files,
        pinnedPublicKeys: this.options.policy.pinnedPublicKeys,
        expectedSourceId: this.options.policy.sourceId,
      });
      const watermark = await this.readWatermark();
      if (watermark !== null && index.sequence < watermark) {
        throw Object.assign(new Error('Catalog sequence rollback is not allowed.'), {
          code: 'CATALOG_SEQUENCE_ROLLBACK',
        });
      }
      const existingDir = this.generationDir(index.sequence);
      if (await exists(existingDir)) {
        const existing = await this.readGeneration(index.sequence);
        if (existing?.files) {
          if (!sameInventory(existing.files, files)) {
            throw Object.assign(
              new Error(`Catalog generation ${index.sequence} already exists with different content.`),
              { code: 'CATALOG_SEQUENCE_CONFLICT' },
            );
          }
          if (watermark !== null && index.sequence !== watermark && index.sequence < watermark) {
            throw Object.assign(new Error('Catalog sequence rollback is not allowed.'), {
              code: 'CATALOG_SEQUENCE_ROLLBACK',
            });
          }
          await this.publishPointer(index.sequence, etag === undefined ? existing.etag : etag);
          this.snapshotValue = {
            ...existing,
            state: 'ready',
            etag: etag === undefined ? existing.etag : etag,
            error: null,
          };
          outcome = { ok: true, value: this.snapshotValue };
        } else if (watermark !== null && index.sequence !== watermark && index.sequence <= watermark) {
          throw Object.assign(new Error('Catalog sequence rollback is not allowed.'), {
            code: 'CATALOG_SEQUENCE_ROLLBACK',
          });
        } else {
          await rm(existingDir, { recursive: true, force: true });
        }
      }

      if (!outcome) {
        const staging = join(this.options.rootDir, STAGING, randomUUID());
        await mkdir(staging, { recursive: true, mode: 0o700 });
        try {
          for (const [path, bytes] of files) {
            const target = join(staging, ...path.split('/'));
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFileAtomic(target, bytes);
          }
          if (etag) {
            await writeFileAtomic(join(staging, GENERATION_ETAG), Buffer.from(`${etag}\n`, 'utf8'));
          } else {
            await writeFileAtomic(join(staging, GENERATION_ETAG), Buffer.from('\n', 'utf8'));
          }
          await fsyncDirectory(staging);
          await mkdir(join(this.options.rootDir, GENERATIONS), { recursive: true, mode: 0o700 });
          await rename(staging, existingDir);
          await fsyncDirectory(join(this.options.rootDir, GENERATIONS));
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        const published = await this.readGeneration(index.sequence);
        if (!published) {
          throw new Error('Catalog generation failed revalidation after publish.');
        }
        await this.publishPointer(index.sequence, etag ?? null);
        this.snapshotValue = { ...published, state: 'ready', etag: etag ?? published.etag, error: null };
        outcome = { ok: true, value: this.snapshotValue };
      }
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await release();
    } catch (releaseError) {
      this.markError({
        code: 'CATALOG_CLAIM_RELEASE',
        message: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
      if (!outcome || !outcome.ok) {
        throw new AggregateError(
          [outcome?.error ?? new Error('Catalog ingest failed.'), releaseError],
          'Catalog ingest failed and the claim could not be released.',
        );
      }
      throw releaseError;
    }
    if (!outcome) throw new Error('Catalog ingest lost its outcome.');
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  markError(error: { code: string; message: string }): CatalogSnapshot {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: this.snapshotValue.index ? 'stale' : 'error',
      error,
    };
    return this.snapshotValue;
  }

  private generationDir(sequence: number): string {
    return join(this.options.rootDir, GENERATIONS, String(sequence));
  }

  private async readCurrentPointer(): Promise<number | null> {
    return this.readNumericPointer(join(this.options.rootDir, CURRENT_POINTER), { failClosed: false });
  }

  private async readWatermark(): Promise<number | null> {
    return this.readNumericPointer(join(this.options.rootDir, WATERMARK), { failClosed: true });
  }

  private async readNumericPointer(
    path: string,
    options: { failClosed: boolean },
  ): Promise<number | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_POINTER_BYTES) {
        if (options.failClosed) {
          throw new CatalogWatermarkError('Catalog watermark is not a bounded regular file.');
        }
        return null;
      }
    } catch (error) {
      if (error instanceof CatalogWatermarkError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (options.failClosed) {
        throw new CatalogWatermarkError('Catalog watermark could not be read.');
      }
      return null;
    }
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const raw = await handle.readFile({ encoding: 'utf8' });
      const match = /^([1-9]\d*)\n$/.exec(raw);
      if (match) return Number(match[1]);
      if (options.failClosed) {
        throw new CatalogWatermarkError('Catalog watermark is malformed.');
      }
      return null;
    } catch (error) {
      if (error instanceof CatalogWatermarkError) throw error;
      if (options.failClosed) {
        throw new CatalogWatermarkError('Catalog watermark could not be read.');
      }
      return null;
    } finally {
      await handle?.close();
    }
  }

  private async publishPointer(sequence: number, etag: string | null): Promise<void> {
    const watermark = await this.readWatermark();
    if (watermark !== null && sequence < watermark) {
      throw Object.assign(new Error('Catalog sequence rollback is not allowed.'), {
        code: 'CATALOG_SEQUENCE_ROLLBACK',
      });
    }
    const nextWatermark = watermark === null ? sequence : Math.max(watermark, sequence);
    await writeFileAtomic(
      join(this.options.rootDir, WATERMARK),
      Buffer.from(`${nextWatermark}\n`, 'utf8'),
    );
    await this.options.afterWatermarkWrite?.();
    await writeFileAtomic(
      join(this.options.rootDir, CURRENT_POINTER),
      Buffer.from(`${sequence}\n`, 'utf8'),
    );
    const generationEtag = join(this.generationDir(sequence), GENERATION_ETAG);
    if (etag) {
      await writeFileAtomic(generationEtag, Buffer.from(`${etag}\n`, 'utf8'));
    } else {
      await writeFileAtomic(generationEtag, Buffer.from('\n', 'utf8'));
    }
  }

  private async listValidSequences(): Promise<number[]> {
    const root = join(this.options.rootDir, GENERATIONS);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const sequences: number[] = [];
    for (const name of names) {
      if (!/^[1-9]\d*$/.test(name)) continue;
      const info = await lstat(join(root, name)).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      sequences.push(Number(name));
    }
    return sequences.sort((a, b) => b - a);
  }

  private async readGeneration(sequence: number): Promise<CatalogSnapshot | null> {
    const dir = this.generationDir(sequence);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    try {
      const files = await readContainedFiles(dir);
      const etag = parseGenerationEtag(files.get(GENERATION_ETAG));
      files.delete(GENERATION_ETAG);
      const index = verifyCatalogBundleFiles({
        files,
        pinnedPublicKeys: this.options.policy.pinnedPublicKeys,
        expectedSourceId: this.options.policy.sourceId,
      });
      if (index.sequence !== sequence) return null;
      return {
        index,
        sequence,
        files,
        state: 'ready',
        etag,
        error: null,
      };
    } catch {
      return null;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const claimsDir = join(this.options.rootDir, CLAIMS_DIR);
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(claimsDir, { recursive: true, mode: 0o700 });
    const identity = await this.establishProcessIdentity();
    await this.reclaimDeadClaims(claimsDir);
    if (await this.hasBlockingClaim(claimsDir, null)) {
      throw new CatalogIngestBusyError();
    }
    const token = randomUUID();
    const claimPath = join(claimsDir, `claim-${token}`);
    const claim: CatalogIngestClaim = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      processIdentity: identity,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(claimPath, JSON.stringify(claim), {
        flag: 'wx',
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CatalogIngestBusyError();
      throw error;
    }
    if (await this.hasBlockingClaim(claimsDir, token)) {
      try {
        await unlinkOwnClaim(claimPath);
      } catch (error) {
        throw new AggregateError(
          [error],
          'Catalog ingest claim conflicted and could not be cleaned up.',
        );
      }
      throw new CatalogIngestBusyError();
    }
    return async () => {
      await unlinkOwnClaim(claimPath, this.options.beforeReleaseClaim);
    };
  }

  private async establishProcessIdentity(): Promise<string> {
    const probe = await this.probeProcess(process.pid);
    if (probe.state !== 'live') {
      throw new CatalogProcessIdentityError();
    }
    return probe.identity;
  }

  private async probeProcess(pid: number): Promise<CatalogProcessProbe> {
    if (this.options.probeProcess) return this.options.probeProcess(pid);
    return probeProcess(pid);
  }

  private async reclaimDeadClaims(claimsDir: string): Promise<void> {
    for (const path of await listClaimPaths(claimsDir)) {
      const claim = await readLockClaim(path);
      if (claim === 'overflow') {
        throw Object.assign(new Error('Catalog ingest lock exceeds MAX_LOCK_BYTES.'), {
          code: 'CATALOG_LOCK_OVERFLOW',
        });
      }
      if (claim === null) continue;
      const owner = await classifyClaimOwner(claim, (pid) => this.probeProcess(pid));
      if (owner !== 'dead') continue;
      await this.options.beforeUnlinkClaim?.(path);
      await unlink(path).catch(() => undefined);
    }
  }

  private async hasBlockingClaim(claimsDir: string, ignoreToken: string | null): Promise<boolean> {
    for (const path of await listClaimPaths(claimsDir)) {
      const claim = await readLockClaim(path);
      if (claim === 'overflow') {
        throw Object.assign(new Error('Catalog ingest lock exceeds MAX_LOCK_BYTES.'), {
          code: 'CATALOG_LOCK_OVERFLOW',
        });
      }
      if (claim === null) return true;
      if (ignoreToken && claim.token === ignoreToken) continue;
      const owner = await classifyClaimOwner(claim, (pid) => this.probeProcess(pid));
      if (owner !== 'dead') return true;
    }
    return false;
  }
}

async function unlinkOwnClaim(
  path: string,
  beforeRelease?: (path: string) => Promise<void>,
): Promise<void> {
  await beforeRelease?.(path);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { code: 'CATALOG_CLAIM_RELEASE' },
    );
  }
}

function emptySnapshot(): CatalogSnapshot {
  return {
    index: null,
    sequence: null,
    files: null,
    state: 'empty',
    etag: null,
    error: null,
  };
}

function parseGenerationEtag(bytes: Buffer | undefined): string | null {
  if (!bytes) return null;
  const value = bytes.toString('utf8').trim();
  return value.length > 0 && value.length <= 256 ? value : null;
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export async function probeProcess(pid: number): Promise<CatalogProcessProbe> {
  const liveness = processLiveness(pid);
  if (liveness === 'dead') return { state: 'dead' };
  if (liveness === 'unknown') return { state: 'unknown' };
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const result = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 2_000,
        maxBuffer: 4_096,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      });
      const startedAt = String(result.stdout).trim().replace(/\s+/g, ' ');
      if (startedAt) return { state: 'live', identity: `${process.platform}:${startedAt}` };
    } catch {
      const afterFailure = processLiveness(pid);
      if (afterFailure === 'dead') return { state: 'dead' };
      return { state: 'unknown' };
    }
    return { state: 'unknown' };
  }
  return { state: 'live', identity: `pid:${pid}` };
}

async function classifyClaimOwner(
  claim: CatalogIngestClaim,
  probe: (pid: number) => Promise<CatalogProcessProbe>,
): Promise<'live' | 'dead' | 'unknown'> {
  const result = await probe(claim.pid);
  if (result.state === 'dead') return 'dead';
  if (result.state === 'unknown') return 'unknown';
  if (result.identity !== claim.processIdentity) return 'dead';
  return 'live';
}

function validLockClaim(value: unknown): value is CatalogIngestClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Partial<CatalogIngestClaim>;
  return claim.schemaVersion === 1
    && typeof claim.token === 'string'
    && claim.token.length > 0
    && Number.isSafeInteger(claim.pid)
    && typeof claim.processIdentity === 'string'
    && typeof claim.createdAt === 'string';
}

async function listClaimPaths(claimsDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(claimsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => CLAIM_NAME.test(name))
    .map((name) => join(claimsDir, name))
    .sort();
}

async function readLockClaim(path: string): Promise<CatalogIngestClaim | null | 'overflow'> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if (info.size > MAX_LOCK_BYTES) return 'overflow';
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const raw = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(raw) > MAX_LOCK_BYTES) return 'overflow';
      const parsed: unknown = JSON.parse(raw);
      return validLockClaim(parsed) ? parsed : null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function sameInventory(left: Map<string, Buffer>, right: Map<string, Buffer>): boolean {
  const leftManifest = left.get(CATALOG_ASSET_MANIFEST_FILE);
  const rightManifest = right.get(CATALOG_ASSET_MANIFEST_FILE);
  if (!leftManifest || !rightManifest) return false;
  return leftManifest.equals(rightManifest);
}

async function readContainedFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error('Catalog generation contains a symlink.');
      }
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) throw new Error('Catalog generation contains a special file.');
      const relativePath = relative(root, full).split(sep).join('/');
      if (files.size >= MAX_CATALOG_ASSET_FILE_COUNT) {
        throw new Error('Catalog generation exceeds file count.');
      }
      if (total + info.size > MAX_CATALOG_BUNDLE_BYTES) {
        throw new Error('Catalog generation exceeds bundle size.');
      }
      const bytes = await readFile(full);
      total += bytes.byteLength;
      files.set(relativePath, bytes);
    }
  };
  await walk(root);
  return files;
}
