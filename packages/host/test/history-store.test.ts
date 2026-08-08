import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionHistoryStore } from '../src/session/history-store.js';
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
    const pageEvents = history.listEventPage('s1', null).events;
    assert.equal(pageEvents.length, expected.size);
    for (const event of pageEvents) {
      assert.equal(event.ts, expected.get(event.call_id));
    }
    db.close();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    rmSync(dir, { recursive: true, force: true });
  }
});
