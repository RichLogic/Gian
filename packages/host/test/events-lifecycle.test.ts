import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/storage/db.js';
import {
  sweepColdEvents,
  markAccessed,
} from '../src/events/lifecycle.js';
import { ensureEventsRebuilt } from '../src/events/lazy-rebuild.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gian-events-lifecycle-'));
}

interface SeedOptions {
  archived?: 0 | 1;
  createdAt?: string;
  lastAccessedAt?: string | null;
  nativeSessionId?: string | null;
  withEvents?: boolean;
}

function seedSession(
  db: ReturnType<typeof openDatabase>,
  workspaceId: string,
  opts: SeedOptions = {},
): string {
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions
      (id, name, type, workspace_id, executor, model, approval_mode, turns,
       active_channel, status, archived,
       worktree_path, branch, base_branch, worktree_outcome,
       native_session_id, last_accessed_at,
       created_at, updated_at)
     VALUES
      (?, ?, 'coding', ?, 'claude', NULL, 'ask', 1,
       'web', 'idle', ?,
       NULL, NULL, NULL, NULL,
       ?, ?,
       ?, ?)`,
  ).run(
    sessionId,
    `seed-${sessionId.slice(0, 6)}`,
    workspaceId,
    opts.archived ?? 0,
    opts.nativeSessionId ?? `cc_${sessionId}`,
    opts.lastAccessedAt ?? null,
    opts.createdAt ?? now,
    now,
  );

  if (opts.withEvents) {
    const turnId = randomUUID();
    db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES (?, ?, 1, 'completed', ?, ?)`,
    ).run(turnId, sessionId, now, now);
    db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      sessionId,
      turnId,
      randomUUID(),
      'user_message',
      JSON.stringify({ text: 'hi' }),
      now,
    );
  }

  return sessionId;
}

function seedWorkspace(db: ReturnType<typeof openDatabase>, path: string): string {
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(
    wsId,
    'test',
    path,
  );
  return wsId;
}

// ---------------------------------------------------------------------------
// sweepColdEvents
// ---------------------------------------------------------------------------

test('sweepColdEvents evicts events for archived session but keeps the session row', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const wsId = seedWorkspace(db, '/tmp/sweep-archived');

    const sid = seedSession(db, wsId, { archived: 1, withEvents: true });

    const before = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(before.c, 1, 'event seeded');

    const res = sweepColdEvents(db);

    assert.equal(res.sessionsSwept, 1);
    assert.equal(res.eventsDeleted, 1);
    assert.equal(res.turnsDeleted, 1);

    const eventsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    const turnsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?')
      .get(sid) as { c: number };
    const sessRow = db
      .prepare('SELECT id, native_session_id FROM sessions WHERE id = ?')
      .get(sid) as { id: string; native_session_id: string | null } | undefined;

    assert.equal(eventsAfter.c, 0, 'events evicted');
    assert.equal(turnsAfter.c, 0, 'turns evicted');
    assert.ok(sessRow, 'session row preserved');
    assert.ok(sessRow!.native_session_id, 'native_session_id preserved');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepColdEvents leaves active session events untouched', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const wsId = seedWorkspace(db, '/tmp/sweep-active');

    // Active = not archived, created moments ago, no last_accessed_at.
    // The created_at NOW means it's clearly within TTL.
    const sid = seedSession(db, wsId, {
      archived: 0,
      createdAt: new Date().toISOString(),
      withEvents: true,
    });

    const res = sweepColdEvents(db);

    assert.equal(res.sessionsSwept, 0);
    assert.equal(res.eventsDeleted, 0);

    const eventsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(eventsAfter.c, 1, 'active session events kept');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepColdEvents evicts session whose last_accessed_at is older than TTL', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const wsId = seedWorkspace(db, '/tmp/sweep-ttl');

    // Session touched 60 days ago — clearly past the 30-day default TTL.
    const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const sid = seedSession(db, wsId, {
      archived: 0,
      createdAt: oldIso,
      lastAccessedAt: oldIso,
      withEvents: true,
    });

    const res = sweepColdEvents(db);

    assert.equal(res.sessionsSwept, 1);
    assert.equal(res.eventsDeleted, 1);

    const eventsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(eventsAfter.c, 0, 'cold session events swept');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepColdEvents respects ttlDays opt override', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const wsId = seedWorkspace(db, '/tmp/sweep-override');

    // 5 days old. With default TTL=30, this is hot. With ttlDays=1, it's cold.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const sid = seedSession(db, wsId, {
      archived: 0,
      createdAt: fiveDaysAgo,
      lastAccessedAt: fiveDaysAgo,
      withEvents: true,
    });

    const noop = sweepColdEvents(db); // default 30d
    assert.equal(noop.sessionsSwept, 0);

    const aggressive = sweepColdEvents(db, { ttlDays: 1 });
    assert.equal(aggressive.sessionsSwept, 1);

    const eventsAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(eventsAfter.c, 0);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// markAccessed
// ---------------------------------------------------------------------------

test('markAccessed updates last_accessed_at to a recent ISO timestamp', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const wsId = seedWorkspace(db, '/tmp/mark-accessed');
    const sid = seedSession(db, wsId);

    const before = db
      .prepare('SELECT last_accessed_at FROM sessions WHERE id = ?')
      .get(sid) as { last_accessed_at: string | null };
    assert.equal(before.last_accessed_at, null, 'starts null');

    const t0 = Date.now();
    markAccessed(db, sid);
    const t1 = Date.now();

    const after = db
      .prepare('SELECT last_accessed_at FROM sessions WHERE id = ?')
      .get(sid) as { last_accessed_at: string | null };
    assert.ok(after.last_accessed_at, 'populated');
    const ms = Date.parse(after.last_accessed_at!);
    assert.ok(ms >= t0 && ms <= t1, 'within request window');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureEventsRebuilt
// ---------------------------------------------------------------------------

/** Encode a path the way Claude Code does: every `/` becomes `-`. */
function encodeCcProjectDir(absPath: string): string {
  return absPath.replaceAll('/', '-');
}

test('ensureEventsRebuilt replays cc JSONL into events when cache is empty', () => {
  const dir = makeTempDir();
  // Override HOME so os.homedir() inside lazy-rebuild lands in our tmp.
  const originalHome = process.env['HOME'];
  process.env['HOME'] = dir;
  try {
    const db = openDatabase(dir);

    // Workspace path doubles as the cwd that cc encodes into its
    // projects dir. Use a stable subpath to keep the encoded dir short.
    const wsPath = join(dir, 'proj');
    mkdirSync(wsPath, { recursive: true });
    const wsId = seedWorkspace(db, wsPath);

    const nativeId = `cc_${randomUUID()}`;
    const sid = seedSession(db, wsId, {
      nativeSessionId: nativeId,
      // No events yet — simulating a swept cold session.
      withEvents: false,
    });

    // Write a small cc JSONL fixture: 2 user messages → 2 turns.
    const projectDir = join(dir, '.claude', 'projects', encodeCcProjectDir(wsPath));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${nativeId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello world' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hi! How can I help?' }],
        },
      }),
      JSON.stringify({ type: 'user', message: { content: 'second turn' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Sure thing.' }],
        },
      }),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const res = ensureEventsRebuilt(db, sid);

    assert.equal(res.turnsInserted, 2, 'one turn per user message');
    assert.ok(res.eventsInserted >= 2, 'at least one event per turn');

    const eventCount = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.ok(eventCount.c >= 2, 'events table populated');

    const userMsgCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND type = 'user_message'",
      )
      .get(sid) as { c: number };
    assert.equal(
      userMsgCount.c,
      2,
      'user_message events match user lines in JSONL',
    );

    const turnCount = db
      .prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(turnCount.c, 2, 'turns table populated');

    // Idempotency: a second call should be a no-op.
    const second = ensureEventsRebuilt(db, sid);
    assert.equal(second.turnsInserted, 0);
    assert.equal(second.eventsInserted, 0);
    const eventCountAfter = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sid) as { c: number };
    assert.equal(eventCountAfter.c, eventCount.c, 'no duplicate events on rebuild');

    db.close();
  } finally {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureEventsRebuilt is a no-op when JSONL file is missing', () => {
  const dir = makeTempDir();
  const originalHome = process.env['HOME'];
  process.env['HOME'] = dir;
  try {
    const db = openDatabase(dir);
    const wsPath = join(dir, 'proj-missing');
    mkdirSync(wsPath, { recursive: true });
    const wsId = seedWorkspace(db, wsPath);
    const sid = seedSession(db, wsId, {
      nativeSessionId: `cc_${randomUUID()}`,
      withEvents: false,
    });

    const res = ensureEventsRebuilt(db, sid);
    assert.equal(res.turnsInserted, 0);
    assert.equal(res.eventsInserted, 0);

    db.close();
  } finally {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
