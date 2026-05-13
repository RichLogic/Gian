import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath } from './paths.js';

export type Db = Database.Database;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export function openDatabase(dataDir: string): Db {
  const db = new Database(dbPath(dataDir));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM migrations').all().map(row => (row as { filename: string }).filename),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();

  const insert = db.prepare('INSERT INTO migrations (filename) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Migrations that need to toggle FK enforcement (e.g. table-rebuild
    // patterns that move FK-referenced parents) opt out of the wrapping
    // transaction by including the marker `-- migration:no-transaction`
    // in their first 200 chars. better-sqlite3 forbids changing
    // foreign_keys inside a transaction.
    const noTx = sql.slice(0, 200).includes('-- migration:no-transaction');
    if (noTx) {
      db.exec(sql);
      insert.run(file);
    } else {
      db.transaction(() => {
        db.exec(sql);
        insert.run(file);
      })();
    }
    console.log(`[gian] applied migration ${file}`);
  }
}
