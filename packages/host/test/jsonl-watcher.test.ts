import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { NativeJsonlWatcher } from '../src/native/watcher.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() {
    return 0;
  }
}

/** Sleep until predicate returns true or budget elapses. Useful because
 *  fs.watch fires asynchronously through the event loop and our debounce
 *  adds another ~100 ms. */
async function waitFor(
  pred: () => boolean,
  { timeoutMs = 3000, stepMs = 25 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function displayData(json: string): Record<string, unknown> {
  const stored = JSON.parse(json) as { display?: { data?: Record<string, unknown> } };
  return stored.display?.data ?? {};
}

/** macOS fs.watch needs a tick or two after watch() to start delivering
 *  events. Tests append immediately after start so we wait a moment to
 *  avoid racing the FSEvents subscription. */
const WATCH_ATTACH_MS = 80;

interface Harness {
  dir: string;
  db: ReturnType<typeof openDatabase>;
  broadcaster: CapturingBroadcaster;
  watcher: NativeJsonlWatcher;
  sessionId: string;
  filePath: string;
  cleanup: () => void;
}

function setupCcHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gian-watcher-test-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const watcher = new NativeJsonlWatcher(db, broadcaster as unknown as WsBroadcaster);

  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(
    wsId, 'ws', '/tmp/ws',
  );
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  // Migration set added: insert a complete session row with required cols.
  db.prepare(
    `INSERT INTO sessions
       (id, name, type, workspace_id, executor, approval_mode,
        active_channel, status, archived, native_session_id, created_at, updated_at)
     VALUES (?, ?, 'coding', ?, 'claude', 'auto', 'web', 'new', 0, ?, ?, ?)`,
  ).run(sessionId, 'test', wsId, sessionId, now, now);

  const filePath = join(dir, `${sessionId}.jsonl`);
  // Create empty file so fs.watch can attach.
  writeFileSync(filePath, '');

  return {
    dir,
    db,
    broadcaster,
    watcher,
    sessionId,
    filePath,
    cleanup: () => {
      watcher.stopAll();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ccUserLine(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: text },
    ...(timestamp ? { timestamp } : {}),
  }) + '\n';
}

function ccAssistantTextLine(
  text: string,
  options: { timestamp?: string; stopReason?: string; isSidechain?: boolean } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      ...(options.stopReason ? { stop_reason: options.stopReason } : {}),
    },
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.isSidechain === true ? { isSidechain: true } : {}),
  }) + '\n';
}

function codexEventLine(payload: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload,
    ...(timestamp ? { timestamp } : {}),
  }) + '\n';
}

function ccTurnDurationLine(timestamp: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 8_000,
    timestamp,
  }) + '\n';
}

function ccAssistantQuestionLine(toolUseId = 'toolu-question'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question: '晚饭想吃什么？',
            header: '晚饭',
            multiSelect: false,
            options: [
              { label: '中餐', description: '米饭、面条、炒菜之类。' },
              { label: '西餐', description: '意面、牛排、披萨之类。' },
            ],
          }],
        },
      }],
    },
  }) + '\n';
}

function ccQuestionResultLine(toolUseId = 'toolu-question'): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Your questions have been answered: "晚饭想吃什么？"="中餐".',
      }],
    },
    toolUseResult: {
      questions: [{
        question: '晚饭想吃什么？',
        header: '晚饭',
        multiSelect: false,
        options: [
          { label: '中餐', description: '米饭、面条、炒菜之类。' },
          { label: '西餐', description: '意面、牛排、披萨之类。' },
        ],
      }],
      answers: { '晚饭想吃什么？': '中餐' },
    },
  }) + '\n';
}

test('appends one user + one assistant line → events persisted + broadcast', async () => {
  const h = setupCcHarness();
  try {
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccUserLine('hello from terminal'));
    appendFileSync(h.filePath, ccAssistantTextLine('hi back'));

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 3;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;

    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.type, 'gian.turn.started');
    assert.equal(rows[1]!.type, 'user_message');
    const u = JSON.parse(rows[1]!.data) as { text: string };
    assert.equal(u.text, 'hello from terminal');
    assert.equal(rows[2]!.type, 'output.text');
    const a = displayData(rows[2]!.data) as { text: string };
    assert.equal(a.text, 'hi back');

    // Turn row created at user-message boundary.
    const turn = h.db
      .prepare('SELECT status, completed_at FROM turns WHERE session_id = ?')
      .get(h.sessionId) as { status: string; completed_at: string | null };
    assert.equal(turn.status, 'running');
    assert.equal(turn.completed_at, null, 'latest turn stays open without an explicit terminal');
    const session = h.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(h.sessionId) as { status: string };
    assert.equal(session.status, 'running');
    assert.ok(h.broadcaster.messages.some(message => (
      message.type === 'session:updated' && message.session.status === 'running'
    )));

    // Broadcaster received the lifecycle boundary and both content events.
    const eventMsgs = h.broadcaster.messages.filter(m => m.type === 'event');
    assert.equal(eventMsgs.length, 3);
    assert.equal(eventMsgs[0]!.display?.type, 'state.turn-started');
  } finally {
    h.cleanup();
  }
});

test('claude turn_duration explicitly completes the current turn', async () => {
  const h = setupCcHarness();
  try {
    const startedAt = '2026-08-09T00:30:00.000Z';
    const completedAt = '2026-08-09T00:30:08.000Z';
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccUserLine('finish explicitly', startedAt));
    appendFileSync(h.filePath, ccAssistantTextLine('done', {
      timestamp: '2026-08-09T00:30:07.000Z',
      stopReason: 'end_turn',
    }));

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 3;
    });
    const beforeDuration = h.db
      .prepare('SELECT status, completed_at FROM turns WHERE session_id = ?')
      .get(h.sessionId) as { status: string; completed_at: string | null };
    assert.deepEqual(beforeDuration, { status: 'running', completed_at: null });

    appendFileSync(h.filePath, ccTurnDurationLine(completedAt));
    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 4;
    });

    const types = (h.db
      .prepare('SELECT type FROM events WHERE session_id = ? ORDER BY rowid ASC')
      .all(h.sessionId) as Array<{ type: string }>).map(row => row.type);
    assert.deepEqual(types, [
      'gian.turn.started',
      'user_message',
      'output.text',
      'gian.turn.completed',
    ]);
    const turn = h.db
      .prepare('SELECT status, created_at, completed_at FROM turns WHERE session_id = ?')
      .get(h.sessionId) as {
        status: string;
        created_at: string;
        completed_at: string | null;
      };
    assert.deepEqual(turn, {
      status: 'completed',
      created_at: startedAt,
      completed_at: completedAt,
    });
    const session = h.db
      .prepare('SELECT status, unread FROM sessions WHERE id = ?')
      .get(h.sessionId) as { status: string; unread: number };
    assert.deepEqual(session, { status: 'done', unread: 1 });
    assert.ok(h.broadcaster.messages.some(message => (
      message.type === 'session:updated'
      && message.session.status === 'done'
      && message.session.unread === 1
    )));
  } finally {
    h.cleanup();
  }
});

test('restart repairs a running DB turn from the bounded native EOF terminal', () => {
  const h = setupCcHarness();
  try {
    const turnId = randomUUID();
    const startedAt = '2026-08-09T00:40:00.000Z';
    const completedAt = '2026-08-09T00:40:09.000Z';
    h.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES (?, ?, 1, 'running', ?, NULL)`,
    ).run(turnId, h.sessionId, startedAt);
    h.db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(h.sessionId);
    writeFileSync(
      h.filePath,
      ccUserLine('already mirrored', startedAt)
      + ccAssistantTextLine('already mirrored reply')
      + ccTurnDurationLine(completedAt),
    );

    h.watcher.start(h.sessionId, h.filePath, 'claude');

    const turn = h.db
      .prepare('SELECT status, completed_at FROM turns WHERE id = ?')
      .get(turnId) as { status: string; completed_at: string | null };
    assert.deepEqual(turn, { status: 'completed', completed_at: completedAt });
    const rows = h.db
      .prepare('SELECT type, created_at FROM events WHERE turn_id = ? ORDER BY rowid')
      .all(turnId) as Array<{ type: string; created_at: string }>;
    assert.deepEqual(rows, [{ type: 'gian.turn.completed', created_at: completedAt }]);
    assert.equal(
      h.broadcaster.messages.filter(message => message.type === 'event').length,
      1,
      'bounded recovery adds only the missing boundary and never replays the tail',
    );
  } finally {
    h.cleanup();
  }
});

test('terminal DB row without lifecycle preserves completion time and adds only its boundary', async () => {
  const h = setupCcHarness();
  try {
    const turnId = randomUUID();
    const completedAt = '2026-08-09T00:50:03.000Z';
    h.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES (?, ?, 1, 'completed', '2026-08-09T00:50:00.000Z', ?)`,
    ).run(turnId, h.sessionId, completedAt);
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccTurnDurationLine('2026-08-09T00:50:30.000Z'));
    await waitFor(() => (
      h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE turn_id = ?')
        .get(turnId) as { n: number }
    ).n === 1);

    const turn = h.db
      .prepare('SELECT status, completed_at FROM turns WHERE id = ?')
      .get(turnId) as { status: string; completed_at: string | null };
    assert.deepEqual(turn, { status: 'completed', completed_at: completedAt });
    const boundary = h.db
      .prepare('SELECT type, created_at FROM events WHERE turn_id = ?')
      .get(turnId) as { type: string; created_at: string };
    assert.deepEqual(boundary, { type: 'gian.turn.completed', created_at: completedAt });
  } finally {
    h.cleanup();
  }
});

test('next user boundary completes the prior turn before starting the next one', async () => {
  const h = setupCcHarness();
  try {
    const firstStartedAt = '2026-08-09T01:00:00.000Z';
    const secondStartedAt = '2026-08-09T01:00:10.000Z';
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccUserLine('first turn', firstStartedAt));
    appendFileSync(h.filePath, ccAssistantTextLine('first reply'));
    appendFileSync(h.filePath, ccUserLine('second turn', secondStartedAt));
    appendFileSync(h.filePath, ccAssistantTextLine('second reply'));

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 7;
    });

    const rows = h.db
      .prepare(
        `SELECT turn_id, type, data, created_at
         FROM events
         WHERE session_id = ?
         ORDER BY rowid ASC`,
      )
      .all(h.sessionId) as Array<{
        turn_id: string;
        type: string;
        data: string;
        created_at: string;
      }>;
    assert.deepEqual(rows.map(row => row.type), [
      'gian.turn.started',
      'user_message',
      'output.text',
      'gian.turn.completed',
      'gian.turn.started',
      'user_message',
      'output.text',
    ]);
    assert.equal(rows[0]!.turn_id, rows[3]!.turn_id);
    assert.notEqual(rows[3]!.turn_id, rows[4]!.turn_id);
    assert.equal(displayData(rows[3]!.data).turnId, rows[3]!.turn_id);
    assert.equal(rows[3]!.created_at, secondStartedAt);

    const turns = h.db
      .prepare(
        `SELECT turn_number, status, created_at, completed_at
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_number ASC`,
      )
      .all(h.sessionId) as Array<{
        turn_number: number;
        status: string;
        created_at: string;
        completed_at: string | null;
      }>;
    assert.deepEqual(turns, [
      {
        turn_number: 1,
        status: 'completed',
        created_at: firstStartedAt,
        completed_at: secondStartedAt,
      },
      {
        turn_number: 2,
        status: 'running',
        created_at: secondStartedAt,
        completed_at: null,
      },
    ]);

    const lifecycle = h.broadcaster.messages
      .filter(m => m.type === 'event')
      .map(m => m.display?.type)
      .filter(type => type === 'state.turn-started' || type === 'state.turn-completed');
    assert.deepEqual(lifecycle, [
      'state.turn-started',
      'state.turn-completed',
      'state.turn-started',
    ]);
  } finally {
    h.cleanup();
  }
});

test('existing completed lifecycle is neither persisted nor broadcast twice', async () => {
  const h = setupCcHarness();
  try {
    const turnId = randomUUID();
    const now = new Date().toISOString();
    h.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
         VALUES (?, ?, 1, 'completed', ?, ?)`,
      )
      .run(turnId, h.sessionId, now, now);
    h.db
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
         VALUES (?, ?, ?, ?, 'gian.turn.completed', ?, ?)`,
      )
      .run(
        randomUUID(),
        h.sessionId,
        turnId,
        randomUUID(),
        JSON.stringify({
          __gian_event: 2,
          provider: 'claude',
          raw: { turnId, status: 'completed' },
          display: { type: 'state.turn-completed', data: { turnId } },
        }),
        now,
      );

    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));
    appendFileSync(
      h.filePath,
      ccUserLine('new external turn', '2026-08-09T02:00:00.000Z'),
    );

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 3;
    });

    const completedCount = (h.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM events
         WHERE session_id = ? AND turn_id = ? AND type = 'gian.turn.completed'`,
      )
      .get(h.sessionId, turnId) as { n: number }).n;
    assert.equal(completedCount, 1);
    const turns = h.db
      .prepare(
        `SELECT turn_number, status, completed_at
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_number ASC`,
      )
      .all(h.sessionId) as Array<{
        turn_number: number;
        status: string;
        completed_at: string | null;
      }>;
    assert.deepEqual(turns, [
      { turn_number: 1, status: 'completed', completed_at: now },
      { turn_number: 2, status: 'running', completed_at: null },
    ]);
    const broadcastCompleted = h.broadcaster.messages.filter(
      m => m.type === 'event' && m.display?.type === 'state.turn-completed',
    );
    assert.equal(broadcastCompleted.length, 0);
  } finally {
    h.cleanup();
  }
});

test('restart completes the anchored running turn at the next user boundary', async () => {
  const h = setupCcHarness();
  try {
    const turnId = randomUUID();
    const startedAt = '2026-08-09T03:00:00.000Z';
    const nextUserAt = '2026-08-09T03:00:12.000Z';
    h.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
         VALUES (?, ?, 1, 'running', ?, NULL)`,
      )
      .run(turnId, h.sessionId, startedAt);
    h.db
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
         VALUES (?, ?, ?, ?, 'gian.turn.started', ?, ?)`,
      )
      .run(
        randomUUID(),
        h.sessionId,
        turnId,
        `gian:${turnId}:started`,
        JSON.stringify({
          __gian_event: 2,
          provider: 'claude',
          raw: { turnId, status: 'running' },
          display: { type: 'state.turn-started', data: { turnId } },
        }),
        startedAt,
      );

    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));
    appendFileSync(h.filePath, ccUserLine('turn after restart', nextUserAt));

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 4;
    });

    const turns = h.db
      .prepare(
        `SELECT id, turn_number, status, created_at, completed_at
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_number ASC`,
      )
      .all(h.sessionId) as Array<{
        id: string;
        turn_number: number;
        status: string;
        created_at: string;
        completed_at: string | null;
      }>;
    assert.deepEqual(turns.map(turn => ({
      turn_number: turn.turn_number,
      status: turn.status,
      created_at: turn.created_at,
      completed_at: turn.completed_at,
    })), [
      {
        turn_number: 1,
        status: 'completed',
        created_at: startedAt,
        completed_at: nextUserAt,
      },
      {
        turn_number: 2,
        status: 'running',
        created_at: nextUserAt,
        completed_at: null,
      },
    ]);

    const lifecycle = h.broadcaster.messages
      .filter(m => m.type === 'event')
      .map(m => ({ turn: m.turn, type: m.display?.type }));
    assert.deepEqual(lifecycle.slice(0, 2), [
      { turn: 1, type: 'state.turn-completed' },
      { turn: 2, type: 'state.turn-started' },
    ]);
  } finally {
    h.cleanup();
  }
});

test('pause suppresses sync; resume advances offset to skip proxy-written bytes', async () => {
  const h = setupCcHarness();
  try {
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    // Simulate "proxy turn in flight": pause, then proxy writes to JSONL.
    h.watcher.pause(h.sessionId);
    appendFileSync(h.filePath, ccUserLine('written by proxy — should not appear'));
    appendFileSync(h.filePath, ccAssistantTextLine('proxy reply — should not appear'));

    // Give fs.watch a moment to attempt firing; nothing should sync.
    await new Promise(r => setTimeout(r, 250));
    const n0 = (h.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
      .get(h.sessionId) as { n: number }).n;
    assert.equal(n0, 0, 'paused watcher must not insert events');

    // Proxy turn ends → host advances watcher offset to current EOF.
    h.watcher.resume(h.sessionId);

    // External CLI now writes another turn — this one should sync.
    appendFileSync(h.filePath, ccUserLine('external follow-up'));
    appendFileSync(h.filePath, ccAssistantTextLine('external response'));

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 3;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;
    assert.equal(rows.length, 3, 'only post-resume lifecycle + lines synced');
    assert.equal(rows[0]!.type, 'gian.turn.started');
    const u = JSON.parse(rows[1]!.data) as { text: string };
    assert.equal(u.text, 'external follow-up');
    const a = displayData(rows[2]!.data) as { text: string };
    assert.equal(a.text, 'external response');
  } finally {
    h.cleanup();
  }
});

test('two sessions watched independently — neither cross-contaminates', async () => {
  const h = setupCcHarness();
  try {
    // Set up a second session + JSONL inside the same harness.
    const wsId = randomUUID();
    h.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(
      wsId, 'ws2', '/tmp/ws2',
    );
    const sessionId2 = randomUUID();
    const now = new Date().toISOString();
    h.db.prepare(
      `INSERT INTO sessions
         (id, name, type, workspace_id, executor, approval_mode,
          active_channel, status, archived, native_session_id, created_at, updated_at)
       VALUES (?, ?, 'coding', ?, 'claude', 'auto', 'web', 'new', 0, ?, ?, ?)`,
    ).run(sessionId2, 'two', wsId, sessionId2, now, now);
    const filePath2 = join(h.dir, `${sessionId2}.jsonl`);
    writeFileSync(filePath2, '');

    h.watcher.start(h.sessionId, h.filePath, 'claude');
    h.watcher.start(sessionId2, filePath2, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccUserLine('to session 1'));
    appendFileSync(filePath2, ccUserLine('to session 2'));

    await waitFor(() => {
      const n1 = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      const n2 = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(sessionId2) as { n: number }).n;
      return n1 >= 2 && n2 >= 2;
    });

    const rows1 = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;
    const rows2 = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(sessionId2) as Array<{ type: string; data: string }>;

    assert.deepEqual(rows1.map(row => row.type), ['gian.turn.started', 'user_message']);
    assert.deepEqual(rows2.map(row => row.type), ['gian.turn.started', 'user_message']);
    assert.equal((JSON.parse(rows1[1]!.data) as { text: string }).text, 'to session 1');
    assert.equal((JSON.parse(rows2[1]!.data) as { text: string }).text, 'to session 2');
  } finally {
    h.cleanup();
  }
});

test('stop() halts further syncing for that session', async () => {
  const h = setupCcHarness();
  try {
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));
    appendFileSync(h.filePath, ccUserLine('first'));
    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 2;
    });

    h.watcher.stop(h.sessionId);

    appendFileSync(h.filePath, ccUserLine('second — after stop'));
    await new Promise(r => setTimeout(r, 300));

    const n = (h.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
      .get(h.sessionId) as { n: number }).n;
    assert.equal(n, 2, 'no events synced after stop');
  } finally {
    h.cleanup();
  }
});

test('claude AskUserQuestion tool_use is mirrored as a question approval card and resolved by tool_result', async () => {
  const h = setupCcHarness();
  try {
    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccUserLine('测试一下，你问我一个问题'));
    appendFileSync(h.filePath, ccAssistantQuestionLine());
    appendFileSync(h.filePath, ccQuestionResultLine());

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 4;
    });

    const rows = h.db
      .prepare(`SELECT type, call_id, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; call_id: string; data: string }>;

    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.type, 'gian.turn.started');
    assert.equal(rows[1]!.type, 'user_message');
    assert.equal(rows[2]!.type, 'approval.requested');
    assert.equal(rows[2]!.call_id, 'toolu-question');
    const question = displayData(rows[2]!.data) as {
      approvalId: string;
      category: string;
      questions?: Array<{ question: string; options: Array<{ label: string }> }>;
    };
    assert.equal(question.approvalId, 'toolu-question');
    assert.equal(question.category, 'question');
    assert.equal(question.questions?.[0]?.question, '晚饭想吃什么？');
    assert.equal(question.questions?.[0]?.options[0]?.label, '中餐');

    assert.equal(rows[3]!.type, 'approval.resolved');
    assert.equal(rows[3]!.call_id, 'toolu-question');
    const resolved = displayData(rows[3]!.data) as {
      approvalId: string;
      decision: string;
      auto: boolean;
    };
    assert.equal(resolved.approvalId, 'toolu-question');
    assert.equal(resolved.decision, 'allow_once');
    assert.equal(resolved.auto, false);

    const session = h.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(h.sessionId) as { status: string };
    assert.equal(session.status, 'running');
  } finally {
    h.cleanup();
  }
});

test('claude AskUserQuestion appended after watcher restart is attached to latest turn', async () => {
  const h = setupCcHarness();
  try {
    const turnId = randomUUID();
    const now = new Date().toISOString();
    h.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
         VALUES (?, ?, 1, 'completed', ?, ?)`,
      )
      .run(turnId, h.sessionId, now, now);
    h.db
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
         VALUES (?, ?, ?, ?, 'user_message', ?, ?)`,
      )
      .run(randomUUID(), h.sessionId, turnId, randomUUID(), JSON.stringify({ text: '测试一下，你问我一个问题' }), now);
    writeFileSync(h.filePath, ccUserLine('测试一下，你问我一个问题'));

    h.watcher.start(h.sessionId, h.filePath, 'claude');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, ccAssistantQuestionLine('toolu-after-restart'));

    await waitFor(() => {
      const n = (h.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'approval.requested'")
        .get(h.sessionId) as { n: number }).n;
      return n >= 1;
    });

    const row = h.db
      .prepare(
        `SELECT e.turn_id, e.call_id, e.type, e.data, s.status
         FROM events e
         INNER JOIN sessions s ON s.id = e.session_id
         WHERE e.session_id = ? AND e.type = 'approval.requested'
         ORDER BY e.rowid DESC
         LIMIT 1`,
      )
      .get(h.sessionId) as { turn_id: string; call_id: string; type: string; data: string; status: string };
    assert.equal(row.turn_id, turnId);
    assert.equal(row.call_id, 'toolu-after-restart');
    assert.equal(row.status, 'pending');
    const question = displayData(row.data) as { category: string; questions?: Array<{ question: string }> };
    assert.equal(question.category, 'question');
    assert.equal(question.questions?.[0]?.question, '晚饭想吃什么？');
  } finally {
    h.cleanup();
  }
});

test('codex executor — session_meta header skipped, event_msg lines synced', async () => {
  const h = setupCcHarness();
  try {
    const startedAt = '2026-08-09T04:00:00.000Z';
    const completedAt = '2026-08-09T04:00:09.000Z';
    appendFileSync(h.filePath, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-x', cwd: '/tmp/ws' },
    }) + '\n');

    h.watcher.start(h.sessionId, h.filePath, 'codex');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(
      h.filePath,
      codexEventLine({ type: 'user_message', message: 'codex hi' }, startedAt),
    );
    appendFileSync(
      h.filePath,
      codexEventLine({ type: 'agent_message', message: 'codex reply' }),
    );
    appendFileSync(
      h.filePath,
      codexEventLine({ type: 'task_complete', turn_id: 'native-turn-1' }, completedAt),
    );

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 4;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.type, 'gian.turn.started');
    assert.equal(rows[1]!.type, 'user_message');
    assert.equal(rows[2]!.type, 'codex.event_msg.agent_message');
    assert.equal(rows[3]!.type, 'gian.turn.completed');
    const turn = h.db
      .prepare('SELECT status, created_at, completed_at FROM turns WHERE session_id = ?')
      .get(h.sessionId) as {
        status: string;
        created_at: string;
        completed_at: string | null;
      };
    assert.deepEqual(turn, {
      status: 'completed',
      created_at: startedAt,
      completed_at: completedAt,
    });
  } finally {
    h.cleanup();
  }
});
