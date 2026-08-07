import type { Db } from './db.js';

/**
 * Install the P0 event-storage schema into an explicitly selected database.
 *
 * This is deliberately NOT part of openDatabase()/the automatic migration
 * directory. P0 tests call it for disposable databases. The packaged-app
 * migration will be added only after the migration rehearsal is complete.
 */
export function installEventStorageV3(db: Db): void {
  const hasSequence = (db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>)
    .some(column => column.name === 'sequence');
  const sequenceIndex = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_session_sequence'`,
  ).get() as { sql: string | null } | undefined;
  const expectedSequenceIndex = sequenceIndex?.sql
    ? /CREATE\s+UNIQUE\s+INDEX\s+idx_events_session_sequence\s+ON\s+events\s*\(\s*session_id\s*,\s*sequence\s*\)\s*$/i
      .test(sequenceIndex.sql)
    : false;

  db.transaction(() => {
    if (!hasSequence) db.exec('ALTER TABLE events ADD COLUMN sequence INTEGER');
    if (sequenceIndex && !expectedSequenceIndex) {
      db.exec('DROP INDEX idx_events_session_sequence');
    }
    db.exec(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY rowid) AS sequence
        FROM events
      )
      UPDATE events
      SET sequence = (SELECT ranked.sequence FROM ranked WHERE ranked.id = events.id)
      WHERE sequence IS NULL;

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

export function hasEventStorageV3(db: Db): boolean {
  return (db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>)
    .some(column => column.name === 'sequence')
    && Boolean(db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_artifacts'`,
    ).get());
}
