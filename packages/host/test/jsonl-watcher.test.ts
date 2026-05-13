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
       (id, name, type, workspace_id, executor, approval_mode, turns,
        active_channel, status, archived, native_session_id, created_at, updated_at)
     VALUES (?, ?, 'coding', ?, 'claude', 'auto', 1, 'web', 'new', 0, ?, ?, ?)`,
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

function ccUserLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
}

function ccAssistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
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
      return n >= 2;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;

    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.type, 'user_message');
    const u = JSON.parse(rows[0]!.data) as { text: string };
    assert.equal(u.text, 'hello from terminal');
    assert.equal(rows[1]!.type, 'output.text');
    const a = JSON.parse(rows[1]!.data) as { text: string };
    assert.equal(a.text, 'hi back');

    // Turn row created at user-message boundary.
    const turnCount = (h.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(h.sessionId) as { n: number }).n;
    assert.equal(turnCount, 1, 'one turn row inserted at user-message boundary');

    // Broadcaster received both events as `event` messages.
    const eventMsgs = h.broadcaster.messages.filter(m => m.type === 'event');
    assert.equal(eventMsgs.length, 2);
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
      return n >= 2;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;
    assert.equal(rows.length, 2, 'only post-resume lines synced');
    const u = JSON.parse(rows[0]!.data) as { text: string };
    assert.equal(u.text, 'external follow-up');
    const a = JSON.parse(rows[1]!.data) as { text: string };
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
         (id, name, type, workspace_id, executor, approval_mode, turns,
          active_channel, status, archived, native_session_id, created_at, updated_at)
       VALUES (?, ?, 'coding', ?, 'claude', 'auto', 1, 'web', 'new', 0, ?, ?, ?)`,
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
      return n1 >= 1 && n2 >= 1;
    });

    const rows1 = h.db
      .prepare(`SELECT data FROM events WHERE session_id = ?`)
      .all(h.sessionId) as Array<{ data: string }>;
    const rows2 = h.db
      .prepare(`SELECT data FROM events WHERE session_id = ?`)
      .all(sessionId2) as Array<{ data: string }>;

    assert.equal(rows1.length, 1);
    assert.equal(rows2.length, 1);
    assert.equal((JSON.parse(rows1[0]!.data) as { text: string }).text, 'to session 1');
    assert.equal((JSON.parse(rows2[0]!.data) as { text: string }).text, 'to session 2');
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
      return n >= 1;
    });

    h.watcher.stop(h.sessionId);

    appendFileSync(h.filePath, ccUserLine('second — after stop'));
    await new Promise(r => setTimeout(r, 300));

    const n = (h.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
      .get(h.sessionId) as { n: number }).n;
    assert.equal(n, 1, 'no events synced after stop');
  } finally {
    h.cleanup();
  }
});

test('codex executor — session_meta header skipped, event_msg lines synced', async () => {
  const h = setupCcHarness();
  try {
    appendFileSync(h.filePath, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-x', cwd: '/tmp/ws' },
    }) + '\n');

    h.watcher.start(h.sessionId, h.filePath, 'codex');
    await new Promise(r => setTimeout(r, WATCH_ATTACH_MS));

    appendFileSync(h.filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex hi' },
    }) + '\n');
    appendFileSync(h.filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'codex reply' },
    }) + '\n');

    await waitFor(() => {
      const n = (h.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
        .get(h.sessionId) as { n: number }).n;
      return n >= 2;
    });

    const rows = h.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC`)
      .all(h.sessionId) as Array<{ type: string; data: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.type, 'user_message');
    assert.equal(rows[1]!.type, 'output.text');
  } finally {
    h.cleanup();
  }
});
