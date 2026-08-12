import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  proxyNotificationSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import { SessionEventCoordinator } from '../src/session/event-coordinator.js';
import { SessionHistoryStore } from '../src/session/history-store.js';
import { SessionRepository } from '../src/session/repository.js';
import { openDatabase } from '../src/storage/db.js';

function replayTurn(
  sessionId: string,
  streamId: string,
  turnId: string,
  sequenceStart: number,
  suffix: string,
): ProxyNotification[] {
  const emittedAt = `2026-08-10T01:0${sequenceStart}:00.000Z`;
  const values: unknown[] = [
    { method: 'turn.started', data: {} },
    {
      method: 'input.recorded',
      data: { inputId: `input-${suffix}`, input: [{ type: 'text', text: `Question ${suffix}` }] },
    },
    {
      method: 'content.completed',
      data: { contentId: `content-${suffix}`, kind: 'text', content: `Answer ${suffix}` },
    },
    { method: 'turn.completed', data: { stopReason: 'completed' } },
  ];
  return values.map((value, index) => {
    const event = value as { method: string; data: Record<string, unknown> };
    return proxyNotificationSchema.parse({
      method: event.method,
      params: {
        eventId: `event-${suffix}-${index + 1}`,
        streamId,
        sequence: sequenceStart + index,
        sessionId,
        turnId,
        emittedAt,
        data: event.data,
      },
    });
  });
}

test('protocol v1 replay ledger is idempotent across refreshes and Host restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-proxy-replay-ledger-'));
  try {
    const db = openDatabase(dataDir);
    db.prepare(
      `INSERT INTO sessions
        (id, name, type, executor, approval_mode, status, archived,
         native_session_id, created_at, updated_at)
       VALUES ('session-1', 'Replay', 'coding', 'claude', 'ask', 'new', 0,
               'native-1', datetime('now'), datetime('now'))`,
    ).run();

    const makeCoordinator = () => new SessionEventCoordinator(
      db,
      new SessionRepository(db),
      new SessionHistoryStore(db),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      { sendMessage: async () => undefined },
    );
    const firstTurn = replayTurn('session-1', 'replay-native-1', 'provider-turn-1', 1, 'one');
    const first = makeCoordinator().persistKimiReplay(
      'session-1',
      firstTurn,
      '2026-08-10T01:00:00.000Z',
      'replay-native-1',
    );
    assert.deepEqual(first, { turns: 1, events: 4 });

    const duplicate = makeCoordinator().persistKimiReplay(
      'session-1',
      firstTurn,
      '2026-08-10T01:00:00.000Z',
      'replay-native-1',
    );
    assert.deepEqual(duplicate, { turns: 0, events: 0 });

    const secondTurn = replayTurn('session-1', 'replay-native-1', 'provider-turn-2', 5, 'two');
    const appended = makeCoordinator().persistKimiReplay(
      'session-1',
      [...firstTurn, ...secondTurn],
      '2026-08-10T01:01:00.000Z',
      'replay-native-1',
    );
    assert.deepEqual(appended, { turns: 1, events: 4 });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM turns').get() as { count: number }).count,
      2,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      8,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events').get() as { count: number }).count,
      8,
    );

    const changed = structuredClone(firstTurn);
    const content = changed[2]!;
    if (content.method !== 'content.completed') assert.fail('expected content event');
    content.params.data.content = 'Changed answer';
    assert.throws(
      () => makeCoordinator().persistKimiReplay(
        'session-1',
        changed,
        '2026-08-10T01:00:00.000Z',
        'replay-native-1',
      ),
      /changed after persistence/,
    );

    const rewritten = replayTurn(
      'session-1',
      'replay-native-2',
      'provider-turn-rewritten',
      1,
      'rewritten',
    );
    const rebuilt = makeCoordinator().persistKimiReplay(
      'session-1',
      rewritten,
      '2026-08-10T01:02:00.000Z',
      'replay-native-2',
    );
    assert.deepEqual(rebuilt, { turns: 1, events: 4 });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM turns').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events').get() as { count: number }).count,
      4,
    );
    assert.equal(
      (db.prepare(
        'SELECT replay_stream_id FROM proxy_replay_streams WHERE session_id = ?',
      ).get('session-1') as { replay_stream_id: string }).replay_stream_id,
      'replay-native-2',
    );
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a replay stream revision rebuilds only replay-owned turns', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-proxy-replay-revision-'));
  try {
    const db = openDatabase(dataDir);
    db.prepare(
      `INSERT INTO sessions
        (id, name, type, executor, approval_mode, status, archived,
         native_session_id, created_at, updated_at)
       VALUES ('session-1', 'Replay', 'coding', 'claude', 'ask', 'new', 0,
               'native-1', datetime('now'), datetime('now'))`,
    ).run();
    const coordinator = new SessionEventCoordinator(
      db,
      new SessionRepository(db),
      new SessionHistoryStore(db),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      { sendMessage: async () => undefined },
    );
    const first = replayTurn('session-1', 'replay-1', 'provider-turn-1', 1, 'one');
    coordinator.persistKimiReplay(
      'session-1',
      first,
      '2026-08-10T01:00:00.000Z',
      'replay-1',
    );
    const oldReplayTurn = db.prepare(
      `SELECT turn_id FROM proxy_replay_turns
       WHERE session_id = 'session-1' AND provider_turn_id = 'provider-turn-1'`,
    ).get() as { turn_id: string };

    db.prepare(
      `INSERT INTO turns
        (id, session_id, turn_number, status, created_at, completed_at)
       VALUES ('host-live-turn', 'session-1', 2, 'completed', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO proxy_replay_turns
        (session_id, provider_turn_id, turn_id, replay_owned)
       VALUES ('session-1', 'host-live-turn', 'host-live-turn', 0)`,
    ).run();

    const revised = replayTurn('session-1', 'replay-2', 'provider-turn-2', 1, 'two');
    assert.deepEqual(coordinator.persistKimiReplay(
      'session-1',
      revised,
      '2026-08-10T02:00:00.000Z',
      'replay-2',
    ), { turns: 1, events: 4 });

    assert.equal(
      db.prepare('SELECT 1 FROM turns WHERE id = ?').get(oldReplayTurn.turn_id),
      undefined,
    );
    assert.ok(db.prepare("SELECT 1 FROM turns WHERE id = 'host-live-turn'").get());
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM turns').get() as { count: number }).count,
      2,
    );
    assert.deepEqual(
      db.prepare(
        `SELECT replay_stream_id FROM proxy_replay_streams WHERE session_id = 'session-1'`,
      ).get(),
      { replay_stream_id: 'replay-2' },
    );
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
