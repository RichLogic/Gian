import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { EventStore } from '../src/session/event-store.js';
import { SessionHistoryStore } from '../src/session/history-store.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import {
  inspectEventStorageV3,
  migrateEventStorageV3,
  rollbackEventStorageV3,
  SimulatedMigrationInterruption,
  vacuumEventStorageV3,
  verifyEventStorageV3,
} from '../src/storage/event-storage-v3-migrator.js';
import {
  hasEventStorageV3Schema,
  installEventStorageV3Schema,
  isEventStorageV3Active,
  readEventStorageV3Meta,
} from '../src/storage/event-storage-v3-schema.js';
import {
  acquireMaintenanceLock,
  assertNoEventStorageMaintenance,
} from '../src/storage/maintenance-lock.js';

const RELEASE_VERSION = '0.3.0';

interface Fixture {
  root: string;
  dataDir: string;
  databasePath: string;
  reportPath: string;
  backupDirectory: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gian-v3-migrator-'));
  const dataDir = join(root, 'data');
  const backupDirectory = join(dataDir, 'migrations');
  mkdirSync(backupDirectory, { recursive: true });
  const db = openDatabase(dataDir);
  db.exec(`
    INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
    VALUES('w1','workspace','/tmp/workspace',0,0,datetime('now'),datetime('now'));
    INSERT INTO sessions(
      id,name,type,workspace_id,executor,approval_mode,status,archived,unread,
      native_session_id,created_at,updated_at
    ) VALUES
      ('kimi-session','kimi','primary','w1','kimi','default','done',0,0,'kimi-native',datetime('now'),datetime('now')),
      ('codex-session','codex','primary','w1','codex','plan','done',0,0,'codex-native',datetime('now'),datetime('now'));
    INSERT INTO turns(id,session_id,turn_number,status,completed_at) VALUES
      ('kimi-turn','kimi-session',1,'completed',datetime('now')),
      ('codex-turn','codex-session',1,'completed',datetime('now')),
      ('codex-turn-2','codex-session',2,'stopped',datetime('now'));
  `);
  db.close();
  return {
    root,
    dataDir,
    databasePath: join(dataDir, 'gian.db'),
    reportPath: join(root, 'inspect.json'),
    backupDirectory,
  };
}

function insertMigrationFixture(db: Db): void {
  const insert = db.prepare(`
    INSERT INTO events(id,session_id,turn_id,call_id,type,data,created_at)
    VALUES(?,?,?,?,?,?,datetime('now'))
  `);
  db.transaction(() => {
    for (let index = 0; index < 300; index++) {
      insert.run(
        `kimi-${index}`,
        'kimi-session',
        'kimi-turn',
        `legacy-random-${index}`,
        'acp.sessionUpdate',
        JSON.stringify({
          __gian_event: 2,
          provider: 'kimi',
          raw: {
            update: {
              sessionUpdate: index === 0 ? 'tool_call' : 'tool_call_update',
              toolCallId: 'tool-one',
              output: `snapshot-${index}`,
            },
          },
          display: {
            type: 'activity.tool',
            data: {
              itemId: 'tool-one',
              title: 'Tool',
              status: index === 299 ? 'success' : 'running',
              output: `snapshot-${index}`,
            },
          },
        }),
      );
      insert.run(
        `diff-${index}`,
        'codex-session',
        'codex-turn',
        `random-diff-${index}`,
        'diff.updated',
        JSON.stringify({
          __gian_event: 2,
          provider: 'codex',
          raw: { diff: `diff-${index}` },
          display: {
            type: 'activity.file-change',
            data: { itemId: `random-${index}`, files: ['a.ts'], diff: `diff-${index}` },
          },
        }),
      );
      insert.run(
        `text-${index}`,
        'codex-session',
        'codex-turn',
        'answer',
        'output.text.delta',
        JSON.stringify({
          __gian_event: 2,
          provider: 'codex',
          raw: { delta: `${index},` },
          display: {
            type: 'message',
            data: { itemId: 'answer', role: 'assistant', text: `${index},`, delta: true },
          },
        }),
      );
    }
    insert.run(
      'other-turn-tool',
      'codex-session',
      'codex-turn-2',
      'tool-one',
      'tool.output',
      JSON.stringify({
        __gian_event: 2,
        provider: 'codex',
        raw: { output: 'other turn' },
        display: {
          type: 'activity.tool',
          data: { itemId: 'tool-one', title: 'Tool', status: 'success', output: 'other turn' },
        },
      }),
    );
    const sharedLargeValue = 'large-output\n'.repeat(3_000);
    insert.run(
      'large-event',
      'codex-session',
      'codex-turn-2',
      'large',
      'tool.output',
      JSON.stringify({
        __gian_event: 2,
        provider: 'codex',
        raw: { output: sharedLargeValue },
        display: {
          type: 'activity.tool',
          data: { itemId: 'large', title: 'Large', status: 'success', output: sharedLargeValue },
        },
      }),
    );
  })();
}

test('runtime stays legacy until explicit event-storage metadata is active', () => {
  const fixture = createFixture();
  try {
    const db = new Database(fixture.databasePath);
    installEventStorageV3Schema(db);
    assert.equal(hasEventStorageV3Schema(db), true);
    assert.equal(isEventStorageV3Active(db), false);
    assert.equal(new EventStore(db).usesSequence, false);
    assert.equal(new EventStore(db, { mode: 'migration' }).usesSequence, true);
    db.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('maintenance lock blocks Host startup until its owner releases it', () => {
  const fixture = createFixture();
  try {
    const lock = acquireMaintenanceLock({
      databasePath: fixture.databasePath,
      runId: 'lock-test',
      releaseVersion: RELEASE_VERSION,
      command: 'migrate',
    });
    assert.throws(
      () => assertNoEventStorageMaintenance(fixture.dataDir),
      /data is under event-storage maintenance by run lock-test/,
    );
    lock.release();
    assert.doesNotThrow(() => assertNoEventStorageMaintenance(fixture.dataDir));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('offline migration is backup-first, lossless, compacting, verifiable, vacuumable, and rollbackable', async () => {
  const fixture = createFixture();
  try {
    const db = new Database(fixture.databasePath);
    insertMigrationFixture(db);
    const baselineRows = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    db.close();

    const inspection = await inspectEventStorageV3({
      databasePath: fixture.databasePath,
      reportPath: fixture.reportPath,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    assert.equal(inspection.counts.events, baselineRows);
    assert.equal(inspection.compactionEstimate.snapshotRowsRemovable, 598);
    assert.ok(inspection.compactionEstimate.streamRowsRemovable >= 299);

    const manifest = await migrateEventStorageV3({
      databasePath: fixture.databasePath,
      backupDirectory: fixture.backupDirectory,
      confirmationToken: inspection.confirmationToken,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
      batchSize: 37,
    });
    assert.equal(existsSync(manifest.backupPath), true);
    const migrated = new Database(fixture.databasePath);
    assert.equal(isEventStorageV3Active(migrated), true);
    assert.equal(
      (migrated.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'acp.sessionUpdate'`).get() as { n: number }).n,
      1,
    );
    assert.equal(
      (migrated.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'diff.updated'`).get() as { n: number }).n,
      1,
    );
    assert.equal(
      (migrated.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'output.text.delta'`).get() as { n: number }).n,
      1,
    );
    assert.equal(
      (migrated.prepare(`SELECT call_id FROM events WHERE type = 'diff.updated'`).get() as { call_id: string }).call_id,
      'diff:codex-turn',
    );
    const history = new SessionHistoryStore(migrated);
    const expectedText = Array.from({ length: 300 }, (_, index) => `${index},`).join('');
    assert.equal(history.finalAssistantText('codex-turn'), expectedText);
    const large = history.listEvents('codex-session').find(event => event.call_id === 'large');
    assert.equal(large?.data.output, 'large-output\n'.repeat(3_000));
    assert.equal(large?.display?.data.output, 'large-output\n'.repeat(3_000));
    assert.equal(
      (migrated.prepare('SELECT COUNT(*) AS n FROM event_artifacts').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (migrated.prepare('SELECT COUNT(*) AS n FROM event_artifact_links').get() as { n: number }).n,
      2,
    );
    migrated.close();

    const verified = await verifyEventStorageV3({
      databasePath: fixture.databasePath,
      runDirectory: manifest.runDirectory,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    assert.equal(verified.replayFingerprintsMatch, true);
    assert.equal(verified.redundantCanonicalRows, 0);
    const vacuumed = await vacuumEventStorageV3({
      databasePath: fixture.databasePath,
      runDirectory: manifest.runDirectory,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    assert.ok(vacuumed.afterBytes <= vacuumed.beforeBytes);

    const failedMigratedPath = await rollbackEventStorageV3({
      databasePath: fixture.databasePath,
      runDirectory: manifest.runDirectory,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    assert.equal(existsSync(failedMigratedPath), true);
    const restored = new Database(fixture.databasePath, { readonly: true });
    assert.equal(hasEventStorageV3Schema(restored), false);
    assert.equal(
      (restored.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      baselineRows,
    );
    restored.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('interrupted bounded backfill remains inactive and resumes without duplicate sequence values', async () => {
  const fixture = createFixture();
  try {
    const db = new Database(fixture.databasePath);
    const insert = db.prepare(`
      INSERT INTO events(id,session_id,turn_id,call_id,type,data)
      VALUES(?,?,?,?,?,?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 1_200; index++) {
        insert.run(
          `event-${index}`,
          index % 2 === 0 ? 'kimi-session' : 'codex-session',
          index % 2 === 0 ? 'kimi-turn' : 'codex-turn',
          `call-${index}`,
          'diagnostic',
          JSON.stringify({ index }),
        );
      }
    })();
    db.close();
    const inspection = await inspectEventStorageV3({
      databasePath: fixture.databasePath,
      reportPath: fixture.reportPath,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    await assert.rejects(
      migrateEventStorageV3({
        databasePath: fixture.databasePath,
        backupDirectory: fixture.backupDirectory,
        confirmationToken: inspection.confirmationToken,
        releaseVersion: RELEASE_VERSION,
        healthUrl: null,
        batchSize: 100,
        interruptAfterBatches: 2,
        keepLockOnFailure: false,
      }),
      SimulatedMigrationInterruption,
    );
    const interrupted = new Database(fixture.databasePath);
    const meta = readEventStorageV3Meta(interrupted);
    assert.equal(meta?.state, 'failed');
    assert.equal(isEventStorageV3Active(interrupted), false);
    assert.equal(new EventStore(interrupted).usesSequence, false);
    interrupted.close();

    const manifest = await migrateEventStorageV3({
      databasePath: fixture.databasePath,
      backupDirectory: fixture.backupDirectory,
      releaseVersion: RELEASE_VERSION,
      resumeRunId: meta!.run_id,
      healthUrl: null,
      batchSize: 113,
    });
    assert.equal(manifest.runId, meta!.run_id);
    const resumed = new Database(fixture.databasePath);
    assert.equal(isEventStorageV3Active(resumed), true);
    assert.equal(
      (resumed.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT session_id, sequence FROM events GROUP BY session_id, sequence HAVING COUNT(*) > 1
        )
      `).get() as { n: number }).n,
      0,
    );
    assert.equal(
      (resumed.prepare('SELECT COUNT(*) AS n FROM events WHERE sequence IS NULL').get() as { n: number }).n,
      0,
    );
    resumed.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('malformed JSON and a mismatched confirmation token stop before schema mutation', async () => {
  const wrongTokenFixture = createFixture();
  try {
    const inspection = await inspectEventStorageV3({
      databasePath: wrongTokenFixture.databasePath,
      reportPath: wrongTokenFixture.reportPath,
      releaseVersion: RELEASE_VERSION,
      healthUrl: null,
    });
    await assert.rejects(
      migrateEventStorageV3({
        databasePath: wrongTokenFixture.databasePath,
        backupDirectory: wrongTokenFixture.backupDirectory,
        confirmationToken: `${inspection.confirmationToken}-wrong`,
        releaseVersion: RELEASE_VERSION,
        healthUrl: null,
        keepLockOnFailure: false,
      }),
      /confirmation token does not match/,
    );
    const db = new Database(wrongTokenFixture.databasePath, { readonly: true });
    assert.equal(hasEventStorageV3Schema(db), false);
    db.close();
  } finally {
    rmSync(wrongTokenFixture.root, { recursive: true, force: true });
  }

  const malformedFixture = createFixture();
  try {
    const db = new Database(malformedFixture.databasePath);
    db.prepare(`
      INSERT INTO events(id,session_id,turn_id,call_id,type,data)
      VALUES('bad','codex-session','codex-turn','bad','unknown','{not-json')
    `).run();
    db.close();
    await assert.rejects(
      inspectEventStorageV3({
        databasePath: malformedFixture.databasePath,
        reportPath: malformedFixture.reportPath,
        releaseVersion: RELEASE_VERSION,
        healthUrl: null,
      }),
      /invalid JSON/,
    );
    const readonly = new Database(malformedFixture.databasePath, { readonly: true });
    assert.equal(hasEventStorageV3Schema(readonly), false);
    readonly.close();
  } finally {
    rmSync(malformedFixture.root, { recursive: true, force: true });
  }
});
