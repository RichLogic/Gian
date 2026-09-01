import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildReplayEvents } from '../src/adapter.js';
import { SessionProjector, type OuterNotification } from '../src/events.js';
import { startHarness, type Harness } from './harness.js';

const PERMISSION_TURN = {
  turnId: 'turn_perm',
  permissionRequest: { requestId: 'perm-42', toolName: 'Bash', command: 'echo hi', riskLevel: 'high' },
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_perm_start' },
    { seq: 1, eventId: 'evt_perm_term', payload: { kind: 'turn_completed', resultType: 'success' } },
  ],
};

async function initialize(harness: Harness): Promise<Record<string, unknown>> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result');
  return (response.payload as { result: Record<string, unknown> }).result;
}

async function beginTurn(harness: Harness): Promise<string> {
  const created = await harness.request('session.create', {
    sessionId: 's_1',
    workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
    config: {},
  });
  assert.equal(created.kind, 'result');
  const snapshot = await harness.request('session.get', { sessionId: 's_1' });
  const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
  const accepted = await harness.request('turn.start', {
    sessionId: 's_1', streamId, turnId: 't_1',
    input: [{ type: 'text', text: 'run it' }], config: {},
  });
  assert.equal(accepted.kind, 'result');
  return streamId;
}

test('permission request round-trips the EXACT native response payload', async () => {
  const harness = startHarness({ scenario: { turn: PERMISSION_TURN } });
  try {
    await initialize(harness);
    const streamId = await beginTurn(harness);

    const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const data = (requested.payload.params as { data: Record<string, unknown> }).data;
    const actions = data.actions as Array<{ id: string; label: string; style: string }>;
    const optionIds = actions.map((action) => action.id);
    assert.deepEqual(optionIds, ['allow_once', 'allow_project', 'deny'], 'native options are preserved verbatim');
    assert.equal(data.presentation && (data.presentation as { kind: string }).kind, 'permission');
    const interactionId = data.interactionId as string;
    assert.ok(actions.every((action) => action.style === 'primary' || action.style === 'secondary' || action.style === 'danger'));

    // Respond with allow_project: the proxy must send back the EXACT native
    // response payload, permissionUpdates included (§11.1, D7).
    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-1', interactionId, actionId: 'allow_project', values: {},
    });
    assert.equal(responded.kind, 'result', JSON.stringify(responded.payload));

    // The fake logs the answer when the line ARRIVES, which can race the
    // resolved notification; poll briefly instead of assuming ordering.
    let answer: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && answer === undefined; i += 1) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
      answer = harness.fakeLog().find((entry) => entry.kind === 'reverse-answer'
        && (entry.result as { decision?: string } | undefined)?.decision !== undefined);
    }
    assert.ok(answer, 'proxy answered the permission reverse request');
    const payload = answer!.result as { decision: string; reason?: string; permissionUpdates?: unknown };
    assert.equal(payload.decision, 'allow');
    assert.ok(Array.isArray(payload.permissionUpdates), 'permissionUpdates round-trip intact');
    assert.deepEqual(payload.permissionUpdates, [
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] },
    ]);

    // interaction.resolved(submitted) arrives AFTER the respond result.
    const resolved = await harness.waitNotificationFor((line) => line.method === 'interaction.resolved');
    assert.equal(resolved.method, 'interaction.resolved');
    const resolvedData = (resolved.payload.params as { data: Record<string, unknown> }).data;
    assert.equal(resolvedData.outcome, 'submitted');
    assert.equal(resolvedData.actionId, 'allow_project');
  } finally {
    await harness.close();
  }
});

test('unknown action and foreign interaction respond with typed errors', async () => {
  const harness = startHarness({ scenario: { turn: PERMISSION_TURN } });
  try {
    await initialize(harness);
    const streamId = await beginTurn(harness);
    const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const interactionId = ((requested.payload.params as { data: { interactionId: string } }).data.interactionId);

    const unknown = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-bad', interactionId, actionId: 'not-offered', values: {},
    });
    assert.equal(
      ((unknown.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INTERACTION_ACTION_NOT_FOUND',
    );

    const foreign = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-f1', interactionId: 'int:missing', actionId: 'allow_once', values: {},
    });
    assert.equal(
      ((foreign.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INTERACTION_NOT_FOUND',
    );
  } finally {
    await harness.close();
  }
});

test('duplicate responseId replays the first result; same id + new action CONFLICTs', async () => {
  const harness = startHarness({ scenario: { turn: PERMISSION_TURN } });
  try {
    await initialize(harness);
    const streamId = await beginTurn(harness);
    const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const interactionId = ((requested.payload.params as { data: { interactionId: string } }).data.interactionId);

    const first = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-dup', interactionId, actionId: 'deny', values: {},
    });
    assert.equal(first.kind, 'result');

    const replay = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-dup', interactionId, actionId: 'deny', values: {},
    });
    assert.equal(replay.kind, 'result', 'identical replay returns the first result');

    const conflict = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_1',
      responseId: 'resp-dup', interactionId, actionId: 'allow_once', values: {},
    });
    assert.equal(
      ((conflict.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFLICT',
    );
  } finally {
    await harness.close();
  }
});

test('diagnostic interaction disable fails closed', async () => {
  const harness = startHarness({ scenario: {}, interactionEnabled: false });
  try {
    const response = await initialize(harness);
    const capabilities = response.capabilities as Record<string, number>;
    assert.equal(capabilities['interaction'], undefined, 'explicit diagnostic disable removes the capability');
    const responded = await harness.request('interaction.respond', {
      sessionId: 's_x', streamId: 'st', turnId: 't',
      responseId: 'r', interactionId: 'i', actionId: 'a', values: {},
    });
    assert.equal(
      ((responded.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CAPABILITY_NOT_SUPPORTED',
    );
  } finally {
    await harness.close();
  }
});

test('replay projects messages into canonical events with continuous sequence', async () => {
  const harness = startHarness({
    scenario: {
      knownSessions: ['sess_known_1'],
      messages: [
        {
          info: { role: 'user', id: 'msg_u1', anchor: { turnId: 'turn_r1' }, time: { created: 1_700_000_000_000 } },
          parts: [{ type: 'text', id: 'part_u1', text: 'please run echo' }],
        },
        {
          info: {
            role: 'assistant', id: 'msg_a1', finish: 'stop', modelID: 'GLM-5.3-Flash',
            anchor: { turnId: 'turn_r1' }, time: { created: 1_700_000_000_500 },
            tokens: { total: 55, input: 50, output: 5, cache: { read: 20, write: 0 } },
          },
          parts: [
            { type: 'step-start', id: 'part_s0' },
            { type: 'reasoning', id: 'part_r1', text: 'thinking' },
            {
              type: 'tool', id: 'part_t1', callID: 'call_r1', tool: 'Bash',
              state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi', time: { end: 1_700_000_001_000 } },
            },
            { type: 'text', id: 'part_x1', text: 'done: ' },
            { type: 'text', id: 'part_x2', text: 'hi' },
          ],
        },
      ],
    },
  });
  try {
    await initialize(harness);
    await harness.request('session.create', {
      sessionId: 's_1', nativeSession: { id: 'sess_known_1', history: 'replay' },
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
    });
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);

    const page1 = await harness.request('session.replay', { sessionId: 's_1', streamId, cursor: null, limit: 3 });
    assert.equal(page1.kind, 'result', JSON.stringify(page1.payload));
    const result1 = (page1.payload as { result: Record<string, unknown> }).result;
    const replayStreamId = result1.replayStreamId as string;
    const events1 = result1.events as Array<Record<string, unknown>>;
    assert.equal(events1.length, 3);
    assert.deepEqual(events1.map((event) => event.sequence), [1, 2, 3]);

    const page2 = await harness.request('session.replay', { sessionId: 's_1', streamId, cursor: result1.nextCursor, limit: 50 });
    const result2 = (page2.payload as { result: Record<string, unknown> }).result;
    const events2 = result2.events as Array<Record<string, unknown>>;
    assert.equal(result2.replayStreamId, replayStreamId, 'replayStreamId fixed across pages');
    assert.equal(events2[0]!.sequence, 4, 'sequence continuous across pages');
    assert.equal(result2.nextCursor, null);

    const all = [...events1, ...events2];
    const methods = all.map((event) => event.method);
    assert.equal(methods[0], 'turn.started');
    assert.ok(methods.includes('input.recorded'), 'external user input recorded');
    assert.ok(methods.includes('activity.updated'), 'tool parts become activities');
    const activity = all.find((event) => event.method === 'activity.updated')!;
    assert.equal((activity.data as { presentation: { type: string } }).presentation.type, 'tool');
    assert.ok(methods.includes('usage.updated'));
    const terminal = all.at(-1)!;
    assert.equal(terminal.method, 'turn.completed');

    // Every event carries the stable native sourceTurnId.
    assert.ok(all.every((event) => event.sourceTurnId === 'turn_r1'));
    // Event ids are stable across a second fetch.
    const refetch = await harness.request('session.replay', { sessionId: 's_1', streamId, cursor: null, limit: 100 });
    const refetchEvents = ((refetch.payload as { result: { events: Array<Record<string, unknown>> } }).result.events);
    assert.deepEqual(refetchEvents.map((event) => event.eventId), all.map((event) => event.eventId));
  } finally {
    await harness.close();
  }
});

test('live and replay terminal facts have the same event identity', () => {
  const emitted: OuterNotification[] = [];
  let sequence = 0;
  const projector = new SessionProjector({
    gianSessionId: 's_live',
    nativeSessionId: 'sess_identity',
    nextSequence: () => ++sequence,
    emit: notification => emitted.push(notification),
  });
  projector.setStreamId('stream_live');
  projector.bindTurn('turn_outer', 'turn_native_identity');
  projector.handleNotification('session/event', {
    sessionId: 'sess_identity',
    seq: 7,
    eventId: 'evt_native_terminal',
    type: 'turn.completed',
    payload: { resultType: 'success' },
  });
  const liveTerminal = emitted.find(notification => notification.method === 'turn.completed');
  assert.ok(liveTerminal);

  const replay = buildReplayEvents({
    gianSessionId: 's_replay',
    nativeSessionId: 'sess_identity',
    replayStreamId: 'replay_stream',
    messages: [{
      info: {
        role: 'assistant',
        id: 'msg_identity',
        anchor: { turnId: 'turn_native_identity' },
        finish: 'stop',
        time: { created: 1_700_000_000_000 },
      },
      parts: [{ type: 'text', id: 'part_identity', text: 'done' }],
    }],
  });
  const replayTerminal = replay.find(event => event.method === 'turn.completed');
  assert.ok(replayTerminal);
  assert.equal(replayTerminal.eventId, liveTerminal.params.eventId);
});

test('repeated Desktop permission requests emit one interaction fact', () => {
  const emitted: OuterNotification[] = [];
  let sequence = 0;
  const projector = new SessionProjector({
    gianSessionId: 's_permission_retry',
    nativeSessionId: 'sess_permission_retry',
    nextSequence: () => ++sequence,
    emit: notification => emitted.push(notification),
  });
  projector.setStreamId('stream_permission_retry');
  projector.bindTurn('turn_outer', 'turn_native');
  const request = {
    requestId: 'permission-retry-1',
    nativeTurnId: 'turn_native',
    toolName: 'Bash',
    options: [{
      optionId: 'allow_once',
      kind: 'allow_once',
      name: 'Allow once',
      response: { decision: 'allow' },
    }],
    raw: {},
  };
  assert.equal(projector.handlePermissionRequest(request), true);
  assert.equal(projector.handlePermissionRequest(request), true);
  assert.equal(
    emitted.filter(notification => notification.method === 'interaction.requested').length,
    1,
  );
  assert.equal(sequence, 1);
});

test('Desktop turn-started payload captures the optional v4 foreground guard', () => {
  const projector = new SessionProjector({
    gianSessionId: 's_foreground',
    nativeSessionId: 'sess_foreground',
    nextSequence: () => 1,
    emit: () => undefined,
  });
  projector.setStreamId('stream_foreground');
  projector.bindTurn('turn_outer', 'turn_native');
  projector.handleNotification('session/event', {
    sessionId: 'sess_foreground',
    seq: 1,
    eventId: 'evt_foreground',
    type: 'turn.started',
    payload: {
      foregroundExecutionId: 'foreground_execution_1',
      input: 'run',
      turnNumber: 0,
    },
  });
  assert.equal(projector.activeForegroundExecutionId(), 'foreground_execution_1');
});
