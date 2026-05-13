/**
 * SQLite helpers ported from rvc `apps/host/src/sqlite.ts`. rvc uses Node's
 * built-in `node:sqlite` (DatabaseSync); Gian uses `better-sqlite3`. The
 * surface (`exec`, `prepare(...).run/get/all`) is API-compatible enough that
 * a type swap is all that's needed for these helpers.
 *
 * Repositories should import `Database` from this module; we re-export the
 * better-sqlite3 type under the rvc-friendly name `DatabaseSync` so the
 * copied repository files compile with no body changes.
 */

import type Database from 'better-sqlite3';

export type DatabaseSync = Database.Database;

export function withTransaction<T>(db: DatabaseSync, fn: () => T) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function serializeJson(value: unknown) {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toSqliteBoolean(value: boolean | null | undefined) {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value: number | null | undefined, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  return value !== 0;
}

export function isSqliteUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}
