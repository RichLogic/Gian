import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  replayEventSchemaUnion,
  type ReplayEvent,
} from '@gian/proxy-protocol';
import { SessionEventCoordinator } from '../src/session/event-coordinator.js';
import { SessionHistoryStore } from '../src/session/history-store.js';
import { SessionRepository } from '../src/session/repository.js';
import { openDatabase } from '../src/storage/db.js';

function replayTurn(
  sessionId: string,
  replayStreamId: string,
  sourceTurnId: string,
  sequenceStart: number,
  suffix: string,
): ReplayEvent[] {
  const emittedAt = `2026-08-10T01:0${sequenceStart}:00.000Z`;
  const values: unknown[] = [
    { method: 'turn.started', data: {} },
    {
      method: 'input.recorded',
      data: { input: [{ type: 'text', text: `Question ${suffix}` }] },
    },
    {
      method: 'content.completed',
      data: { contentId: `content-${suffix}`, kind: 'text', content: `Answer ${suffix}` },
    },
    { method: 'turn.completed', data: { stopReason: 'completed' } },
  ];
  return values.map((value, index) => {
    const event = value as { method: string; data: Record<string, unknown> };
    return replayEventSchemaUnion.parse({
      method: event.method,
      eventId: `event-${suffix}-${index + 1}`,
      sessionId,
      replayStreamId,
      sequence: sequenceStart + index,
      sourceTurnId,
      emittedAt,
      data: event.data,
    });
  });
}

test('protocol v2 replay ledger is idempotent across refreshes and Host restart', () => {
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
    content.data.content = 'Changed answer';
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
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('incremental replay tracks skipped requested events for resolved mapping (Finding 5)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-proxy-replay-kinds-'));
  try {
    const db = openDatabase(dataDir);
    db.prepare(
      `INSERT INTO sessions
        (id, name, type, executor, approval_mode, status, archived,
         native_session_id, created_at, updated_at)
       VALUES ('session-ix', 'Kinds', 'coding', 'kimi', 'ask', 'new', 0,
               'native-ix', datetime('now'), datetime('now'))`,
    ).run();

    const requestedTurn: ReplayEvent[] = [
      replayEventSchemaUnion.parse({
        method: 'turn.started',
        eventId: 'ix-event-1',
        sessionId: 'session-ix',
        replayStreamId: 'replay-ix',
        sequence: 1,
        sourceTurnId: 'provider-turn-ix',
        emittedAt: '2026-08-30T10:00:00.000Z',
        data: {},
      }),
      replayEventSchemaUnion.parse({
        method: 'interaction.requested',
        eventId: 'ix-event-2',
        sessionId: 'session-ix',
        replayStreamId: 'replay-ix',
        sequence: 2,
        sourceTurnId: 'provider-turn-ix',
        emittedAt: '2026-08-30T10:00:01.000Z',
        data: {
          interactionId: 'ix-1',
          title: 'Read',
          description: 'Requesting approval',
          presentation: { kind: 'permission', tone: 'warning' },
          inputs: [],
          actions: [
            { id: 'approve_once', label: 'Approve once', style: 'primary' },
            { id: 'approve_always', label: 'Approve for this session', style: 'secondary' },
          ],
          context: {
            permissionOptionKinds: {
              approve_once: 'allow_once',
              approve_always: 'allow_always',
            },
          },
        },
      }),
      replayEventSchemaUnion.parse({
        method: 'turn.completed',
        eventId: 'ix-event-3',
        sessionId: 'session-ix',
        replayStreamId: 'replay-ix',
        sequence: 3,
        sourceTurnId: 'provider-turn-ix',
        emittedAt: '2026-08-30T10:00:02.000Z',
        data: { stopReason: 'completed' },
      }),
    ];
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
    const first = makeCoordinator().persistKimiReplay(
      'session-ix',
      requestedTurn,
      '2026-08-30T10:00:00.000Z',
      'replay-ix',
    );
    assert.equal(first.events, 3);

    // Incremental refresh: the requested event is already persisted and must
    // skip projection, but its kind mapping must still be tracked so the NEW
    // resolved event maps to allow_session exactly like the live path would.
    const resolvedEvent = replayEventSchemaUnion.parse({
      method: 'interaction.resolved',
      eventId: 'ix-event-4',
      sessionId: 'session-ix',
      replayStreamId: 'replay-ix',
      sequence: 4,
      sourceTurnId: 'provider-turn-ix',
      emittedAt: '2026-08-30T10:00:03.000Z',
      data: {
        interactionId: 'ix-1',
        outcome: 'submitted',
        actionId: 'approve_always',
      },
    });
    const incremental = makeCoordinator().persistKimiReplay(
      'session-ix',
      [...requestedTurn, resolvedEvent],
      '2026-08-30T10:00:00.000Z',
      'replay-ix',
    );
    assert.equal(incremental.events, 1, 'only the resolved event is new');

    const persisted = db.prepare(
      `SELECT data FROM events
        WHERE session_id = 'session-ix' AND type = 'interaction.resolved'`,
    ).get() as { data: string };
    const stored = JSON.parse(persisted.data) as {
      display?: { data?: { decision?: string } };
    };
    assert.equal(
      stored.display?.data?.decision,
      'allow_session',
      'incremental replay must map through the skipped requested event kinds',
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
