import type { Db } from './db.js';

export type EventStorageV3State = 'installing' | 'migrating' | 'verifying' | 'active' | 'failed';

export interface EventStorageV3Meta {
  version: number;
  state: EventStorageV3State;
  run_id: string;
  backup_path: string;
  backup_sha256: string;
  phase: string;
  cursor: string | null;
  counters_json: string;
  updated_at: string;
}

/** Install only the additive schema needed by the offline migrator. */
export function installEventStorageV3Schema(db: Db): void {
  const hasSequence = (db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>)
    .some(column => column.name === 'sequence');
  db.transaction(() => {
    if (!hasSequence) db.exec('ALTER TABLE events ADD COLUMN sequence INTEGER');
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_storage_meta (
        singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
        version       INTEGER NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('installing', 'migrating', 'verifying', 'active', 'failed')),
        run_id        TEXT NOT NULL,
        backup_path   TEXT NOT NULL,
        backup_sha256 TEXT NOT NULL,
        phase         TEXT NOT NULL,
        cursor        TEXT,
        counters_json TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_artifacts (
        id          TEXT PRIMARY KEY,
        mime_type   TEXT NOT NULL,
        format      TEXT NOT NULL,
        encoding    TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        stored_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS event_artifact_chunks (
        artifact_id TEXT NOT NULL REFERENCES event_artifacts(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        data        BLOB NOT NULL,
        PRIMARY KEY (artifact_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS event_artifact_links (
        event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES event_artifacts(id) ON DELETE RESTRICT,
        path        TEXT NOT NULL,
        PRIMARY KEY (event_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_event_artifact_links_artifact
        ON event_artifact_links(artifact_id);

      CREATE TRIGGER IF NOT EXISTS event_artifact_links_delete_orphan
      AFTER DELETE ON event_artifact_links
      BEGIN
        DELETE FROM event_artifacts
        WHERE id = OLD.artifact_id
          AND NOT EXISTS (
            SELECT 1 FROM event_artifact_links WHERE artifact_id = OLD.artifact_id
          );
      END;

      CREATE TABLE IF NOT EXISTS event_rebuild_state (
        session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        source_path      TEXT NOT NULL,
        source_size      INTEGER NOT NULL,
        next_offset      INTEGER NOT NULL,
        next_turn_number INTEGER NOT NULL,
        complete         INTEGER NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  })();
}

/** Finalize indexes/triggers only after the bounded sequence backfill passes. */
export function finalizeEventStorageV3Schema(db: Db): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_sequence
      ON events(session_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_events_snapshot_identity
      ON events(session_id, turn_id, type, call_id, sequence);

    CREATE TRIGGER IF NOT EXISTS events_assign_sequence
    AFTER INSERT ON events
    WHEN NEW.sequence IS NULL
    BEGIN
      UPDATE events
      SET sequence = (
        SELECT COALESCE(MAX(sequence), 0) + 1
        FROM events
        WHERE session_id = NEW.session_id AND id <> NEW.id
      )
      WHERE id = NEW.id;
    END;
  `);
}

export function readEventStorageV3Meta(db: Db): EventStorageV3Meta | null {
  if (!tableExists(db, 'event_storage_meta')) return null;
  return (db.prepare(
    `SELECT version, state, run_id, backup_path, backup_sha256,
            phase, cursor, counters_json, updated_at
     FROM event_storage_meta WHERE singleton = 1`,
  ).get() as EventStorageV3Meta | undefined) ?? null;
}

export function hasEventStorageV3Schema(db: Db): boolean {
  const hasSequence = (db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>)
    .some(column => column.name === 'sequence');
  return hasSequence
    && tableExists(db, 'event_storage_meta')
    && tableExists(db, 'event_artifacts')
    && tableExists(db, 'event_artifact_chunks')
    && tableExists(db, 'event_artifact_links');
}

export function isEventStorageV3Active(db: Db): boolean {
  if (!hasEventStorageV3Schema(db)) return false;
  const meta = readEventStorageV3Meta(db);
  return meta?.version === 3 && meta.state === 'active';
}

/** Runtime compatibility alias. Presence alone is intentionally insufficient. */
export const hasEventStorageV3 = isEventStorageV3Active;

/**
 * Disposable-database rehearsal helper used by focused storage tests.
 * Production databases must use the packaged offline migration CLI.
 */
export function installEventStorageV3(db: Db): void {
  installEventStorageV3Schema(db);
  db.transaction(() => {
    db.exec(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY rowid) AS sequence
        FROM events
      )
      UPDATE events
      SET sequence = (SELECT ranked.sequence FROM ranked WHERE ranked.id = events.id)
      WHERE sequence IS NULL;
    `);
    finalizeEventStorageV3Schema(db);
    db.prepare(`
      INSERT INTO event_storage_meta
        (singleton, version, state, run_id, backup_path, backup_sha256,
         phase, cursor, counters_json, updated_at)
      VALUES (1, 3, 'active', 'test-rehearsal', ':memory:', 'test-only',
              'complete', NULL, '{}', datetime('now'))
      ON CONFLICT(singleton) DO UPDATE SET
        version = excluded.version,
        state = excluded.state,
        run_id = excluded.run_id,
        backup_path = excluded.backup_path,
        backup_sha256 = excluded.backup_sha256,
        phase = excluded.phase,
        cursor = excluded.cursor,
        counters_json = excluded.counters_json,
        updated_at = excluded.updated_at
    `).run();
  })();
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}
