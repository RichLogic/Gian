import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness } from './harness.js';

const TURN_SCRIPT = {
  turnId: 'turn_native_1',
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_turn_started', sequenceNumber: 1 },
    { seq: 1, eventId: 'evt_ts', payload: { kind: 'text_start', assistantMessageId: 'msg_1' } },
    { seq: 2, eventId: 'evt_td1', payload: { kind: 'text_delta', assistantMessageId: 'msg_1', delta: 'Hello' } },
    { seq: 3, eventId: 'evt_td2', payload: { kind: 'text_delta', assistantMessageId: 'msg_1', delta: ' world' } },
    { seq: 4, eventId: 'evt_te', payload: { kind: 'text_end', assistantMessageId: 'msg_1' } },
    { seq: 5, eventId: 'evt_tool_run', payload: { kind: 'tool_call', toolCallId: 'call_1', tool: 'Bash', status: 'running', input: { command: 'echo hi' } } },
    { seq: 6, eventId: 'evt_tool_done', payload: { kind: 'result', toolCallId: 'call_1', result: { success: true, content: 'hi' } } },
    { seq: 7, eventId: 'evt_msg_done', payload: { stopReason: 'stop', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, totalTokens: 110 } } },
    { seq: 8, eventId: 'evt_terminal', payload: { resultType: 'success', usage: { inputTokens: 100, outputTokens: 10 }, duration: 5 } },
  ],
};

async function initialize(harness: Harness): Promise<void> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result');
}

async function createSession(harness: Harness, sessionId = 's_1'): Promise<void> {
  const created = await harness.request('session.create', {
    sessionId,
    workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
    config: {},
  });
  assert.equal(created.kind, 'result', `session.create failed: ${JSON.stringify(created.payload)}`);
}

test('turn lifecycle: response barrier, subscription, sequence, projection, single terminal', async () => {
  const harness = startHarness({ scenario: { behavior: { requireSubscribe: true }, turn: TURN_SCRIPT } });
  try {
    await initialize(harness);
    await createSession(harness);

    const accepted = await harness.request('turn.start', {
      sessionId: 's_1',
      streamId: (await harness.request('session.get', { sessionId: 's_1' })).kind === 'result'
        ? (((await harness.request('session.get', { sessionId: 's_1' })).payload as { result: { session: { streamId: string } } }).result.session.streamId)
        : '',
      turnId: 't_1',
      input: [{ type: 'text', text: 'say hi' }],
      config: {},
    });
    assert.equal(accepted.kind, 'result');
    assert.equal(((accepted.payload as { result: { accepted: boolean } }).result.accepted), true);

    const notifications = await harness.waitNotifications(10);
    const methods = notifications.map((line) => line.method);
    // turn.started present exactly once; content deltas + completed; tool ->
    // activity.updated only (no step/request fakes); exactly one terminal.
    assert.equal(methods.filter((method) => method === 'turn.started').length, 1, 'one turn.started');
    assert.equal(methods.includes('step.updated'), false, 'no synthetic steps');
    assert.equal(methods.includes('request.updated'), false, 'no synthetic requests');
    const activities = notifications.filter((line) => line.method === 'activity.updated');
    assert.ok(activities.length >= 2, 'tool running + terminal activities');
    const toolStates = activities
      .filter(line => (
        (line.payload.params as { data: { activityId: string } }).data.activityId === 'call_1'
      ))
      .map(line => (line.payload.params as { data: { status: string } }).data.status);
    assert.deepEqual(toolStates, ['running', 'succeeded'], 'Desktop result frame closes the tool successfully');
    const terminalTool = activities.find(line => (
      (line.payload.params as { data: { status: string } }).data.status === 'succeeded'
    ));
    assert.equal(
      ((terminalTool?.payload.params as {
        data: { presentation: { data: { name: string } } };
      }).data.presentation.data.name),
      'Bash',
      'result frame retains the tool identity from the running activity',
    );
    const completed = notifications.filter((line) => line.method === 'turn.completed');
    assert.equal(completed.length, 1, 'exactly one terminal');
    const failed = notifications.filter((line) => line.method === 'turn.failed');
    assert.equal(failed.length, 0);

    // Outer sequence continuity 1..N on this session stream.
    const sequences = notifications.map((line) => (line.payload.params as { sequence: number }).sequence);
    const expected = Array.from({ length: sequences.length }, (_, index) => index + 1);
    assert.deepEqual(sequences, expected, 'outer sequence is consecutive from 1');

    // content.completed carries the accumulated text.
    const contentCompleted = notifications.find((line) => line.method === 'content.completed');
    assert.equal(
      ((contentCompleted!.payload.params as { data: { content: string } }).data.content),
      'Hello world',
    );

    // Terminal stopReason for observed success.
    assert.equal(((completed[0]?.payload.params as { data: { stopReason: string } }).data.stopReason), 'completed');
    const subscriptions = harness.fakeLog().filter((entry) => entry.method === 'session/subscribe');
    assert.equal(subscriptions.length, 1, 'inner session subscribed exactly once');
    const subscriptionParams = subscriptions[0]?.params as Record<string, unknown>;
    assert.equal(subscriptionParams.deliveryKind, 'desktop-continuous');
    assert.equal(subscriptionParams.includeSnapshot, true);
    assert.match(String(subscriptionParams.sessionId), /^sess_/);
  } finally {
    await harness.close();
  }
});

test('Desktop event order preserves terminal identity, fallback text, and hides network diagnostics', async () => {
  const sharedTerminalId = 'evt_desktop_terminal';
  const harness = startHarness({
    scenario: {
      turn: {
        turnId: 'turn_desktop_shape',
        events: [
          { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_desktop_started' },
          {
            seq: 1,
            eventId: 'evt_iteration',
            type: 'session.updated',
            payload: { iteration: 1, messageCount: 2, model: 'glm-5.3-flash' },
          },
          {
            seq: 2,
            eventId: 'evt_network_started',
            type: 'model_request_started',
            payload: {
              type: 'model_request_started',
              baseURL: 'https://example.invalid',
              requestId: 'private-request-id',
              requestHeaders: { authorization: 'Bearer must-not-project' },
            },
          },
          {
            seq: 3,
            eventId: 'evt_message_completed',
            type: 'session.updated',
            payload: {
              content: 'DESKTOP_FALLBACK_OK',
              stopReason: 'stop',
              usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
            },
          },
          { channel: 'computer-use', kind: 'turn-completed', eventId: sharedTerminalId },
          {
            seq: 4,
            eventId: sharedTerminalId,
            type: 'turn.completed',
            payload: {
              response: 'DESKTOP_FALLBACK_OK',
              resultType: 'success',
              usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
            },
          },
        ],
      },
    },
  });
  try {
    await initialize(harness);
    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_desktop_shape',
      input: [{ type: 'text', text: 'desktop shape' }], config: {},
    });

    const notifications = await harness.waitNotifications(6);
    assert.deepEqual(
      notifications.map((line) => line.method),
      ['turn.started', 'content.delta', 'content.completed', 'usage.updated', 'usage.updated', 'turn.completed'],
    );
    const completed = notifications.find((line) => line.method === 'content.completed');
    assert.equal(
      ((completed?.payload.params as { data: { content: string } }).data.content),
      'DESKTOP_FALLBACK_OK',
    );
    assert.equal(
      notifications.some((line) => JSON.stringify(line.payload).includes('must-not-project')),
      false,
      'provider request diagnostics never reach the outer stream',
    );
    assert.equal(
      notifications.filter((line) => line.method === 'turn.completed').length,
      1,
      'the richer terminal survives the preceding typed event with the same eventId',
    );
  } finally {
    await harness.close();
  }
});

test('interrupt maps to interrupted only when the native terminal agrees', async () => {
  const cancelledScript = {
    turnId: 'turn_native_cancel',
    events: [
      { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_cu_start' },
      {
        seq: 1,
        eventId: 'evt_turn_started_payload',
        type: 'turn.started',
        payload: {
          foregroundExecutionId: 'foreground_cancel_1',
          input: 'long task',
          turnNumber: 0,
        },
      },
      { seq: 2, eventId: 'evt_text', payload: { kind: 'text_delta', assistantMessageId: 'msg_c', delta: 'partial' } },
      { op: 'wait', ms: 400 },
      { seq: 3, eventId: 'evt_term_c', payload: { resultType: 'cancelled' } },
    ],
  };
  const harness = startHarness({ scenario: { turn: cancelledScript } });
  try {
    await initialize(harness);
    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_int',
      input: [{ type: 'text', text: 'long task' }], config: {},
    });
    const interrupted = await harness.request('turn.interrupt', {
      sessionId: 's_1', streamId, turnId: 't_int',
    });
    assert.equal(interrupted.kind, 'result');
    const notifications = await harness.waitNotifications(4);
    const terminal = notifications.find((line) => line.method === 'turn.completed');
    assert.ok(terminal, 'turn reached terminal');
    assert.equal(
      ((terminal?.payload.params as { data: { stopReason: string } }).data.stopReason),
      'interrupted',
      'accepted interrupt + cancelled native -> interrupted',
    );
    const stopCalls = harness.fakeLog().filter((entry) => entry.method === 'v4/command');
    assert.equal(stopCalls.length, 1, 'one v4 stop command sent');
    const stopParams = stopCalls[0]?.params as Record<string, unknown>;
    assert.equal(stopParams.type, 'stop');
    assert.equal(typeof stopParams.issuedAt, 'number');
    assert.deepEqual(
      stopParams.payload,
      {},
      'immediate interrupts remain valid before the optional foreground guard arrives',
    );
  } finally {
    await harness.close();
  }
});

test('provider business stderr failure terminates the active turn and releases the session', async () => {
  const harness = startHarness({
    scenario: {
      turn: {
        turnId: 'turn_provider_rejected',
        providerBusinessError: { code: '1113' },
      },
    },
  });
  try {
    await initialize(harness);
    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_provider_rejected',
      input: [{ type: 'text', text: 'real provider failure fixture' }], config: {},
    });
    assert.equal(accepted.kind, 'result');

    const notifications = await harness.waitNotifications(2);
    assert.deepEqual(
      notifications.map((line) => line.method),
      ['turn.started', 'turn.failed'],
    );
    const failure = (notifications[1]!.payload.params as {
      data: { error: { domainCode: string; message: string; retryable: boolean; details: { providerCode: string } } };
    }).data.error;
    assert.equal(failure.domainCode, 'RUNTIME_ERROR');
    assert.equal(failure.retryable, false);
    assert.equal(failure.details.providerCode, '1113');
    assert.match(failure.message, /no available resource package/);

    const idle = await harness.request('session.get', { sessionId: 's_1' });
    assert.equal(
      ((idle.payload as { result: { session: { state: string } } }).result.session.state),
      'idle',
    );
    const closed = await harness.request('session.close', { sessionId: 's_1', streamId });
    assert.equal(closed.kind, 'result');
  } finally {
    await harness.close();
  }
});

test('session.close never calls inner close (WP0 G7) and detach drops state', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    const closed = await harness.request('session.close', { sessionId: 's_1', streamId });
    assert.equal(closed.kind, 'result');
    const innerClose = harness.fakeLog().filter((entry) => entry.method === 'session/close');
    assert.equal(innerClose.length, 0, 'inner session/close must never be called on detach');
    const after = await harness.request('session.get', { sessionId: 's_1' });
    assert.equal(after.kind, 'error');
    assert.equal(
      ((after.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'SESSION_NOT_FOUND',
    );
  } finally {
    await harness.close();
  }
});

test('session.create is idempotent and conflicts on different workspaces', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const first = await harness.request('session.create', {
      sessionId: 's_idem',
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
    });
    assert.equal(first.kind, 'result');
    const duplicate = await harness.request('session.create', {
      sessionId: 's_idem',
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
    });
    assert.equal(duplicate.kind, 'result');
    const conflict = await harness.request('session.create', {
      sessionId: 's_idem',
      workspace: { cwd: '/tmp/other-ws', roots: ['/tmp/other-ws'] },
      config: {},
    });
    assert.equal(
      ((conflict.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFLICT',
    );
  } finally {
    await harness.close();
  }
});

test('turn config applies model -> thinking -> approval with verified set* calls', async () => {
  const harness = startHarness({
    scenario: {
      availableModels: [
        { ref: { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' }, label: 'GLM-5.3-Flash', reasoning: { enabled: true, levels: [{ value: 'low' }], defaultLevel: 'low' } },
        { ref: { providerId: 'bigmodel', modelId: 'GLM-5.3' }, label: 'GLM-5.3', reasoning: { enabled: true, levels: [{ value: 'max' }], defaultLevel: 'max' } },
      ],
      turn: {
        turnId: 'turn_cfg',
        events: [
          { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_start' },
          { seq: 1, eventId: 'evt_term', payload: { resultType: 'success' } },
        ],
      },
    },
  });
  try {
    await initialize(harness);
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const revision = catalog.catalogRevision as string;
    const options = catalog.configOptions as Array<Record<string, unknown>>;
    const modelChoices = options.find((option) => option.id === 'model')!.choices as Array<{ value: string }>;
    const otherModel = modelChoices.find((choice) => choice.value.includes('RzhnuTMuMw'))?.value
      ?? modelChoices[1]!.value;

    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: otherModel },
    });
    const turnConfig = ((resolved.payload as { result: Record<string, unknown> }).result.resolvedDefaults as Record<string, Record<string, string>>).turnConfig;

    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    const started = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_cfg',
      input: [{ type: 'text', text: 'go' }], config: turnConfig,
    });
    assert.equal(started.kind, 'result', JSON.stringify(started.payload));

    const fakeLog = harness.fakeLog().filter((entry) => entry.kind === 'request');
    const setCalls = fakeLog.filter((entry) => String(entry.method).startsWith('session/set'));
    assert.ok(setCalls.length >= 1, 'changed settings are applied before send');
    const sendIndex = fakeLog.findIndex((entry) => entry.method === 'session/send');
    const lastSetIndex = fakeLog.reduce((last, entry, index) => (
      String(entry.method).startsWith('session/set') ? index : last
    ), -1);
    assert.ok(lastSetIndex < sendIndex, 'all config applies BEFORE session/send');
  } finally {
    await harness.close();
  }
});

test('invalid model config fails the turn before send and restores state', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    await createSession(harness);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    // Valid zmodel encoding for a model the fake does not know.
    const bogus = `zmodel:v1:${Buffer.from(JSON.stringify(['bigmodel', 'NOT-A-MODEL'])).toString('base64url')}`;
    const failed = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_bad',
      input: [{ type: 'text', text: 'go' }],
      config: { model: bogus },
    });
    assert.equal(failed.kind, 'error');
    assert.equal(
      ((failed.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'RUNTIME_ERROR',
    );
    const sends = harness.fakeLog().filter((entry) => entry.method === 'session/send');
    assert.equal(sends.length, 0, 'no prompt is ever sent with unknown config');
  } finally {
    await harness.close();
  }
});

test('native list filters owned sessions and paginates', async () => {
  const harness = startHarness({
    scenario: {
      list: [
        { sessionId: 'sess_aaa', title: 'First', status: 'idle', sessionKind: 'interactive', workspace: { workspacePath: '/tmp/wa' } },
        { sessionId: 'sess_bbb', title: 'Running', status: 'running', sessionKind: 'interactive', workspace: { workspacePath: '/tmp/wb' } },
        { sessionId: 'sess_ccc', title: 'Third', status: 'idle', sessionKind: 'interactive', workspace: { workspacePath: '/tmp/wc' } },
      ],
    },
  });
  try {
    await initialize(harness);
    await createSession(harness); // owns one native session (fake-generated)
    const page1 = await harness.request('session.native.list', { limit: 1 });
    assert.equal(page1.kind, 'result');
    const result = (page1.payload as { result: { sessions: Array<Record<string, unknown>>; nextCursor: string | null } }).result;
    assert.equal(result.sessions.length, 1);
    assert.ok(result.nextCursor !== null, 'more pages available');
    assert.equal(result.sessions[0]!.active, undefined, 'no custom activity fields leak');

    const page2 = await harness.request('session.native.list', { limit: 5, cursor: result.nextCursor });
    const final = (page2.payload as { result: { sessions: Array<Record<string, unknown>>; nextCursor: string | null } }).result;
    assert.equal(final.nextCursor, null);
    // Only idle, non-owned, interactive sessions are exposed.
    const all = [...result.sessions, ...final.sessions].map((session) => session.id);
    assert.ok(all.includes('sess_aaa'));
    assert.ok(all.includes('sess_ccc'));
    assert.equal(all.includes('sess_bbb'), false, 'running sessions are not adoptable');
  } finally {
    await harness.close();
  }
});

test('shared outer Proxy reuses one inner runtime per workspace and isolates another workspace', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const create = (sessionId: string, cwd: string) => harness.request('session.create', {
      sessionId,
      workspace: { cwd, roots: [cwd] },
      config: {},
    });
    assert.equal((await create('s_pool_a', '/tmp/zcode-ws')).kind, 'result');
    assert.equal((await create('s_pool_b', '/tmp/zcode-ws')).kind, 'result');
    assert.equal((await create('s_pool_c', '/tmp/zcode-ws-two')).kind, 'result');

    const creates = harness.fakeLog().filter((entry) => entry.method === 'session/create');
    const bySession = new Map(creates.map((entry) => [
      ((entry.params as { workspace: { workspacePath: string } }).workspace.workspacePath),
      entry.pid,
    ]));
    const firstWorkspacePids = creates
      .filter((entry) => ((entry.params as { workspace: { workspacePath: string } }).workspace.workspacePath) === '/tmp/zcode-ws')
      .map((entry) => entry.pid);
    assert.equal(firstWorkspacePids.length, 2);
    assert.equal(firstWorkspacePids[0], firstWorkspacePids[1], 'same workspace reuses one app-server');
    assert.notEqual(
      firstWorkspacePids[0],
      bySession.get('/tmp/zcode-ws-two'),
      'different workspace gets a different app-server',
    );

    for (const sessionId of ['s_pool_a', 's_pool_b', 's_pool_c']) {
      const snapshot = await harness.request('session.get', { sessionId });
      const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
      assert.equal((await harness.request('session.close', { sessionId, streamId })).kind, 'result');
    }
  } finally {
    await harness.close();
  }
});

test('one workspace app-server crash fails its active turn without killing another workspace', async () => {
  const harness = startHarness({
    scenario: {
      behavior: { crashAfterTurnStarted: true },
      turn: { turnId: 'turn_crash_isolated' },
    },
  });
  try {
    await initialize(harness);
    const create = (sessionId: string, cwd: string) => harness.request('session.create', {
      sessionId,
      workspace: { cwd, roots: [cwd] },
      config: {},
    });
    assert.equal((await create('s_crash', '/tmp/zcode-ws')).kind, 'result');
    assert.equal((await create('s_survivor', '/tmp/zcode-ws-two')).kind, 'result');
    const crashing = await harness.request('session.get', { sessionId: 's_crash' });
    const streamId = ((crashing.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    assert.equal((await harness.request('turn.start', {
      sessionId: 's_crash', streamId, turnId: 't_crash',
      input: [{ type: 'text', text: 'crash fixture' }], config: {},
    })).kind, 'result');

    const notifications = await harness.waitNotifications(2);
    assert.deepEqual(notifications.map((line) => line.method), ['turn.started', 'turn.failed']);
    const error = (notifications[1]!.payload.params as {
      data: { error: { domainCode: string; retryable: boolean } };
    }).data.error;
    assert.equal(error.domainCode, 'RUNTIME_ERROR');
    assert.equal(error.retryable, true);

    const survivor = await harness.request('session.get', { sessionId: 's_survivor' });
    assert.equal(survivor.kind, 'result', 'another workspace runtime remains attached');
    const catalog = await harness.request('catalog.list', {});
    assert.equal(catalog.kind, 'result', 'catalog runtime survives workspace crash');
  } finally {
    await harness.close();
  }
});

test('persisted ownership reattaches the same native session with a fresh stream after restart', async () => {
  const harness = startHarness({
    scenario: {
      knownSessions: ['sess_restored_1'],
      seedOwnership: {
        sessionId: 's_restored',
        nativeSessionId: 'sess_restored_1',
        state: 'idle-owned',
      },
    },
  });
  try {
    await initialize(harness);
    const restored = await harness.request('session.create', {
      sessionId: 's_restored',
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
      nativeSession: { id: 'sess_restored_1', history: 'replay' },
    });
    assert.equal(restored.kind, 'result', JSON.stringify(restored.payload));
    const session = (restored.payload as {
      result: { session: { streamId: string; state: string; nativeSession: { id: string } } };
    }).result.session;
    assert.match(session.streamId, /^stream-/);
    assert.equal(session.state, 'idle');
    assert.equal(session.nativeSession.id, 'sess_restored_1');

    const resumes = harness.fakeLog().filter(entry => entry.method === 'session/resume');
    const subscriptions = harness.fakeLog().filter(entry => entry.method === 'session/subscribe');
    assert.equal(resumes.length, 1);
    assert.equal(subscriptions.length, 1);

    const conflict = await harness.request('session.create', {
      sessionId: 's_restored',
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
      nativeSession: { id: 'sess_other', history: 'replay' },
    });
    assert.equal(conflict.kind, 'error');
    assert.equal(
      ((conflict.payload as { error: { data: { domainCode: string } } }).error.data.domainCode),
      'CONFLICT',
    );
  } finally {
    await harness.close();
  }
});
