import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EVENT_ARTIFACT_CHUNK_BYTES,
  MAX_STORED_EVENT_BYTES,
  eventStorageMetrics,
  resetEventStorageMetrics,
} from '../src/session/event-store.js';
import { SessionHistoryStore } from '../src/session/history-store.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import {
  hasEventStorageV3,
  installEventStorageV3,
} from '../src/storage/event-storage-v3-schema.js';

function withTestDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gian-event-v3-'));
  try {
    const db = openDatabase(dir);
    assert.equal(hasEventStorageV3(db), false, 'normal database open must not install P0 schema');
    installEventStorageV3(db);
    assert.equal(hasEventStorageV3(db), true);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','codex','plan','running',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status)
      VALUES('t1','s1',1,'running');
    `);
    run(db);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P0 schema is explicit and assigns stable per-session event sequence numbers', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    history.appendEvent('s1', 't1', 'first', 'output.text.delta', { delta: 'a' });
    history.appendEvent('s1', 't1', 'second', 'output.text.delta', { delta: 'b' });

    const rows = db.prepare(
      'SELECT call_id, sequence FROM events WHERE session_id = ? ORDER BY sequence',
    ).all('s1') as Array<{ call_id: string; sequence: number }>;
    assert.deepEqual(rows, [
      { call_id: 'first', sequence: 1 },
      { call_id: 'second', sequence: 2 },
    ]);
    const indexes = db.prepare(`PRAGMA index_list('events')`).all() as Array<{ name: string }>;
    assert.ok(indexes.some(index => index.name === 'idx_events_session_sequence'));
  });
});

test('P0 schema rehearsal backfills a legacy synthetic database without changing event data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-event-rehearsal-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES
        ('s1','one','primary','w1','codex','plan','done',0,0,'native-1',datetime('now'),datetime('now')),
        ('s2','two','primary','w1','codex','plan','done',0,0,'native-2',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status) VALUES
        ('t1','s1',1,'completed'),
        ('t2','s2',1,'completed');
    `);
    const insert = db.prepare(
      `INSERT INTO events(id,session_id,turn_id,call_id,type,data)
       VALUES(?,?,?,?,?,?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 2_000; index++) {
        const session = index % 2 === 0 ? 's1' : 's2';
        insert.run(
          `e${index}`,
          session,
          session === 's1' ? 't1' : 't2',
          `c${index}`,
          'legacy',
          JSON.stringify({ index, text: `event ${index}` }),
        );
      }
    })();
    const before = db.prepare(
      'SELECT COUNT(*) AS n, SUM(length(data)) AS bytes FROM events',
    ).get() as { n: number; bytes: number };

    installEventStorageV3(db);
    installEventStorageV3(db);

    const after = db.prepare(
      'SELECT COUNT(*) AS n, SUM(length(data)) AS bytes FROM events',
    ).get() as { n: number; bytes: number };
    assert.deepEqual(after, before);
    for (const sessionId of ['s1', 's2']) {
      const sequences = db.prepare(
        'SELECT sequence FROM events WHERE session_id = ? ORDER BY sequence',
      ).all(sessionId) as Array<{ sequence: number }>;
      assert.equal(sequences.length, 1_000);
      assert.deepEqual(
        sequences.map(row => row.sequence),
        Array.from({ length: 1_000 }, (_, index) => index + 1),
      );
    }
    const queryPlan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM events WHERE session_id = ? ORDER BY sequence',
    ).all('s1') as Array<{ detail: string }>;
    assert.ok(queryPlan.some(row => row.detail.includes('idx_events_session_sequence')));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hundreds of mutable snapshots keep one row and one lossless large artifact', () => {
  withTestDb(db => {
    resetEventStorageMetrics();
    const history = new SessionHistoryStore(db);
    for (let update = 0; update < 300; update++) {
      const diff = `${'diff --git a/file b/file\n+line\n'.repeat(8_000)}update=${update}`;
      history.appendEvent('s1', 't1', 'turn-diff', 'diff.updated', {
        __gian_event: 2,
        provider: 'codex',
        raw: { diff },
        display: { type: 'activity.file-change', data: { files: [], diff } },
      }, { replaceSnapshot: true });
    }

    const eventRow = db.prepare(
      'SELECT data, sequence FROM events WHERE session_id = ?',
    ).get('s1') as { data: string; sequence: number };
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get('s1') as { n: number }).n,
      1,
    );
    assert.equal(eventRow.sequence, 1, 'updating a snapshot must not consume new sequence numbers');
    assert.ok(Buffer.byteLength(eventRow.data) <= MAX_STORED_EVENT_BYTES);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event_artifacts').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event_artifact_links').get() as { n: number }).n, 2);

    const expected = `${'diff --git a/file b/file\n+line\n'.repeat(8_000)}update=299`;
    const restored = history.listEvents('s1')[0]!;
    assert.equal(restored.data.diff, expected);
    assert.equal(restored.display?.data.diff, expected);
    assert.ok(eventStorageMetrics().externalizedValues >= 300);
  });
});

test('oversized images are chunked outside events and restored without loss', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    const image = `data:image/png;base64,${randomBytes(5 * 1024 * 1024).toString('base64')}`;
    history.appendEvent('s1', 't1', 'image', 'tool.output', {
      __gian_event: 2,
      provider: 'codex',
      raw: { image },
      display: { type: 'activity.tool', data: { itemId: 'image', title: 'Image', status: 'success', output: image } },
    });

    const row = db.prepare('SELECT data FROM events WHERE session_id = ?').get('s1') as { data: string };
    assert.ok(Buffer.byteLength(row.data) <= MAX_STORED_EVENT_BYTES);
    const chunks = db.prepare(
      'SELECT length(data) AS bytes FROM event_artifact_chunks ORDER BY chunk_index',
    ).all() as Array<{ bytes: number }>;
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every(chunk => chunk.bytes <= EVENT_ARTIFACT_CHUNK_BYTES));
    const restored = history.listEvents('s1')[0]!;
    assert.equal(restored.data.image, image);
    assert.equal(restored.display?.data.output, image);
  });
});

test('payload fallback preserves objects made of many individually small values', () => {
  withTestDb(db => {
    resetEventStorageMetrics();
    const history = new SessionHistoryStore(db);
    const payload = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`part${index}`, `${index}:${'x'.repeat(10_000)}`]),
    );
    history.appendEvent('s1', 't1', 'wide', 'diagnostic', payload);

    const row = db.prepare('SELECT data FROM events WHERE session_id = ?').get('s1') as { data: string };
    assert.ok(Buffer.byteLength(row.data) <= MAX_STORED_EVENT_BYTES);
    assert.deepEqual(history.listEvents('s1')[0]!.data, payload);
    assert.equal(eventStorageMetrics().payloadFallbacks, 1);
  });
});

test('paged history does not materialize diagnostic raw artifacts', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    history.appendEvent('s1', 't1', 'tool', 'tool.output', {
      __gian_event: 2,
      provider: 'codex',
      raw: { output: 'diagnostic'.repeat(100_000) },
      display: {
        type: 'activity.tool',
        data: { itemId: 'tool', title: 'Tool', status: 'success' },
      },
    });

    resetEventStorageMetrics();
    assert.equal(history.listEventPage('s1', null).events[0]?.display?.type, 'activity.tool');
    assert.equal(eventStorageMetrics().restoredArtifacts, 0);
    history.listEvents('s1');
    assert.equal(eventStorageMetrics().restoredArtifacts, 1);
  });
});

test('terminal turn compaction merges text deltas into one persisted projection', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    const fragmentCount = 1_205;
    const firstFragmentAt = Date.parse('2026-08-09T02:00:00.000Z');
    for (let index = 0; index < fragmentCount; index++) {
      history.appendEvent('s1', 't1', 'answer', 'output.text.delta', {
        __gian_event: 2,
        provider: 'codex',
        raw: { delta: `${index},` },
        display: {
          type: 'message',
          data: { itemId: 'answer', text: `${index},`, delta: true },
        },
      }, { createdAt: new Date(firstFragmentAt + index).toISOString() });
    }
    const expected = Array.from({ length: fragmentCount }, (_, index) => `${index},`).join('');
    assert.equal(history.compactTurnStreams('t1'), fragmentCount - 1);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE turn_id = ?').get('t1') as { n: number }).n,
      1,
    );
    assert.equal(history.finalAssistantText('t1'), expected);
    const compacted = history.listEventPage('s1', null).events[0];
    assert.equal(compacted?.display?.data.text, expected);
    assert.equal(compacted?.ts, firstFragmentAt, 'compaction retains the stream start timestamp');
  });
});

test('persisted stream compaction keeps reasoning summary and full variants separate', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    const append = (kind: 'summary' | 'full', text: string): void => {
      history.appendEvent('s1', 't1', 'shared-reasoning-id', 'output.reasoning.delta', {
        __gian_event: 2,
        provider: 'codex',
        raw: { delta: text, kind },
        display: {
          type: 'activity.reasoning',
          data: {
            itemId: 'shared-reasoning-id',
            kind,
            text,
            delta: true,
          },
        },
      });
    };
    append('summary', 'summary ');
    append('full', 'full ');
    append('summary', 'done');
    append('full', 'trace');

    assert.deepEqual(history.compactTurnStreamsDetailed('t1'), {
      groups: 2,
      removed: 2,
    });
    const reasoning = history.listEvents('s1').map(event => ({
      kind: event.display?.data.kind,
      text: event.display?.data.text,
    })).sort((left, right) => String(left.kind).localeCompare(String(right.kind)));
    assert.deepEqual(reasoning, [
      { kind: 'full', text: 'full trace' },
      { kind: 'summary', text: 'summary done' },
    ]);
  });
});

test('snapshot compaction deletes oversized groups in bounded batches', () => {
  withTestDb(db => {
    const history = new SessionHistoryStore(db);
    const snapshotCount = 1_205;
    for (let index = 0; index < snapshotCount; index++) {
      history.appendEvent('s1', 't1', `diff-${index}`, 'diff.updated', {
        __gian_event: 2,
        provider: 'codex',
        raw: { diff: `snapshot ${index}` },
        display: {
          type: 'activity.file-change',
          data: { files: [], diff: `snapshot ${index}` },
        },
      });
    }

    assert.deepEqual(history.compactTurnSnapshots('t1'), {
      groups: 1,
      removed: snapshotCount - 1,
    });
    const rows = db.prepare('SELECT call_id FROM events WHERE turn_id = ?').all('t1') as Array<{
      call_id: string;
    }>;
    assert.deepEqual(rows, [{ call_id: 'diff:t1' }]);
    assert.equal(history.listEvents('s1')[0]?.display?.data.diff, `snapshot ${snapshotCount - 1}`);
  });
});
