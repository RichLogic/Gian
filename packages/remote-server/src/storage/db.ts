import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export type RemoteDb = Database.Database;

export function openRemoteDatabase(dataDir: string): RemoteDb {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'remote.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: RemoteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((row) => (
      (row as { filename: string }).filename
    )),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  const insert = db.prepare('INSERT INTO schema_migrations(filename, applied_at) VALUES (?, ?)');
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(filename, new Date().toISOString());
    })();
  }
}

export function listTables(db: RemoteDb): string[] {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => (row as { name: string }).name);
}

export function listColumns(db: RemoteDb, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (
    (row as { name: string }).name
  ));
}
