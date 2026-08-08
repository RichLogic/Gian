import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const EVENT_STORAGE_V3_LOCK_FILENAME = 'event-storage-v3.lock';

export interface MaintenanceLockRecord {
  pid: number;
  runId: string;
  releaseVersion: string;
  startedAt: string;
  dbPath: string;
  command: string;
}

export interface MaintenanceLock {
  path: string;
  record: MaintenanceLockRecord;
  release(): void;
}

export function maintenanceLockPathForDb(databasePath: string): string {
  return join(dirname(resolve(databasePath)), EVENT_STORAGE_V3_LOCK_FILENAME);
}

export function assertNoEventStorageMaintenance(dataDir: string): void {
  const path = join(dataDir, EVENT_STORAGE_V3_LOCK_FILENAME);
  if (!existsSync(path)) return;
  const record = readMaintenanceLock(path);
  const detail = record
    ? `run ${record.runId} (${record.command}, pid ${record.pid})`
    : 'an unreadable migration run';
  throw new Error(
    `Gian data is under event-storage maintenance by ${detail}. `
      + `Finish, resume, or roll back the migration before starting Gian. Lock: ${path}`,
  );
}

export function acquireMaintenanceLock(options: {
  databasePath: string;
  runId: string;
  releaseVersion: string;
  command: string;
  allowStaleForRunId?: string;
}): MaintenanceLock {
  const databasePath = resolve(options.databasePath);
  const path = maintenanceLockPathForDb(databasePath);
  const record: MaintenanceLockRecord = {
    pid: process.pid,
    runId: options.runId,
    releaseVersion: options.releaseVersion,
    startedAt: new Date().toISOString(),
    dbPath: databasePath,
    command: options.command,
  };

  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    const existing = readMaintenanceLock(path);
    const canClear = existing
      && options.allowStaleForRunId === existing.runId
      && !isPidAlive(existing.pid);
    if (!canClear) {
      const owner = existing
        ? `run ${existing.runId} (${existing.command}, pid ${existing.pid})`
        : 'an unreadable owner';
      throw new Error(`maintenance lock already exists for ${owner}: ${path}`, { cause: error });
    }
    unlinkSync(path);
    fd = openSync(path, 'wx', 0o600);
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  let released = false;
  return {
    path,
    record,
    release(): void {
      if (released) return;
      const current = readMaintenanceLock(path);
      if (!current || current.pid !== record.pid || current.runId !== record.runId) {
        throw new Error(`maintenance lock ownership changed; refusing to remove ${path}`);
      }
      unlinkSync(path);
      released = true;
    },
  };
}

export function readMaintenanceLock(path: string): MaintenanceLockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(value)) return null;
    if (
      typeof value.pid !== 'number'
      || typeof value.runId !== 'string'
      || typeof value.releaseVersion !== 'string'
      || typeof value.startedAt !== 'string'
      || typeof value.dbPath !== 'string'
      || typeof value.command !== 'string'
    ) return null;
    return value as unknown as MaintenanceLockRecord;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
