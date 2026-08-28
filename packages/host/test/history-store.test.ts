import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventEnvelope } from '@gian/shared';
import {
  SessionHistoryStore,
  compactHistoryEnvelopes,
} from '../src/session/history-store.js';
import { openDatabase } from '../src/storage/db.js';

test('replaceable snapshots update one persisted event while append events remain a log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','kimi','plan','running',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status)
      VALUES('t1','s1',1,'running');
    `);
    const history = new SessionHistoryStore(db);

    history.appendEvent('s1', 't1', 'tool-1', 'acp.sessionUpdate', { value: 1 }, { replaceSnapshot: true });
    history.appendEvent('s1', 't1', 'tool-1', 'acp.sessionUpdate', { value: 2 }, { replaceSnapshot: true });
    history.appendEvent('s1', 't1', 'text-1', 'output.text.delta', { delta: 'a' });
    history.appendEvent('s1', 't1', 'text-1', 'output.text.delta', { delta: 'b' });

    const rows = db.prepare('SELECT call_id, data FROM events ORDER BY rowid').all() as Array<{
      call_id: string;
      data: string;
    }>;
    assert.equal(rows.length, 3);
    assert.deepEqual(JSON.parse(rows[0]!.data), { value: 2 });
    assert.deepEqual(rows.slice(1).map(row => JSON.parse(row.data)), [{ delta: 'a' }, { delta: 'b' }]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history pages are turn-bounded and compact legacy snapshot floods on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-page-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','kimi','plan','done',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status) VALUES
        ('t1','s1',1,'completed'),
        ('t2','s1',2,'completed'),
        ('t3','s1',3,'completed'),
        ('t4','s1',4,'completed');
    `);
    const history = new SessionHistoryStore(db);
    for (let turn = 1; turn <= 4; turn++) {
      history.appendEvent('s1', `t${turn}`, `user-${turn}`, 'user_message', { text: `turn ${turn}` });
    }
    for (const [callId, diff] of [['random-diff-1', 'old'], ['random-diff-2', 'new']]) {
      history.appendEvent('s1', 't4', callId!, 'diff.updated', {
        __gian_event: 2,
        provider: 'codex',
        raw: { diff },
        display: { type: 'activity.file-change', data: { files: [], diff } },
      });
    }
    history.appendEvent('s1', 't4', 'tool-1', 'acp.sessionUpdate', {
      __gian_event: 2,
      provider: 'kimi',
      raw: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', rawOutput: 'old' } },
      display: { type: 'activity.tool', data: { itemId: 'tool-1', title: 'Tool', status: 'running' } },
    });
    history.appendEvent('s1', 't4', 'tool-1', 'acp.sessionUpdate', {
      __gian_event: 2,
      provider: 'kimi',
      raw: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', rawOutput: 'new' } },
      display: { type: 'activity.tool', data: { itemId: 'tool-1', title: 'Tool', status: 'success' } },
    });
    for (const text of ['hello ', 'world']) {
      history.appendEvent('s1', 't4', 'message-1', 'output.text.delta', {
        __gian_event: 2,
        provider: 'codex',
        raw: { itemId: 'message-1', delta: text },
        display: { type: 'message', data: { itemId: 'message-1', text, delta: true } },
      });
    }

    const newest = history.listEventPage('s1', null, 2);
    assert.equal(newest.hasMore, true);
    assert.equal(newest.nextCursor, 3);
    assert.deepEqual([...new Set(newest.events.map(event => event.turn))], [3, 4]);
    assert.deepEqual(
      newest.events.filter(event => event.event === 'diff.updated')
        .map(event => event.display?.data.diff),
      ['new'],
    );
    assert.deepEqual(
      newest.events.filter(event => event.event === 'acp.sessionUpdate')
        .map(event => event.display?.data.status),
      ['success'],
    );
    assert.deepEqual(
      newest.events.filter(event => event.display?.type === 'message')
        .map(event => event.display?.data.text),
      ['hello world'],
    );

    const older = history.listEventPage('s1', newest.nextCursor, 2);
    assert.equal(older.hasMore, false);
    assert.equal(older.nextCursor, null);
    assert.deepEqual([...new Set(older.events.map(event => event.turn))], [1, 2]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large histories keep each response bounded by whole-turn pagination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-large-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','codex','plan','done',0,0,'native',datetime('now'),datetime('now'));
    `);
    const insertTurn = db.prepare(
      `INSERT INTO turns(id,session_id,turn_number,status,created_at,completed_at)
       VALUES(?, 's1', ?, 'completed', ?, ?)`,
    );
    db.transaction(() => {
      for (let turn = 1; turn <= 1_000; turn++) {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString();
        insertTurn.run(`t${turn}`, turn, timestamp, timestamp);
      }
    })();
    const history = new SessionHistoryStore(db);
    db.transaction(() => {
      for (let turn = 1; turn <= 1_000; turn++) {
        history.appendEvent('s1', `t${turn}`, `user-${turn}`, 'user_message', {
          text: `turn ${turn}`,
        });
      }
    })();

    const newest = history.listEventPage('s1', null);
    assert.deepEqual([...new Set(newest.events.map(event => event.turn))], [998, 999, 1000]);
    assert.equal(newest.hasMore, true);
    assert.equal(newest.nextCursor, 998);
    assert.ok(Buffer.byteLength(JSON.stringify(newest)) < 32 * 1024,
      '1,000 persisted turns must not inflate the default response beyond its three-turn page');

    const older = history.listEventPage('s1', newest.nextCursor);
    assert.deepEqual([...new Set(older.events.map(event => event.turn))], [995, 996, 997]);
    const clamped = history.listEventPage('s1', null, 100);
    assert.equal(new Set(clamped.events.map(event => event.turn)).size, 10,
      'even an oversized requested page is capped at ten complete turns');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get('s1') as { n: number }).n,
      1_000,
      'pagination is a bounded read and does not compact away append-only history');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history treats offset-less SQLite event timestamps as UTC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-timestamp-'));
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','codex','plan','done',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status)
      VALUES('t1','s1',1,'completed');
      INSERT INTO events(id,session_id,turn_id,call_id,type,data,created_at) VALUES
        ('e1','s1','t1','sqlite','user_message','{"text":"sqlite"}','2026-08-08 02:40:12'),
        ('e2','s1','t1','fraction','user_message','{"text":"fraction"}','2026-08-08 02:40:12.345'),
        ('e3','s1','t1','zoned','user_message','{"text":"zoned"}','2026-08-08T02:40:12.500Z'),
        ('e4','s1','t1','offset','user_message','{"text":"offset"}','2026-08-08T10:40:12+08:00');
    `);

    const history = new SessionHistoryStore(db);
    const expected = new Map([
      ['sqlite', Date.UTC(2026, 7, 8, 2, 40, 12)],
      ['fraction', Date.UTC(2026, 7, 8, 2, 40, 12, 345)],
      ['zoned', Date.UTC(2026, 7, 8, 2, 40, 12, 500)],
      ['offset', Date.UTC(2026, 7, 8, 2, 40, 12)],
    ]);
    const allEvents = history.listEvents('s1');
    assert.equal(allEvents.length, expected.size);
    for (const event of allEvents) {
      assert.equal(event.ts, expected.get(event.call_id));
    }
    const page = history.listEventPage('s1', null).events;
    const pageEvents = page.filter(event => expected.has(event.call_id));
    assert.equal(pageEvents.length, expected.size);
    for (const event of pageEvents) {
      assert.equal(event.ts, expected.get(event.call_id));
    }
    assert.equal(
      page.filter(event => event.display?.type === 'state.turn-completed').length,
      1,
      'terminal status synthesizes a boundary even when completed_at is absent',
    );
    db.close();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history pages synthesize one stable completion boundary for legacy terminal turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-terminal-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','kimi','plan','done',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status,created_at,completed_at) VALUES
        ('t1','s1',1,'completed','2026-08-09T01:00:00.000Z',NULL),
        ('t2','s1',2,'stopped','2026-08-09T01:01:00.000Z','2026-08-09T01:01:05.000Z'),
        ('t3','s1',3,'running','2026-08-09T01:02:00.000Z',NULL);
    `);
    const history = new SessionHistoryStore(db);
    history.appendEvent(
      's1',
      't1',
      'thought-1',
      'reasoning',
      { text: 'legacy thought' },
      { createdAt: '2026-08-09T01:00:04.000Z' },
    );
    history.appendEvent(
      's1',
      't1',
      'late-tool',
      'tool.use',
      { input: 'last event' },
      { createdAt: '2026-08-09T01:00:05.000Z' },
    );
    history.appendEvent('s1', 't2', 'provider-turn-2', 'state.turn-completed', {
      __gian_event: 2,
      provider: 'kimi',
      raw: { turnId: 't2' },
      display: { type: 'state.turn-completed', data: { turnId: 't2' } },
    });
    history.appendEvent('s1', 't3', 'thought-3', 'reasoning', { text: 'still live' });
    const persistedBefore = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;

    const first = history.listEventPage('s1', null, 3);
    const second = history.listEventPage('s1', null, 3);
    const completions = first.events.filter(event => event.display?.type === 'state.turn-completed');
    assert.deepEqual(completions.map(event => event.turn), [1, 2]);
    assert.equal(completions.filter(event => event.turn === 1).length, 1);
    assert.equal(completions.filter(event => event.turn === 2).length, 1);
    assert.equal(completions.find(event => event.turn === 1)?.call_id, 'gian:turn-completed:t1');
    assert.equal(completions.find(event => event.turn === 1)?.ts, Date.parse('2026-08-09T01:00:05.000Z'));
    assert.equal(completions.find(event => event.turn === 1)?.display?.data.status, 'completed');
    assert.equal(completions.find(event => event.turn === 2)?.display?.data.status, 'stopped');
    assert.equal(history.hasTurnCompletionBoundary('t2'), true);
    assert.deepEqual(
      second.events.map(event => [event.turn, event.call_id]),
      first.events.map(event => [event.turn, event.call_id]),
      'repeated reads must synthesize the same identities without duplicates',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      persistedBefore,
      'history repair is a read-only projection',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-memory compaction keeps reasoning summary and full streams distinct', () => {
  const fragment = (kind: 'summary' | 'full', text: string, ts: number): EventEnvelope => ({
    session_id: 's1',
    turn: 1,
    call_id: 'shared-reasoning-id',
    event: 'output.reasoning.delta',
    ts,
    data: { delta: text },
    provider: 'codex',
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
  const compacted = compactHistoryEnvelopes([
    fragment('summary', 'summary ', 1),
    fragment('full', 'full ', 2),
    fragment('summary', 'done', 3),
    fragment('full', 'trace', 4),
  ]);
  assert.equal(compacted.length, 2);
  assert.deepEqual(
    compacted.map(event => ({
      kind: event.display?.data.kind,
      text: event.display?.data.text,
    })).sort((left, right) => String(left.kind).localeCompare(String(right.kind))),
    [
      { kind: 'full', text: 'full trace' },
      { kind: 'summary', text: 'summary done' },
    ],
  );
});

test('terminal history canonicalizes duplicate early ends to one final provider boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-history-terminal-order-'));
  try {
    const db = openDatabase(dir);
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
      VALUES('s1','session','primary','w1','codex','plan','done',0,0,'native',datetime('now'),datetime('now'));
      INSERT INTO turns(id,session_id,turn_number,status,created_at,completed_at)
      VALUES('t1','s1',1,'completed','2026-08-09T05:00:00.000Z','2026-08-09T05:00:03.000Z');
    `);
    const history = new SessionHistoryStore(db);
    history.appendEvent('s1', 't1', 'early-provider', 'turn.completed', {
      __gian_event: 2,
      provider: 'codex',
      raw: { summary: 'provider metadata' },
      display: { type: 'state.turn-completed', data: { turnId: 'native-t1', summary: 'kept' } },
    }, { createdAt: '2026-08-09T05:00:03.000Z' });
    history.appendEvent('s1', 't1', 'late-tool', 'tool.output', {
      __gian_event: 2,
      provider: 'codex',
      raw: { output: 'late' },
      display: { type: 'activity.tool', data: { itemId: 'late-tool', title: 'Tool', status: 'success' } },
    }, { createdAt: '2026-08-09T05:00:05.000Z' });
    history.appendEvent('s1', 't1', 'duplicate-gian', 'gian.turn.completed', {
      __gian_event: 2,
      provider: 'codex',
      raw: { turnId: 't1' },
      display: { type: 'state.turn-completed', data: { turnId: 't1' } },
    }, { createdAt: '2026-08-09T05:00:04.000Z' });

    const events = history.listEventPage('s1', null, 1).events;
    assert.deepEqual(events.map(event => event.call_id), ['late-tool', 'early-provider']);
    assert.equal(events[1]?.event, 'turn.completed');
    assert.equal(events[1]?.display?.data.summary, 'kept');
    assert.equal(events[1]?.ts, Date.parse('2026-08-09T05:00:05.000Z'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
