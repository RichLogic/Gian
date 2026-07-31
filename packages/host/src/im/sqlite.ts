/** Small persistence helpers shared by the Slack and Discord repositories. */

import type Database from 'better-sqlite3';

export type DatabaseSync = Database.Database;

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
