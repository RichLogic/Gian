import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import {
  EVENT_ARTIFACT_CHUNK_BYTES,
  MAX_STORED_EVENT_BYTES,
  EventStore,
} from '../session/event-store.js';
import {
  SessionHistoryStore,
  snapshotIdentity,
} from '../session/history-store.js';
import type { Db } from './db.js';
import {
  finalizeEventStorageV3Schema,
  hasEventStorageV3Schema,
  installEventStorageV3Schema,
  isEventStorageV3Active,
  readEventStorageV3Meta,
  type EventStorageV3State,
} from './event-storage-v3-schema.js';
import {
  acquireMaintenanceLock,
  maintenanceLockPathForDb,
} from './maintenance-lock.js';

const MIGRATION_VERSION = 3;
const DEFAULT_BATCH_SIZE = 100;
const PROGRESS_FILENAME = 'progress.jsonl';
const MANIFEST_FILENAME = 'manifest.before.json';
const VERIFY_FILENAME = 'verify.after.json';
const VACUUM_FILENAME = 'vacuum.after.json';

export interface TurnReplayFingerprint {
  turnId: string;
  eventCount: number;
  projectionSha256: string;
  userTextSha256: string;
  assistantTextSha256: string;
  toolsSha256: string;
  diffSha256: string;
}

export interface InspectionReport {
  format: 1;
  inspectedAt: string;
  databasePath: string;
  releaseVersion: string;
  databaseBytes: number;
  databaseSha256: string;
  confirmationToken: string;
  journalMode: string;
  quickCheck: string[];
  foreignKeyViolations: number;
  freeBytes: number;
  requiredFreeBytes: number;
  migrations: string[];
  schema: {
    eventStorageV3Schema: boolean;
    eventStorageV3Active: boolean;
  };
  counts: {
    sessions: number;
    turns: number;
    events: number;
  };
  eventRows: {
    invalidJson: number;
    nullData: number;
    maximumBytes: number;
    estimatedArtifactBytes: number;
  };
  eventCountsByExecutorType: Array<{
    executor: string;
    type: string;
    rows: number;
    bytes: number;
  }>;
  eventCountsBySession: Array<{
    sessionId: string;
    rows: number;
    bytes: number;
  }>;
  compactionEstimate: {
    snapshotGroups: number;
    snapshotRowsRemovable: number;
    streamGroups: number;
    streamRowsRemovable: number;
  };
  turnFingerprints: TurnReplayFingerprint[];
  nonEventTables: Record<string, { rows: number; sha256: string }>;
}

export interface RunManifest {
  format: 1;
  runId: string;
  createdAt: string;
  releaseVersion: string;
  databasePath: string;
  runDirectory: string;
  backupPath: string;
  backupSha256: string;
  baseline: InspectionReport;
}

export interface MigrationCounters {
  sequenceRows: number;
  snapshotGroups: number;
  snapshotRowsRemoved: number;
  streamGroups: number;
  streamRowsRemoved: number;
  rewrittenRows: number;
}

export interface VerificationReport {
  format: 1;
  runId: string;
  verifiedAt: string;
  databasePath: string;
  databaseBytes: number;
  quickCheck: string[];
  foreignKeyViolations: number;
  maximumEventBytes: number;
  eventRows: number;
  artifactRows: number;
  artifactLinks: number;
  artifactChunks: number;
  replayFingerprintsMatch: boolean;
  nonEventTablesMatch: boolean;
  redundantCanonicalRows: number;
  counters: MigrationCounters;
  active: boolean;
}

export interface InspectOptions {
  databasePath: string;
  reportPath: string;
  releaseVersion: string;
  healthUrl?: string | null;
}

export interface MigrateOptions {
  databasePath: string;
  backupDirectory: string;
  releaseVersion: string;
  confirmationToken?: string;
  resumeRunId?: string;
  healthUrl?: string | null;
  batchSize?: number;
  /** Test-only crash injection; not exposed by the CLI. */
  interruptAfterBatches?: number;
  /** Test-only cleanup so an in-process resume can reacquire the lock. */
  keepLockOnFailure?: boolean;
}

interface MigrationRuntime {
  db: Db;
  manifest: RunManifest;
  counters: MigrationCounters;
  batchSize: number;
  batches: number;
  interruptAfterBatches?: number;
}

export class SimulatedMigrationInterruption extends Error {
  constructor() {
    super('simulated event-storage v3 migration interruption');
    this.name = 'SimulatedMigrationInterruption';
  }
}

export function createConfirmationToken(
  databasePath: string,
  databaseSha256: string,
  releaseVersion: string,
): string {
  const digest = createHash('sha256')
    .update(resolve(databasePath))
    .update('\0')
    .update(databaseSha256)
    .update('\0')
    .update(releaseVersion)
    .digest('hex');
  return `GIAN-EVENT-V3-${digest}`;
}

export async function inspectEventStorageV3(options: InspectOptions): Promise<InspectionReport> {
  const databasePath = resolveExistingDatabase(options.databasePath);
  await assertHostOffline(databasePath, options.healthUrl);
  const runId = `inspect-${randomUUID()}`;
  const lock = acquireMaintenanceLock({
    databasePath,
    runId,
    releaseVersion: options.releaseVersion,
    command: 'inspect',
  });
  let db: Db | undefined;
  try {
    db = openWritableDatabase(databasePath);
    proveExclusive(db);
    checkpoint(db);
    const report = buildInspectionReport(db, databasePath, options.releaseVersion);
    writeJsonAtomic(resolve(options.reportPath), report);
    return report;
  } finally {
    db?.close();
    lock.release();
  }
}

export async function migrateEventStorageV3(options: MigrateOptions): Promise<RunManifest> {
  const databasePath = resolveExistingDatabase(options.databasePath);
  await assertHostOffline(databasePath, options.healthUrl);
  return options.resumeRunId
    ? resumeMigration(databasePath, options)
    : startMigration(databasePath, options);
}

async function startMigration(
  databasePath: string,
  options: MigrateOptions,
): Promise<RunManifest> {
  if (!options.confirmationToken) {
    throw new Error('migrate requires the confirmation token printed by inspect');
  }
  const runId = createRunId();
  const runDirectory = resolve(options.backupDirectory, `event-storage-v3-${runId}`);
  mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
  assertSameFilesystem(databasePath, runDirectory);
  const lock = acquireMaintenanceLock({
    databasePath,
    runId,
    releaseVersion: options.releaseVersion,
    command: 'migrate',
  });
  let db: Db | undefined;
  let manifest: RunManifest | undefined;
  let mutationStarted = false;
  try {
    db = openWritableDatabase(databasePath);
    proveExclusive(db);
    checkpoint(db);
    if (hasEventStorageV3Schema(db) || readEventStorageV3Meta(db)) {
      throw new Error('database already contains event-storage v3 state; use --resume or verify/rollback');
    }
    const baseline = buildInspectionReport(db, databasePath, options.releaseVersion);
    if (baseline.confirmationToken !== options.confirmationToken) {
      throw new Error('confirmation token does not match the current database path, hash, and release');
    }
    assertPreflightSafe(baseline);

    const backupPath = join(runDirectory, 'gian.db.before-v3');
    await db.backup(backupPath);
    const backupSha256 = sha256File(backupPath);
    verifyBackup(backupPath, backupSha256, baseline);
    manifest = {
      format: 1,
      runId,
      createdAt: new Date().toISOString(),
      releaseVersion: options.releaseVersion,
      databasePath,
      runDirectory,
      backupPath,
      backupSha256,
      baseline,
    };
    writeJsonAtomic(join(runDirectory, MANIFEST_FILENAME), manifest);
    appendProgress(runDirectory, 'backup_verified', { databaseBytes: baseline.databaseBytes });

    installEventStorageV3Schema(db);
    mutationStarted = true;
    writeMeta(db, {
      state: 'installing',
      runId,
      backupPath,
      backupSha256,
      phase: 'sequence',
      cursor: null,
      counters: emptyCounters(),
    });
    await runMigration({
      db,
      manifest,
      counters: emptyCounters(),
      batchSize: normalizedBatchSize(options.batchSize),
      batches: 0,
      interruptAfterBatches: options.interruptAfterBatches,
    });
    db.close();
    db = undefined;
    lock.release();
    return manifest;
  } catch (error) {
    markFailed(db, runId);
    db?.close();
    if (!mutationStarted || options.keepLockOnFailure === false) lock.release();
    if (manifest) appendProgress(manifest.runDirectory, 'failed', { error: safeError(error) });
    throw error;
  }
}

async function resumeMigration(
  databasePath: string,
  options: MigrateOptions,
): Promise<RunManifest> {
  const expectedRunId = options.resumeRunId!;
  const probe = new Database(databasePath, { readonly: true, fileMustExist: true });
  const meta = readEventStorageV3Meta(probe);
  probe.close();
  if (!meta || meta.run_id !== expectedRunId) {
    throw new Error(`database does not contain resumable run ${expectedRunId}`);
  }
  const runDirectory = dirname(meta.backup_path);
  const manifest = readRunManifest(runDirectory);
  assertRunBinding(manifest, databasePath, options.releaseVersion, expectedRunId);
  const lock = acquireMaintenanceLock({
    databasePath,
    runId: expectedRunId,
    releaseVersion: options.releaseVersion,
    command: 'resume',
    allowStaleForRunId: expectedRunId,
  });
  let db: Db | undefined;
  try {
    verifyBackup(manifest.backupPath, manifest.backupSha256, manifest.baseline);
    db = openWritableDatabase(databasePath);
    proveExclusive(db);
    const current = readEventStorageV3Meta(db);
    if (!current || current.run_id !== expectedRunId) throw new Error('migration metadata changed');
    if (current.state === 'active') {
      db.close();
      db = undefined;
      lock.release();
      return manifest;
    }
    const counters = parseCounters(current.counters_json);
    writeMeta(db, {
      state: current.phase === 'verify' ? 'verifying' : 'migrating',
      runId: current.run_id,
      backupPath: current.backup_path,
      backupSha256: current.backup_sha256,
      phase: current.phase,
      cursor: current.cursor ? JSON.parse(current.cursor) as unknown : null,
      counters,
    });
    await runMigration({
      db,
      manifest,
      counters,
      batchSize: normalizedBatchSize(options.batchSize),
      batches: 0,
      interruptAfterBatches: options.interruptAfterBatches,
    });
    db.close();
    db = undefined;
    lock.release();
    return manifest;
  } catch (error) {
    markFailed(db, expectedRunId);
    db?.close();
    if (options.keepLockOnFailure === false) lock.release();
    appendProgress(runDirectory, 'failed', { error: safeError(error) });
    throw error;
  }
}

async function runMigration(runtime: MigrationRuntime): Promise<void> {
  const meta = readEventStorageV3Meta(runtime.db);
  if (!meta || meta.run_id !== runtime.manifest.runId) throw new Error('missing migration metadata');
  if (phaseAtOrBefore(meta.phase, 'sequence')) runSequencePhase(runtime);
  if (phaseAtOrBefore(readRequiredMeta(runtime.db).phase, 'snapshots')) runSnapshotPhase(runtime);
  if (phaseAtOrBefore(readRequiredMeta(runtime.db).phase, 'streams')) runStreamPhase(runtime);
  if (phaseAtOrBefore(readRequiredMeta(runtime.db).phase, 'rewrite')) runRewritePhase(runtime);
  if (readRequiredMeta(runtime.db).phase === 'verify') runVerifyPhase(runtime);
}

function runSequencePhase(runtime: MigrationRuntime): void {
  const { db } = runtime;
  const meta = readRequiredMeta(db);
  const sessions = db.prepare(
    'SELECT DISTINCT session_id AS id FROM events ORDER BY session_id',
  ).all() as Array<{ id: string }>;
  const cursor = parseCursor(meta.cursor, { sessionIndex: 0, rowid: 0, sequence: 0 });
  let sessionIndex = cursor.sessionIndex;
  let rowid = cursor.rowid;
  let sequence = cursor.sequence;

  while (sessionIndex < sessions.length) {
    const session = sessions[sessionIndex];
    if (!session) break;
    const rows = db.prepare(
      `SELECT rowid, id FROM events
       WHERE session_id = ? AND rowid > ?
       ORDER BY rowid LIMIT ?`,
    ).all(session.id, rowid, runtime.batchSize) as Array<{ rowid: number; id: string }>;
    if (rows.length === 0) {
      sessionIndex += 1;
      rowid = 0;
      sequence = 0;
      updateProgressMeta(runtime, 'migrating', 'sequence', { sessionIndex, rowid, sequence });
      continue;
    }
    db.transaction(() => {
      const update = db.prepare('UPDATE events SET sequence = ? WHERE id = ?');
      for (const row of rows) {
        sequence += 1;
        update.run(sequence, row.id);
      }
      rowid = rows[rows.length - 1]!.rowid;
      runtime.counters.sequenceRows += rows.length;
      updateProgressMeta(runtime, 'migrating', 'sequence', { sessionIndex, rowid, sequence });
    })();
    batchCompleted(runtime, 'sequence');
  }

  assertSequenceValid(db);
  db.transaction(() => {
    finalizeEventStorageV3Schema(db);
    updateProgressMeta(runtime, 'migrating', 'snapshots', null);
  })();
  checkpoint(db);
  appendProgress(runtime.manifest.runDirectory, 'sequence_complete', runtime.counters);
}

function runSnapshotPhase(runtime: MigrationRuntime): void {
  const { db } = runtime;
  const history = new SessionHistoryStore(db, { mode: 'migration' });
  let cursor = parseCursor(readRequiredMeta(db).cursor, { turnId: '' }).turnId;
  while (true) {
    const turns = db.prepare(
      `SELECT id FROM turns WHERE id > ? ORDER BY id LIMIT ?`,
    ).all(cursor, runtime.batchSize) as Array<{ id: string }>;
    if (turns.length === 0) break;
    for (const turn of turns) {
      db.transaction(() => {
        const before = fingerprintTurn(history, turn.id);
        const result = history.compactTurnSnapshots(turn.id);
        const after = fingerprintTurn(history, turn.id);
        assertFingerprintEqual(before, after, turn.id, 'snapshot compaction');
        runtime.counters.snapshotGroups += result.groups;
        runtime.counters.snapshotRowsRemoved += result.removed;
        cursor = turn.id;
        updateProgressMeta(runtime, 'migrating', 'snapshots', { turnId: cursor });
      })();
    }
    batchCompleted(runtime, 'snapshots');
  }
  updateProgressMeta(runtime, 'migrating', 'streams', null);
  checkpoint(db);
  appendProgress(runtime.manifest.runDirectory, 'snapshots_complete', runtime.counters);
}

function runStreamPhase(runtime: MigrationRuntime): void {
  const { db } = runtime;
  const history = new SessionHistoryStore(db, { mode: 'migration' });
  let cursor = parseCursor(readRequiredMeta(db).cursor, { turnId: '' }).turnId;
  while (true) {
    const turns = db.prepare(
      `SELECT id FROM turns
       WHERE id > ?
         AND status IN ('completed', 'stopped', 'failed', 'error', 'cancelled', 'done')
       ORDER BY id LIMIT ?`,
    ).all(cursor, runtime.batchSize) as Array<{ id: string }>;
    if (turns.length === 0) break;
    for (const turn of turns) {
      db.transaction(() => {
        const before = fingerprintTurn(history, turn.id);
        const result = history.compactTurnStreamsDetailed(turn.id);
        const after = fingerprintTurn(history, turn.id);
        assertFingerprintEqual(before, after, turn.id, 'stream compaction');
        runtime.counters.streamGroups += result.groups;
        runtime.counters.streamRowsRemoved += result.removed;
        cursor = turn.id;
        updateProgressMeta(runtime, 'migrating', 'streams', { turnId: cursor });
      })();
    }
    batchCompleted(runtime, 'streams');
  }
  updateProgressMeta(runtime, 'migrating', 'rewrite', null);
  checkpoint(db);
  appendProgress(runtime.manifest.runDirectory, 'streams_complete', runtime.counters);
}

function runRewritePhase(runtime: MigrationRuntime): void {
  const { db } = runtime;
  const events = new EventStore(db, { mode: 'migration' });
  let cursor = parseCursor(readRequiredMeta(db).cursor, { rowid: 0 }).rowid;
  while (true) {
    const rows = db.prepare(
      `SELECT rowid, id, data FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    ).all(cursor, runtime.batchSize) as Array<{ rowid: number; id: string; data: string }>;
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const row of rows) {
        const decoded = events.decode(row.data);
        const before = hashCanonical(decoded);
        events.replaceData(row.id, decoded);
        const rewritten = db.prepare('SELECT data FROM events WHERE id = ?').get(row.id) as {
          data: string;
        } | undefined;
        if (!rewritten || hashCanonical(events.decode(rewritten.data)) !== before) {
          throw new Error(`event ${row.id} failed lossless v3 round-trip`);
        }
      }
      cursor = rows[rows.length - 1]!.rowid;
      runtime.counters.rewrittenRows += rows.length;
      updateProgressMeta(runtime, 'migrating', 'rewrite', { rowid: cursor });
    })();
    batchCompleted(runtime, 'rewrite');
  }
  updateProgressMeta(runtime, 'verifying', 'verify', null);
  checkpoint(db);
  appendProgress(runtime.manifest.runDirectory, 'rewrite_complete', runtime.counters);
}

function runVerifyPhase(runtime: MigrationRuntime): void {
  const report = buildVerificationReport(runtime.db, runtime.manifest, runtime.counters);
  runtime.db.transaction(() => {
    updateProgressMeta(runtime, 'active', 'complete', null);
  })();
  writeJsonAtomic(join(runtime.manifest.runDirectory, VERIFY_FILENAME), {
    ...report,
    active: true,
    activatedAt: new Date().toISOString(),
  });
  checkpoint(runtime.db);
  appendProgress(runtime.manifest.runDirectory, 'active', runtime.counters);
}

export async function verifyEventStorageV3(options: {
  databasePath: string;
  runDirectory: string;
  releaseVersion: string;
  healthUrl?: string | null;
}): Promise<VerificationReport> {
  const databasePath = resolveExistingDatabase(options.databasePath);
  const manifest = readRunManifest(resolve(options.runDirectory));
  assertRunBinding(manifest, databasePath, options.releaseVersion, manifest.runId);
  await assertHostOffline(databasePath, options.healthUrl);
  const lock = acquireMaintenanceLock({
    databasePath,
    runId: manifest.runId,
    releaseVersion: options.releaseVersion,
    command: 'verify',
    allowStaleForRunId: manifest.runId,
  });
  let db: Db | undefined;
  try {
    verifyBackup(manifest.backupPath, manifest.backupSha256, manifest.baseline);
    db = openWritableDatabase(databasePath);
    proveExclusive(db);
    const counters = parseCounters(readRequiredMeta(db).counters_json);
    const report = buildVerificationReport(db, manifest, counters);
    writeJsonAtomic(join(manifest.runDirectory, VERIFY_FILENAME), report);
    return report;
  } finally {
    db?.close();
    lock.release();
  }
}

export async function rollbackEventStorageV3(options: {
  databasePath: string;
  runDirectory: string;
  releaseVersion: string;
  healthUrl?: string | null;
}): Promise<string> {
  const databasePath = resolveExistingDatabase(options.databasePath);
  const manifest = readRunManifest(resolve(options.runDirectory));
  assertRunBinding(manifest, databasePath, options.releaseVersion, manifest.runId);
  await assertHostOffline(databasePath, options.healthUrl);
  assertSameFilesystem(databasePath, manifest.runDirectory);
  const lock = acquireMaintenanceLock({
    databasePath,
    runId: manifest.runId,
    releaseVersion: options.releaseVersion,
    command: 'rollback',
    allowStaleForRunId: manifest.runId,
  });
  const failedPath = join(manifest.runDirectory, `gian.db.failed-v3-${Date.now()}`);
  const restoreCandidate = `${databasePath}.restore-${manifest.runId}`;
  try {
    verifyBackup(manifest.backupPath, manifest.backupSha256, manifest.baseline);
    const current = openWritableDatabase(databasePath);
    proveExclusive(current);
    checkpoint(current);
    current.close();

    copyFileSync(manifest.backupPath, restoreCandidate);
    fsyncFile(restoreCandidate);
    removeSidecars(databasePath);
    renameSync(databasePath, failedPath);
    try {
      renameSync(restoreCandidate, databasePath);
    } catch (error) {
      renameSync(failedPath, databasePath);
      throw error;
    }
    fsyncFile(databasePath);
    fsyncDirectory(dirname(databasePath));
    verifyBackup(databasePath, sha256File(databasePath), manifest.baseline, false);
    appendProgress(manifest.runDirectory, 'rollback_complete', { failedPath });
    lock.release();
    return failedPath;
  } catch (error) {
    if (existsSync(restoreCandidate)) unlinkSync(restoreCandidate);
    appendProgress(manifest.runDirectory, 'rollback_failed', { error: safeError(error) });
    throw error;
  }
}

export async function vacuumEventStorageV3(options: {
  databasePath: string;
  runDirectory: string;
  releaseVersion: string;
  healthUrl?: string | null;
}): Promise<{ beforeBytes: number; afterBytes: number }> {
  const databasePath = resolveExistingDatabase(options.databasePath);
  const manifest = readRunManifest(resolve(options.runDirectory));
  assertRunBinding(manifest, databasePath, options.releaseVersion, manifest.runId);
  await assertHostOffline(databasePath, options.healthUrl);
  const lock = acquireMaintenanceLock({
    databasePath,
    runId: manifest.runId,
    releaseVersion: options.releaseVersion,
    command: 'vacuum',
    allowStaleForRunId: manifest.runId,
  });
  let db: Db | undefined;
  try {
    db = openWritableDatabase(databasePath);
    proveExclusive(db);
    const meta = readRequiredMeta(db);
    if (meta.state !== 'active' || meta.run_id !== manifest.runId) {
      throw new Error('vacuum requires the active migration run recorded by the database');
    }
    const counters = parseCounters(meta.counters_json);
    buildVerificationReport(db, manifest, counters);
    const beforeBytes = statSync(databasePath).size;
    const freeBytes = availableBytes(dirname(databasePath));
    if (freeBytes < beforeBytes * 2) {
      throw new Error(`insufficient free space for vacuum: ${freeBytes} available, ${beforeBytes * 2} required`);
    }
    checkpoint(db);
    db.exec('VACUUM');
    db.exec('PRAGMA optimize');
    checkpoint(db);
    const afterReport = buildVerificationReport(db, manifest, counters);
    const afterBytes = statSync(databasePath).size;
    writeJsonAtomic(join(manifest.runDirectory, VACUUM_FILENAME), {
      format: 1,
      runId: manifest.runId,
      vacuumedAt: new Date().toISOString(),
      beforeBytes,
      afterBytes,
      verification: afterReport,
    });
    db.close();
    db = undefined;
    lock.release();
    return { beforeBytes, afterBytes };
  } finally {
    db?.close();
  }
}

function buildInspectionReport(
  db: Db,
  databasePath: string,
  releaseVersion: string,
): InspectionReport {
  assertExpectedSchema(db);
  const invalidJson = scalar(
    db,
    `SELECT COUNT(*) AS n FROM events
     WHERE json_valid(data) = 0 OR json_type(data) <> 'object'`,
  );
  const nullData = scalar(db, `SELECT COUNT(*) AS n FROM events WHERE data IS NULL`);
  if (invalidJson > 0 || nullData > 0) {
    throw new Error(`event preflight failed: ${invalidJson} invalid JSON rows, ${nullData} null rows`);
  }
  const databaseBytes = statSync(databasePath).size;
  const databaseSha256 = sha256File(databasePath);
  const quickCheck = pragmaStrings(db, 'quick_check');
  const foreignKeyViolations = pragmaRows(db, 'foreign_key_check').length;
  const eventRow = db.prepare(
    `SELECT COALESCE(MAX(length(CAST(data AS BLOB))), 0) AS maximumBytes,
            COALESCE(SUM(CASE WHEN length(CAST(data AS BLOB)) >= 16384
                         THEN length(CAST(data AS BLOB)) ELSE 0 END), 0)
              AS estimatedArtifactBytes
     FROM events`,
  ).get() as { maximumBytes: number; estimatedArtifactBytes: number };
  const compactionEstimate = estimateCompaction(db);
  const report: InspectionReport = {
    format: 1,
    inspectedAt: new Date().toISOString(),
    databasePath,
    releaseVersion,
    databaseBytes,
    databaseSha256,
    confirmationToken: createConfirmationToken(databasePath, databaseSha256, releaseVersion),
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    quickCheck,
    foreignKeyViolations,
    freeBytes: availableBytes(dirname(databasePath)),
    requiredFreeBytes: databaseBytes * 4,
    migrations: tableExists(db, 'migrations')
      ? (db.prepare('SELECT filename FROM migrations ORDER BY filename').all() as Array<{ filename: string }>)
        .map(row => row.filename)
      : [],
    schema: {
      eventStorageV3Schema: hasEventStorageV3Schema(db),
      eventStorageV3Active: isEventStorageV3Active(db),
    },
    counts: {
      sessions: scalar(db, 'SELECT COUNT(*) AS n FROM sessions'),
      turns: scalar(db, 'SELECT COUNT(*) AS n FROM turns'),
      events: scalar(db, 'SELECT COUNT(*) AS n FROM events'),
    },
    eventRows: {
      invalidJson,
      nullData,
      maximumBytes: eventRow.maximumBytes,
      estimatedArtifactBytes: eventRow.estimatedArtifactBytes,
    },
    eventCountsByExecutorType: db.prepare(
      `SELECT s.executor, e.type, COUNT(*) AS rows, COALESCE(SUM(length(e.data)), 0) AS bytes
       FROM events e JOIN sessions s ON s.id = e.session_id
       GROUP BY s.executor, e.type ORDER BY s.executor, e.type`,
    ).all() as InspectionReport['eventCountsByExecutorType'],
    eventCountsBySession: db.prepare(
      `SELECT session_id AS sessionId, COUNT(*) AS rows,
              COALESCE(SUM(length(data)), 0) AS bytes
       FROM events GROUP BY session_id ORDER BY session_id`,
    ).all() as InspectionReport['eventCountsBySession'],
    compactionEstimate,
    turnFingerprints: allTurnFingerprints(db),
    nonEventTables: nonEventTableFingerprints(db),
  };
  return report;
}

function buildVerificationReport(
  db: Db,
  manifest: RunManifest,
  counters: MigrationCounters,
): VerificationReport {
  const meta = readRequiredMeta(db);
  if (meta.run_id !== manifest.runId || meta.version !== MIGRATION_VERSION) {
    throw new Error('event-storage metadata does not match the run manifest');
  }
  assertSequenceValid(db);
  const quickCheck = pragmaStrings(db, 'quick_check');
  if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') throw new Error('database quick_check failed');
  const foreignKeyViolations = pragmaRows(db, 'foreign_key_check').length;
  if (foreignKeyViolations > 0) throw new Error(`database has ${foreignKeyViolations} FK violation(s)`);
  const maximumEventBytes = scalar(
    db,
    'SELECT COALESCE(MAX(length(CAST(data AS BLOB))), 0) AS n FROM events',
  );
  if (maximumEventBytes > MAX_STORED_EVENT_BYTES) {
    throw new Error(`event row exceeds ${MAX_STORED_EVENT_BYTES} bytes`);
  }
  const actualFingerprints = allTurnFingerprints(db, true);
  assertAllFingerprints(manifest.baseline.turnFingerprints, actualFingerprints);
  const actualTables = nonEventTableFingerprints(db);
  assertNonEventTables(manifest.baseline.nonEventTables, actualTables);
  if (scalar(db, 'SELECT COUNT(*) AS n FROM sessions') !== manifest.baseline.counts.sessions) {
    throw new Error('session count changed during migration');
  }
  if (scalar(db, 'SELECT COUNT(*) AS n FROM turns') !== manifest.baseline.counts.turns) {
    throw new Error('turn count changed during migration');
  }
  const redundantCanonicalRows = countRedundantCanonicalRows(db);
  if (redundantCanonicalRows !== 0) {
    throw new Error(`${redundantCanonicalRows} recognized redundant event row(s) remain`);
  }
  const artifacts = verifyArtifacts(db);
  return {
    format: 1,
    runId: manifest.runId,
    verifiedAt: new Date().toISOString(),
    databasePath: manifest.databasePath,
    databaseBytes: statSync(manifest.databasePath).size,
    quickCheck,
    foreignKeyViolations,
    maximumEventBytes,
    eventRows: scalar(db, 'SELECT COUNT(*) AS n FROM events'),
    artifactRows: artifacts.artifacts,
    artifactLinks: artifacts.links,
    artifactChunks: artifacts.chunks,
    replayFingerprintsMatch: true,
    nonEventTablesMatch: true,
    redundantCanonicalRows,
    counters,
    active: meta.state === 'active',
  };
}

function allTurnFingerprints(db: Db, migrationMode = false): TurnReplayFingerprint[] {
  const history = new SessionHistoryStore(db, migrationMode || hasEventStorageV3Schema(db)
    ? { mode: 'migration' }
    : {});
  const turns = db.prepare('SELECT id FROM turns ORDER BY id').all() as Array<{ id: string }>;
  return turns.map(turn => fingerprintTurn(history, turn.id));
}

function fingerprintTurn(history: SessionHistoryStore, turnId: string): TurnReplayFingerprint {
  const events = history.canonicalTurnEvents(turnId);
  const projection = events.map(event => ({
    event: event.display?.type ?? event.event,
    identity: snapshotIdentity(event) ?? event.call_id,
    provider: event.provider ?? null,
    display: event.display ?? null,
  }));
  const userText: unknown[] = [];
  const assistantText: unknown[] = [];
  const tools: unknown[] = [];
  const diffs: unknown[] = [];
  for (const event of events) {
    const display = event.display;
    if (!display) continue;
    if (display.type === 'message') {
      const data = display.data as unknown as Record<string, unknown>;
      const target = event.event === 'user_message' || data.role === 'user' ? userText : assistantText;
      target.push(data.text ?? '');
    } else if (display.type === 'activity.tool' || display.type === 'agent') {
      tools.push(display);
    } else if (display.type === 'activity.file-change') {
      diffs.push(display);
    }
  }
  return {
    turnId,
    eventCount: events.length,
    projectionSha256: hashCanonical(projection),
    userTextSha256: hashCanonical(userText),
    assistantTextSha256: hashCanonical(assistantText),
    toolsSha256: hashCanonical(tools),
    diffSha256: hashCanonical(diffs),
  };
}

function estimateCompaction(db: Db): InspectionReport['compactionEstimate'] {
  const snapshot = db.prepare(`
    WITH recognized AS (
      SELECT turn_id,
             CASE
               WHEN type = 'diff.updated' THEN 'diff'
               WHEN type = 'codex.agent' THEN 'agent:' || call_id
               WHEN type = 'acp.sessionUpdate'
                AND COALESCE(json_extract(data, '$.raw.update.sessionUpdate'), json_extract(data, '$.update.sessionUpdate'))
                    IN ('tool_call', 'tool_call_update')
               THEN 'tool:' || COALESCE(
                 json_extract(data, '$.raw.update.toolCallId'),
                 json_extract(data, '$.update.toolCallId'),
                 json_extract(data, '$.display.data.itemId')
               )
               ELSE NULL
             END AS identity
      FROM events
    ), groups AS (
      SELECT COUNT(*) AS n FROM recognized
      WHERE identity IS NOT NULL
      GROUP BY turn_id, identity HAVING COUNT(*) > 1
    )
    SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS removable FROM groups
  `).get() as { groups: number; removable: number };
  const streams = db.prepare(`
    WITH recognized AS (
      SELECT e.turn_id, e.call_id,
             CASE
               WHEN json_extract(e.data, '$.display.type') IN
                    ('message', 'activity.reasoning', 'activity.command', 'plan')
                 THEN json_extract(e.data, '$.display.type')
               WHEN e.type IN ('assistant_text', 'output.text', 'output.text.delta') THEN 'message'
               WHEN e.type = 'reasoning' THEN 'activity.reasoning'
               WHEN e.type IN ('command_execution', 'output.command.delta') THEN 'activity.command'
               WHEN e.type = 'plan_update' THEN 'plan'
               ELSE NULL
             END AS display_type
      FROM events e JOIN turns t ON t.id = e.turn_id
      WHERE t.status IN ('completed', 'stopped', 'failed', 'error', 'cancelled', 'done')
        AND e.type <> 'user_message'
    ), groups AS (
      SELECT COUNT(*) AS n FROM recognized
      WHERE display_type IS NOT NULL
      GROUP BY turn_id, call_id, display_type HAVING COUNT(*) > 1
    )
    SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS removable FROM groups
  `).get() as { groups: number; removable: number };
  return {
    snapshotGroups: snapshot.groups,
    snapshotRowsRemovable: snapshot.removable,
    streamGroups: streams.groups,
    streamRowsRemovable: streams.removable,
  };
}

function nonEventTableFingerprints(db: Db): Record<string, { rows: number; sha256: string }> {
  const excluded = new Set([
    'events',
    'event_storage_meta',
    'event_artifacts',
    'event_artifact_chunks',
    'event_artifact_links',
    'event_rebuild_state',
  ]);
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all() as Array<{ name: string }>).map(row => row.name).filter(name => !excluded.has(name));
  return Object.fromEntries(tables.map(table => {
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`).iterate()) {
      hash.update(canonicalJson(row));
      hash.update('\n');
      rows += 1;
    }
    return [table, { rows, sha256: hash.digest('hex') }];
  }));
}

function verifyArtifacts(db: Db): { artifacts: number; links: number; chunks: number } {
  const events = new EventStore(db, { mode: 'migration' });
  const artifacts = db.prepare(
    `SELECT id, mime_type, format, encoding, byte_length, stored_size, chunk_count
     FROM event_artifacts ORDER BY id`,
  ).all() as Array<{
    id: string;
    mime_type: string;
    format: 'text' | 'json' | 'data-url';
    encoding: 'identity' | 'gzip';
    byte_length: number;
    stored_size: number;
    chunk_count: number;
  }>;
  let chunkTotal = 0;
  for (const artifact of artifacts) {
    const chunks = db.prepare(
      `SELECT chunk_index, data FROM event_artifact_chunks
       WHERE artifact_id = ? ORDER BY chunk_index`,
    ).all(artifact.id) as Array<{ chunk_index: number; data: Buffer }>;
    if (chunks.length !== artifact.chunk_count) throw new Error(`artifact ${artifact.id} chunk count mismatch`);
    if (chunks.some((chunk, index) => chunk.chunk_index !== index)) {
      throw new Error(`artifact ${artifact.id} chunk order mismatch`);
    }
    if (chunks.some(chunk => chunk.data.byteLength > EVENT_ARTIFACT_CHUNK_BYTES)) {
      throw new Error(`artifact ${artifact.id} has an oversized chunk`);
    }
    const stored = Buffer.concat(chunks.map(chunk => chunk.data));
    if (stored.byteLength !== artifact.stored_size) throw new Error(`artifact ${artifact.id} stored size mismatch`);
    const source = artifact.encoding === 'gzip' ? gunzipSync(stored) : stored;
    if (source.byteLength !== artifact.byte_length) throw new Error(`artifact ${artifact.id} source size mismatch`);
    const expected = `sha256:${createHash('sha256')
      .update(artifact.format)
      .update('\0')
      .update(artifact.mime_type)
      .update('\0')
      .update(source)
      .digest('hex')}`;
    if (expected !== artifact.id) throw new Error(`artifact ${artifact.id} hash mismatch`);
    chunkTotal += chunks.length;
  }
  const dangling = scalar(db, `
    SELECT COUNT(*) AS n FROM event_artifact_links l
    LEFT JOIN events e ON e.id = l.event_id
    LEFT JOIN event_artifacts a ON a.id = l.artifact_id
    WHERE e.id IS NULL OR a.id IS NULL
  `);
  if (dangling > 0) throw new Error(`${dangling} dangling artifact link(s)`);
  for (const row of db.prepare('SELECT id, data FROM events').iterate() as Iterable<{
    id: string;
    data: string;
  }>) {
    const parsed = JSON.parse(row.data) as unknown;
    const expectedRefs = collectArtifactRefs(parsed);
    const actualRefs = (db.prepare(
      `SELECT artifact_id AS artifactId, path
       FROM event_artifact_links WHERE event_id = ? ORDER BY path`,
    ).all(row.id) as Array<{ artifactId: string; path: string }>);
    if (canonicalJson(expectedRefs) !== canonicalJson(actualRefs)) {
      throw new Error(`event ${row.id} artifact references do not match link rows`);
    }
    events.decode(row.data);
  }
  return {
    artifacts: artifacts.length,
    links: scalar(db, 'SELECT COUNT(*) AS n FROM event_artifact_links'),
    chunks: chunkTotal,
  };
}

function collectArtifactRefs(value: unknown): Array<{ artifactId: string; path: string }> {
  const refs: Array<{ artifactId: string; path: string }> = [];
  if (
    isRecord(value)
    && value.__gian_event === 3
    && isArtifactReference(value.payload)
  ) {
    refs.push({ artifactId: value.payload.id, path: '$payload' });
    return refs;
  }
  const visit = (candidate: unknown, path: string): void => {
    if (isArtifactReference(candidate)) {
      refs.push({ artifactId: candidate.id, path: path || '$' });
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, item] of Object.entries(candidate)) {
      visit(item, path ? `${path}.${key}` : key);
    }
  };
  visit(value, '');
  return refs.sort((left, right) => left.path.localeCompare(right.path));
}

function isArtifactReference(value: unknown): value is { id: string } {
  return isRecord(value)
    && value.__gian_artifact === 1
    && typeof value.id === 'string';
}

function countRedundantCanonicalRows(db: Db): number {
  const estimate = estimateCompaction(db);
  return estimate.snapshotRowsRemovable + estimate.streamRowsRemovable;
}

function assertSequenceValid(db: Db): void {
  const missing = scalar(db, 'SELECT COUNT(*) AS n FROM events WHERE sequence IS NULL');
  const duplicates = scalar(db, `
    SELECT COUNT(*) AS n FROM (
      SELECT session_id, sequence FROM events
      WHERE sequence IS NOT NULL GROUP BY session_id, sequence HAVING COUNT(*) > 1
    )
  `);
  const outOfOrder = scalar(db, `
    SELECT COUNT(*) AS n FROM (
      SELECT sequence, LAG(sequence) OVER (PARTITION BY session_id ORDER BY rowid) AS previous
      FROM events
    ) WHERE previous IS NOT NULL AND sequence <= previous
  `);
  if (missing || duplicates || outOfOrder) {
    throw new Error(`invalid sequence backfill: missing=${missing}, duplicates=${duplicates}, order=${outOfOrder}`);
  }
}

function verifyBackup(
  backupPath: string,
  expectedSha256: string,
  baseline: InspectionReport,
  requireExpectedHash = true,
): void {
  if (!existsSync(backupPath)) throw new Error(`verified backup is missing: ${backupPath}`);
  if (requireExpectedHash && sha256File(backupPath) !== expectedSha256) {
    throw new Error(`backup hash mismatch: ${backupPath}`);
  }
  const db = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const quick = pragmaStrings(db, 'quick_check');
    if (quick.length !== 1 || quick[0] !== 'ok') throw new Error('backup quick_check failed');
    if (pragmaRows(db, 'foreign_key_check').length > 0) throw new Error('backup foreign_key_check failed');
    const counts = {
      sessions: scalar(db, 'SELECT COUNT(*) AS n FROM sessions'),
      turns: scalar(db, 'SELECT COUNT(*) AS n FROM turns'),
      events: scalar(db, 'SELECT COUNT(*) AS n FROM events'),
    };
    if (canonicalJson(counts) !== canonicalJson(baseline.counts)) throw new Error('backup row counts differ');
    assertAllFingerprints(baseline.turnFingerprints, allTurnFingerprints(db));
    assertNonEventTables(baseline.nonEventTables, nonEventTableFingerprints(db));
  } finally {
    db.close();
  }
}

function assertPreflightSafe(report: InspectionReport): void {
  if (report.quickCheck.length !== 1 || report.quickCheck[0] !== 'ok') {
    throw new Error(`database quick_check failed: ${report.quickCheck.join(', ')}`);
  }
  if (report.foreignKeyViolations > 0) throw new Error('database has foreign-key violations');
  if (report.eventRows.invalidJson > 0 || report.eventRows.nullData > 0) {
    throw new Error('database contains malformed event rows');
  }
  if (report.freeBytes < report.requiredFreeBytes) {
    throw new Error(
      `insufficient free space: ${report.freeBytes} available, ${report.requiredFreeBytes} required`,
    );
  }
}

function assertExpectedSchema(db: Db): void {
  for (const table of ['migrations', 'sessions', 'turns', 'events']) {
    if (!tableExists(db, table)) throw new Error(`unexpected database schema: missing ${table}`);
  }
  const requiredEventColumns = new Set(['id', 'session_id', 'turn_id', 'call_id', 'type', 'data', 'created_at']);
  const actual = new Set(
    (db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>).map(row => row.name),
  );
  for (const column of requiredEventColumns) {
    if (!actual.has(column)) throw new Error(`unexpected events schema: missing ${column}`);
  }
}

function openWritableDatabase(path: string): Db {
  const db = new Database(path, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

function proveExclusive(db: Db): void {
  db.exec('BEGIN EXCLUSIVE');
  db.exec('ROLLBACK');
}

function checkpoint(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

async function assertHostOffline(
  databasePath: string,
  healthUrl: string | null | undefined,
): Promise<void> {
  if (healthUrl === null) return;
  const productionDatabase = resolve(homedir(), '.gian', 'gian.db');
  if (healthUrl === undefined && resolve(databasePath) !== productionDatabase) return;
  const url = healthUrl ?? 'http://127.0.0.1:8990/health';
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`Gian Host is reachable at ${url}; quit Gian before migration`);
}

function writeMeta(db: Db, input: {
  state: EventStorageV3State;
  runId: string;
  backupPath: string;
  backupSha256: string;
  phase: string;
  cursor: unknown;
  counters: MigrationCounters;
}): void {
  db.prepare(`
    INSERT INTO event_storage_meta
      (singleton, version, state, run_id, backup_path, backup_sha256,
       phase, cursor, counters_json, updated_at)
    VALUES (1, 3, ?, ?, ?, ?, ?, ?, ?, ?)
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
  `).run(
    input.state,
    input.runId,
    input.backupPath,
    input.backupSha256,
    input.phase,
    input.cursor === null ? null : JSON.stringify(input.cursor),
    JSON.stringify(input.counters),
    new Date().toISOString(),
  );
}

function updateProgressMeta(
  runtime: MigrationRuntime,
  state: EventStorageV3State,
  phase: string,
  cursor: unknown,
): void {
  writeMeta(runtime.db, {
    state,
    runId: runtime.manifest.runId,
    backupPath: runtime.manifest.backupPath,
    backupSha256: runtime.manifest.backupSha256,
    phase,
    cursor,
    counters: runtime.counters,
  });
}

function markFailed(db: Db | undefined, runId: string): void {
  if (!db || !hasEventStorageV3Schema(db)) return;
  const meta = readEventStorageV3Meta(db);
  if (!meta || meta.run_id !== runId || meta.state === 'active') return;
  try {
    db.prepare(
      `UPDATE event_storage_meta
       SET state = 'failed', updated_at = ?, counters_json = counters_json
       WHERE singleton = 1 AND run_id = ?`,
    ).run(new Date().toISOString(), runId);
  } catch {
    // Preserve the original migration error and the maintenance lock.
  }
}

function batchCompleted(runtime: MigrationRuntime, phase: string): void {
  runtime.batches += 1;
  if (runtime.batches % 10 === 0) {
    appendProgress(runtime.manifest.runDirectory, `${phase}_progress`, runtime.counters);
  }
  if (
    runtime.interruptAfterBatches !== undefined
    && runtime.batches >= runtime.interruptAfterBatches
  ) throw new SimulatedMigrationInterruption();
}

function phaseAtOrBefore(current: string, expected: string): boolean {
  const phases = ['sequence', 'snapshots', 'streams', 'rewrite', 'verify', 'complete'];
  const currentIndex = phases.indexOf(current);
  const expectedIndex = phases.indexOf(expected);
  if (currentIndex < 0) throw new Error(`unknown migration phase ${current}`);
  return currentIndex <= expectedIndex;
}

function emptyCounters(): MigrationCounters {
  return {
    sequenceRows: 0,
    snapshotGroups: 0,
    snapshotRowsRemoved: 0,
    streamGroups: 0,
    streamRowsRemoved: 0,
    rewrittenRows: 0,
  };
}

function parseCounters(value: string): MigrationCounters {
  const parsed = JSON.parse(value) as Partial<MigrationCounters>;
  const result = emptyCounters();
  for (const key of Object.keys(result) as Array<keyof MigrationCounters>) {
    const candidate = parsed[key];
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`invalid migration counter ${key}`);
    }
    result[key] = candidate;
  }
  return result;
}

function parseCursor<T extends Record<string, string | number>>(
  value: string | null,
  fallback: T,
): T {
  if (!value) return fallback;
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('invalid migration cursor');
  for (const [key, expected] of Object.entries(fallback)) {
    if (typeof parsed[key] !== typeof expected) throw new Error(`invalid migration cursor field ${key}`);
  }
  return parsed as T;
}

function readRequiredMeta(db: Db): NonNullable<ReturnType<typeof readEventStorageV3Meta>> {
  const meta = readEventStorageV3Meta(db);
  if (!meta) throw new Error('event-storage migration metadata is missing');
  return meta;
}

function assertRunBinding(
  manifest: RunManifest,
  databasePath: string,
  releaseVersion: string,
  runId: string,
): void {
  if (manifest.runId !== runId) throw new Error('run ID does not match manifest');
  if (resolve(manifest.databasePath) !== resolve(databasePath)) throw new Error('run database path mismatch');
  if (manifest.releaseVersion !== releaseVersion) {
    throw new Error(`run belongs to release ${manifest.releaseVersion}, not ${releaseVersion}`);
  }
}

function assertFingerprintEqual(
  before: TurnReplayFingerprint,
  after: TurnReplayFingerprint,
  turnId: string,
  operation: string,
): void {
  if (canonicalJson(before) !== canonicalJson(after)) {
    const changed = (Object.keys(before) as Array<keyof TurnReplayFingerprint>)
      .filter(key => before[key] !== after[key]);
    throw new Error(
      `${operation} changed canonical replay for turn ${turnId} (${changed.join(', ')})`,
    );
  }
}

function assertAllFingerprints(
  expected: TurnReplayFingerprint[],
  actual: TurnReplayFingerprint[],
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error('canonical replay fingerprints differ from the baseline');
  }
}

function assertNonEventTables(
  expected: InspectionReport['nonEventTables'],
  actual: InspectionReport['nonEventTables'],
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error('non-event table fingerprints differ from the baseline');
  }
}

function appendProgress(runDirectory: string, event: string, details: unknown): void {
  appendFileSync(
    join(runDirectory, PROGRESS_FILENAME),
    `${JSON.stringify({ at: new Date().toISOString(), event, details })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fsyncFile(temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function readRunManifest(runDirectory: string): RunManifest {
  const path = join(runDirectory, MANIFEST_FILENAME);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RunManifest;
  if (
    parsed.format !== 1
    || typeof parsed.runId !== 'string'
    || typeof parsed.releaseVersion !== 'string'
    || typeof parsed.databasePath !== 'string'
    || typeof parsed.backupPath !== 'string'
  ) throw new Error(`invalid run manifest: ${path}`);
  return parsed;
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
}

function resolveExistingDatabase(path: string): string {
  const resolved = resolve(path);
  const metadata = statSync(resolved);
  if (!metadata.isFile()) throw new Error(`database is not a regular file: ${resolved}`);
  return resolved;
}

function assertSameFilesystem(databasePath: string, directory: string): void {
  if (statSync(databasePath).dev !== statSync(directory).dev) {
    throw new Error('database and migration run directory must be on the same filesystem');
  }
}

function availableBytes(path: string): number {
  const stat = statfsSync(path);
  return stat.bavail * stat.bsize;
}

function sha256File(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = readSync(fd, buffer);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function pragmaStrings(db: Db, name: string): string[] {
  return pragmaRows(db, name).map(row => String(Object.values(row)[0] ?? ''));
}

function pragmaRows(db: Db, name: string): Array<Record<string, unknown>> {
  return db.prepare(`PRAGMA ${name}`).all() as Array<Record<string, unknown>>;
}

function scalar(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error('batch size must be an integer between 1 and 10000');
  }
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function migrationRunFiles(runDirectory: string): {
  manifest: string;
  progress: string;
  verification: string;
  vacuum: string;
} {
  return {
    manifest: join(runDirectory, MANIFEST_FILENAME),
    progress: join(runDirectory, PROGRESS_FILENAME),
    verification: join(runDirectory, VERIFY_FILENAME),
    vacuum: join(runDirectory, VACUUM_FILENAME),
  };
}

export function maintenanceLockForDatabase(databasePath: string): string {
  return maintenanceLockPathForDb(databasePath);
}

export function describeRun(manifest: RunManifest): string {
  return `${manifest.runId} (${basename(manifest.databasePath)}, release ${manifest.releaseVersion})`;
}
