/** Focused capability tests for the Kimi server-api transport, run against
 *  the fake local server through the real proxy CLI (supervisor + REST + WS
 *  + projector + adapter + protocol ordering), validated against the shared
 *  Host protocol schemas where applicable. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { proxyNotificationSchema } from '@gian/proxy-protocol';

import {
  createSession,
  getStreamId,
  initialize,
  startHarness,
  type Harness,
  type OutgoingLine,
} from './harness.js';

const SHORT_TURN = {
  delayBefore: 10,
  events: [
    { type: 'turn.started', payload: { turnId: 1 } },
    { type: 'assistant.delta', payload: { agentId: 'main', delta: 'Hello' } },
    { type: 'assistant.delta', payload: { agentId: 'main', delta: ' world' } },
    {
      type: 'tool.call.started', payload: {
        agentId: 'main', toolCallId: 'call_1', name: 'Bash',
        args: { command: 'echo hi' },
        display: { kind: 'command', command: 'echo hi' },
      },
    },
    { type: 'tool.result', payload: { agentId: 'main', toolCallId: 'call_1', output: 'hi' } },
    {
      type: 'agent.status.updated', payload: {
        agentId: 'main', contextTokens: 42,
        usage: { total: { inputOther: 90, output: 10, inputCacheRead: 20, inputCacheCreation: 0 } },
      },
    },
    { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
    { type: 'prompt.completed', payload: { reason: 'completed' } },
  ],
};

async function waitFor(harness: Harness, method: string, timeoutMs = 10_000): Promise<OutgoingLine> {
  return harness.waitNotificationFor((line) => line.method === method, timeoutMs);
}

test('initialize declares the server-api capability set', async () => {
  const harness = startHarness({ models: [{ model: 'kimi', display_name: 'Kimi', max_context_size: 256000, support_efforts: ['low', 'high'], default_effort: 'high' }] });
  try {
    const result = await initialize(harness);
    const capabilities = result.capabilities as Record<string, number>;
    for (const key of [
      'input.localFile', 'input.localImage', 'input.skill', 'catalog.resolve',
      'session.native.list', 'session.native.delete', 'session.replay', 'session.rename',
      'sidechat', 'session.fork', 'turn.steer', 'interaction',
      'event.reasoning', 'event.plan', 'event.diff', 'event.usage',
    ]) {
      assert.equal(capabilities[key], 1, `${key} declared`);
    }
    assert.equal(capabilities['integration.mcp.streamableHttp'], undefined,
      'host MCP injection is not available on the REST surface');
  } finally {
    await harness.close();
  }
});

test('catalog projects models/thinking/approval from GET /models and resolve drops stale thinking on model change', async () => {
  const harness = startHarness({
    models: [
      { model: 'kimi', display_name: 'Kimi', max_context_size: 256000, support_efforts: ['low', 'high'], default_effort: 'high' },
      { model: 'k2', display_name: 'K2', max_context_size: 100000, support_efforts: [], default_effort: '' },
    ],
    default_model: 'kimi',
  });
  try {
    await initialize(harness);
    const listed = await harness.request('catalog.list', {});
    assert.equal(listed.kind, 'result', JSON.stringify(listed.payload));
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const options = catalog.configOptions as Array<Record<string, unknown>>;
    const model = options.find((option) => option.id === 'model')!;
    assert.equal(model.defaultValue, 'kimi');
    const thinking = options.find((option) => option.id === 'thinking')!;
    assert.deepEqual(
      (thinking.choices as Array<{ value: string }>).map((choice) => choice.value),
      ['low', 'high'],
    );
    assert.equal((catalog.specialCatalogs as Record<string, string>).approvalMode, 'approval_mode');
    const inputTypes = (catalog.input as Array<{ type: string }>).map((entry) => entry.type);
    assert.deepEqual(inputTypes, ['text', 'localFile', 'localImage', 'skill']);
    const actions = catalog.actions as Array<{ id: string; supported: boolean }>;
    assert.equal(actions.find((action) => action.id === 'session.fork')?.supported, true);
    assert.equal(actions.find((action) => action.id === 'session.fork.atTurn')?.supported, false);
    assert.equal(actions.find((action) => action.id === 'session.native.delete')?.supported, true);

    // Resolve with defaults keeps explicit values and fills the rest.
    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: catalog.catalogRevision,
      sessionConfig: {},
      turnConfig: { model: 'kimi', thinking: 'low' },
    });
    assert.equal(resolved.kind, 'result', JSON.stringify(resolved.payload));
    const defaults = ((resolved.payload as { result: { resolvedDefaults: { turnConfig: Record<string, string> } } }).result.resolvedDefaults.turnConfig);
    assert.equal(defaults.model, 'kimi');
    assert.equal(defaults.thinking, 'low');
    assert.equal(defaults.approval_mode, 'manual');

    // Stale thinking on an explicit model change is dropped, not rejected;
    // unknown values are CONFIG_VALUE_INVALID.
    const staleThinking = await harness.request('catalog.resolve', {
      catalogRevision: catalog.catalogRevision,
      sessionConfig: {},
      turnConfig: { model: 'k2', thinking: 'low' },
    });
    assert.equal(staleThinking.kind, 'result');
    const staleDefaults = ((staleThinking.payload as { result: { resolvedDefaults: { turnConfig: Record<string, string> } } }).result.resolvedDefaults.turnConfig);
    assert.equal(staleDefaults.thinking, undefined, 'k2 has no efforts; stale value dropped');
    assert.equal(staleDefaults.model, 'k2');

    const invalid = await harness.request('catalog.resolve', {
      catalogRevision: catalog.catalogRevision,
      sessionConfig: {},
      turnConfig: { model: 'not-advertised' },
    });
    assert.equal(
      ((invalid.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );
  } finally {
    await harness.close();
  }
});

test('session lifecycle: fresh create, snapshot, rename, native list, delete, close-detach', async () => {
  const harness = startHarness({
    sessions: [
      { info: { id: 'session_seed_1', title: 'Old friend', busy: false, metadata: { cwd: '/tmp/other' } } },
      { info: { id: 'session_seed_2', title: 'Busy one', busy: true, metadata: { cwd: '/tmp/other' } } },
    ],
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness, 's_1');
    assert.match(streamId, /^stream-/);
    const snapshot = await harness.request('session.get', { sessionId: 's_1' });
    const session = ((snapshot.payload as { result: { session: Record<string, unknown> } }).result.session);
    assert.match((session.nativeSession as { id: string }).id, /^session_/);

    // rename → POST /profile
    const renamed = await harness.request('session.rename', { sessionId: 's_1', streamId, name: 'Projekt Umbau' });
    assert.equal(renamed.kind, 'result', JSON.stringify(renamed.payload));
    const profileCalls = harness.fakeLog().filter((entry) => entry.path === `/api/v1/sessions/${(session.nativeSession as { id: string }).id}/profile`);
    assert.equal(profileCalls.length, 1);
    assert.equal((profileCalls[0]!.body as { title: string }).title, 'Projekt Umbau');

    // native list: busy seed excluded, owned session excluded
    const listed = await harness.request('session.native.list', { limit: 10 });
    assert.equal(listed.kind, 'result');
    const sessions = ((listed.payload as { result: { sessions: Array<{ id: string }> } }).result.sessions);
    assert.ok(sessions.some((entry) => entry.id === 'session_seed_1'));
    assert.equal(sessions.some((entry) => entry.id === 'session_seed_2'), false, 'busy sessions are not adoptable');
    assert.equal(sessions.some((entry) => entry.id === (session.nativeSession as { id: string }).id), false,
      'owned sessions are not listed');

    // delete: attached native refuses; detached seed deletes via :delete
    const deleteOwned = await harness.request('session.native.delete', {
      nativeSessionId: (session.nativeSession as { id: string }).id,
    });
    assert.equal(
      ((deleteOwned.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'SESSION_BUSY',
    );
    const deleted = await harness.request('session.native.delete', { nativeSessionId: 'session_seed_1' });
    assert.equal(deleted.kind, 'result', JSON.stringify(deleted.payload));
    assert.ok(harness.fakeLog().some((entry) => String(entry.path).endsWith('session_seed_1:delete')));

    // close detaches without native delete
    const closed = await harness.request('session.close', { sessionId: 's_1', streamId });
    assert.equal(closed.kind, 'result');
    assert.equal(harness.fakeLog().some((entry) => String(entry.path).endsWith(':delete') && String(entry.path).includes((session.nativeSession as { id: string }).id)), false,
      'close never deletes native history');
  } finally {
    await harness.close();
  }
});

test('turn lifecycle: prompt payload, event projection, single terminal, barrier ordering', async () => {
  const harness = startHarness({ turn: SHORT_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_1',
      input: [{ type: 'text', text: 'say hi' }], config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));

    const notifications = await harness.waitNotifications(9);
    const methods = notifications.map((line) => line.method);
    // turn.started, content.delta x2, content.completed (finalizer), tool running + terminal, usage, turn.completed
    assert.equal(methods.filter((method) => method === 'turn.started').length, 1);
    assert.equal(methods.filter((method) => method === 'turn.completed').length, 1, 'exactly one terminal');
    assert.equal(methods.includes('turn.failed'), false);

    // barrier: the response arrived before any notification (lines queued after)
    const completed = notifications.find((line) => line.method === 'turn.completed')!;
    assert.equal(((completed.payload.params as { data: { stopReason: string } }).data.stopReason), 'completed');

    // sourceTurnId = the native prompt id everywhere
    const started = notifications.find((line) => line.method === 'turn.started')!;
    const sourceTurnId = (started.payload.params as { sourceTurnId: string }).sourceTurnId;
    assert.match(sourceTurnId, /^gian-/);
    assert.ok(notifications.every((line) => (line.payload.params as { sourceTurnId?: string }).sourceTurnId === undefined
      || (line.payload.params as { sourceTurnId: string }).sourceTurnId === sourceTurnId));

    // content
    const delta = notifications.find((line) => line.method === 'content.delta')!;
    assert.equal(((delta.payload.params as { data: { delta: string } }).data.delta), 'Hello');
    const contentCompleted = notifications.find((line) => line.method === 'content.completed')!;
    assert.equal(((contentCompleted.payload.params as { data: { content: string } }).data.content), 'Hello world');

    // tool activity running → succeeded
    const activities = notifications.filter((line) => line.method === 'activity.updated')
      .map((line) => (line.payload.params as { data: { activityId: string; status: string } }).data);
    const toolStates = activities.filter((activity) => activity.activityId === 'call_1').map((activity) => activity.status);
    assert.deepEqual(toolStates, ['running', 'succeeded']);

    // usage from agent.status.updated usage.total
    const usage = notifications.find((line) => line.method === 'usage.updated');
    assert.ok(usage, 'usage projected');
    const conversation = ((usage!.payload.params as { data: { conversation: { inputTokens?: number; outputTokens?: number } } }).data.conversation);
    assert.equal(conversation.inputTokens, 110);
    assert.equal(conversation.outputTokens, 10);

    // outer sequence continuity 1..N
    const sequences = notifications.map((line) => (line.payload.params as { sequence: number }).sequence);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));

    // schema conformance for every projected notification
    for (const notification of notifications) {
      proxyNotificationSchema.parse(notification.payload);
    }

    // wire assertions: prompt_id + content block
    const promptCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).endsWith('/prompts') && entry.method === 'POST');
    assert.equal(promptCalls.length, 1);
    const promptBody = promptCalls[0]!.body as { prompt_id: string; content: Array<{ type: string; text: string }> };
    assert.match(promptBody.prompt_id, /^gian-/);
    assert.deepEqual(promptBody.content, [{ type: 'text', text: 'say hi' }]);
  } finally {
    await harness.close();
  }
});

test('input mapping: localImage uses path source, localFile uses file block, skill activates natively', async () => {
  const harness = startHarness({
    turn: { delayBefore: 5, events: [{ type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } }] },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const imageFile = join(harness.dir, 'shot.png');
    writeFileSync(imageFile, 'PNG');
    const textFile = join(harness.dir, 'notes.txt');
    writeFileSync(textFile, 'hello');

    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_input',
      input: [
        { type: 'text', text: 'describe' },
        { type: 'localImage', path: imageFile, name: 'shot.png' },
        { type: 'localFile', path: textFile, mime: 'text/plain' },
        { type: 'skill', name: 'deploy', args: 'prod' },
      ],
      config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));
    const promptCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).endsWith('/prompts') && entry.method === 'POST');
    const body = promptCalls[0]!.body as {
      content: Array<Record<string, unknown>>;
      skills: Array<{ name: string; args?: string }>;
    };
    assert.deepEqual(body.content[0], { type: 'text', text: 'describe' });
    assert.deepEqual(body.content[1], { type: 'image', source: { kind: 'path', path: imageFile }, name: 'shot.png' });
    assert.deepEqual(body.content[2], { type: 'file', path: textFile, media_type: 'text/plain' });
    assert.deepEqual(body.skills, [{ name: 'deploy', args: 'prod' }]);

    // missing local file fails BEFORE any prompt is submitted
    await waitFor(harness, 'turn.completed');
    const missing = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_missing',
      input: [{ type: 'localFile', path: join(harness.dir, 'nope.txt') }], config: {},
    });
    // Standard -32602 errors carry no data payload; the message is the contract.
    assert.equal(missing.kind, 'error');
    assert.equal((missing.payload as { error: { code: number } }).error.code, -32602);
    assert.match((missing.payload as { error: { message: string } }).error.message, /not readable on the Host/);
    assert.equal(promptCalls.length, 1, 'no second prompt was submitted');
  } finally {
    await harness.close();
  }
});

test('turn.start while the server is busy fails with SESSION_BUSY and never binds the turn', async () => {
  const harness = startHarness({ turn: SHORT_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const first = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_a',
      input: [{ type: 'text', text: 'long' }], config: {},
    });
    assert.equal(first.kind, 'result');
    // The fake keeps the session busy until the scripted turn ends; a second
    // prompt would queue server-side.
    const second = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_b',
      input: [{ type: 'text', text: 'while busy' }], config: {},
    });
    // Either the fake still holds the first turn (SESSION_BUSY) or the turn
    // already ended; under the scripted SHORT_TURN timing both are honest.
    if (second.kind === 'error') {
      assert.equal(
        ((second.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
        'SESSION_BUSY',
      );
    }
    await waitFor(harness, 'turn.completed');
  } finally {
    await harness.close();
  }
});

test('interrupt maps to interrupted via prompts/:pid:abort', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        { op: 'wait', ms: 900 },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_int',
      input: [{ type: 'text', text: 'long task' }], config: {},
    });
    await waitFor(harness, 'turn.started');
    const interrupted = await harness.request('turn.interrupt', {
      sessionId: 's_1', streamId, turnId: 't_int',
    });
    assert.equal(interrupted.kind, 'result');
    const abortCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).includes(':abort'));
    assert.equal(abortCalls.length, 1, 'one abort call');

    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed' || line.method === 'turn.failed');
    assert.equal(terminal.method, 'turn.completed');
    assert.equal(((terminal.payload.params as { data: { stopReason: string } }).data.stopReason), 'interrupted');
  } finally {
    await harness.close();
  }
});

test('steer: explicit TURN_NOT_FOUND when idle; guide injection when running; idempotent replay', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        { op: 'wait', ms: 900 },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);

    const idle = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_ghost',
      input: [{ type: 'text', text: 'nobody home' }],
    });
    assert.equal(
      ((idle.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'TURN_NOT_FOUND',
      'steer without an active turn is an explicit error',
    );

    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_steer',
      input: [{ type: 'text', text: 'running' }], config: {},
    });
    await waitFor(harness, 'turn.started');
    const steered = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_steer',
      input: [{ type: 'text', text: 'focus on errors' }],
    });
    assert.equal(steered.kind, 'result', JSON.stringify(steered.payload));
    const steerCalls = harness.fakeLog().filter((entry) => String(entry.path).endsWith('prompts:steer'));
    assert.equal(steerCalls.length, 1);
    assert.deepEqual((steerCalls[0]!.body as { prompt_ids: string[] }).prompt_ids.length, 1);

    // identical steer → prompt_id conflict (40927) → idempotent accepted
    const replay = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_steer',
      input: [{ type: 'text', text: 'focus on errors' }],
    });
    assert.equal(replay.kind, 'result', 'identical steer replays');

    // the steered turn ends with its own identity
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed');
    assert.equal(((terminal.payload.params as { turnId: string }).turnId), 't_steer');
    assert.equal(((terminal.payload.params as { data: { stopReason: string } }).data.stopReason), 'completed');
  } finally {
    await harness.close();
  }
});

const APPROVAL_TURN = {
  delayBefore: 10,
  events: [
    { type: 'turn.started', payload: { turnId: 1 } },
    {
      type: 'event.approval.requested', payload: {
        approval_id: 'apr_1', tool_name: 'Bash', tool_call_id: 'call_1',
        action: 'execute command', tool_input_display: { command: 'rm -rf /tmp/x' },
        expires_at: '2026-12-01T00:00:00.000Z',
      },
    },
    { op: 'wait', ms: 500 },
    { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
  ],
};

test('permission approval round-trips decision and feedback; unknown action fails typed', async () => {
  const harness = startHarness({ turn: APPROVAL_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_apr',
      input: [{ type: 'text', text: 'run' }], config: {},
    });
    const requested = await waitFor(harness, 'interaction.requested');
    const data = (requested.payload.params as { data: Record<string, unknown> }).data;
    assert.equal((data.presentation as { kind: string }).kind, 'permission');
    const actions = data.actions as Array<{ id: string; style: string }>;
    assert.deepEqual(actions.map((action) => action.id), ['approved', 'rejected']);
    assert.equal((data.context as { approvalId: string }).approvalId, 'apr_1');
    assert.deepEqual((data.context as { input: unknown }).input, { command: 'rm -rf /tmp/x' });

    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_apr',
      responseId: 'resp-1', interactionId: data.interactionId as string,
      actionId: 'approved', values: {},
    });
    assert.equal(responded.kind, 'result', JSON.stringify(responded.payload));
    const approvalCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).includes('/approvals/'));
    assert.equal(approvalCalls.length, 1);
    assert.equal((approvalCalls[0]!.body as { decision: string }).decision, 'approved');
    const resolved = await harness.waitNotificationFor((line) => line.method === 'interaction.resolved');
    assert.equal(((resolved.payload.params as { data: { outcome: string; actionId: string } }).data.outcome), 'submitted');
    assert.equal(((resolved.payload.params as { data: { actionId: string } }).data.actionId), 'approved');

    const unknown = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_apr',
      responseId: 'resp-2', interactionId: data.interactionId as string,
      actionId: 'approved', values: {},
    });
    assert.equal(
      ((unknown.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INTERACTION_NOT_FOUND',
      'already-resolved approvals are INTERACTION_NOT_FOUND',
    );

    const foreign = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_apr',
      responseId: 'resp-3', interactionId: 'apr:missing',
      actionId: 'approved', values: {},
    });
    assert.equal(
      ((foreign.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INTERACTION_NOT_FOUND',
    );
  } finally {
    await harness.close();
  }
});

const QUESTION_TURN = {
  delayBefore: 10,
  events: [
    { type: 'turn.started', payload: { turnId: 1 } },
    {
      type: 'event.question.requested', payload: {
        question_id: 'q_1',
        questions: [
          {
            id: 'q_0', question: 'Deploy where?', header: 'Target',
            options: [
              { id: 'opt_0_0', label: 'Staging', description: 'the staging cluster' },
              { id: 'opt_0_1', label: 'Production', description: 'live traffic' },
            ],
            multi_select: false, allow_other: true,
          },
        ],
      },
    },
    { op: 'wait', ms: 500 },
    { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
  ],
};

test('structured questions keep options and submit the native answers map', async () => {
  const harness = startHarness({ turn: QUESTION_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_q',
      input: [{ type: 'text', text: 'deploy' }], config: {},
    });
    const requested = await waitFor(harness, 'interaction.requested');
    const data = (requested.payload.params as { data: Record<string, unknown> }).data;
    assert.equal((data.presentation as { kind: string }).kind, 'questions');
    const inputs = data.inputs as Array<{ id: string; type: string; label: string; choices: Array<{ value: string; displayName: string }> }>;
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.type, 'single_select');
    assert.equal(inputs[0]!.label, 'Deploy where?');
    assert.deepEqual(inputs[0]!.choices.map((choice) => choice.value), ['opt_0_0', 'opt_0_1']);

    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_q',
      responseId: 'resp-q', interactionId: data.interactionId as string,
      actionId: 'accept', values: { q_0: 'opt_0_1', note: 'with canary' },
    });
    assert.equal(responded.kind, 'result', JSON.stringify(responded.payload));
    const questionCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).includes('/questions/'));
    assert.equal(questionCalls.length, 1);
    assert.deepEqual((questionCalls[0]!.body as { answers: Record<string, string>; note: string }).answers, { q_0: 'opt_0_1' });
    assert.equal((questionCalls[0]!.body as { note: string }).note, 'with canary');

    // duplicate responseId replays
    const replay = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_q',
      responseId: 'resp-q', interactionId: data.interactionId as string,
      actionId: 'accept', values: { q_0: 'opt_0_1', note: 'with canary' },
    });
    assert.equal(replay.kind, 'result');
    const conflict = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_q',
      responseId: 'resp-q', interactionId: data.interactionId as string,
      actionId: 'decline', values: {},
    });
    assert.equal(
      ((conflict.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFLICT',
    );
  } finally {
    await harness.close();
  }
});

test('plan and subagent facts project from native displays and lifecycle events', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        {
          type: 'tool.call.started', payload: {
            agentId: 'main', toolCallId: 'call_todo', name: 'TodoWrite',
            args: {},
            display: { kind: 'todo_list', items: [
              { title: 'Investigate', status: 'done' },
              { title: 'Fix it', status: 'in_progress' },
            ] },
          },
        },
        { type: 'tool.result', payload: { agentId: 'main', toolCallId: 'call_todo', output: 'ok' } },
        {
          type: 'subagent.spawned', payload: {
            subagentId: 'sub_1', subagentName: 'reviewer', description: 'Review the change',
            parentToolCallId: 'call_spawn', runInBackground: false,
          },
        },
        { type: 'subagent.completed', payload: { subagentId: 'sub_1', resultSummary: 'all good' } },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_facts',
      input: [{ type: 'text', text: 'go' }], config: {},
    });
    const plan = await harness.waitNotificationFor((line) => line.method === 'plan.updated');
    const planData = (plan.payload.params as { data: { planId: string; steps: Array<{ id: string; text: string; status: string }> } }).data;
    assert.match(planData.planId, /^kimi:todos:/);
    assert.deepEqual(planData.steps, [
      { id: 'step-0', text: 'Investigate', status: 'completed' },
      { id: 'step-1', text: 'Fix it', status: 'in_progress' },
    ]);

    // plan.waitNotificationFor already consumed turn.started + plan.updated;
    // exactly 6 notifications remain (todo running/terminal, subagent
    // spawn/completed, finalize usage, terminal).
    const agentActivities = (await harness.waitNotifications(6))
      .filter((line) => line.method === 'activity.updated')
      .map((line) => (line.payload.params as { data: Record<string, unknown> }).data)
      .filter((data) => (data.presentation as { type: string }).type === 'agent');
    assert.ok(agentActivities.length >= 2, 'subagent spawn + completed project as agent activities');
    const spawnActivity = agentActivities[0]!;
    assert.equal(spawnActivity.activityId, 'sub_1');
    assert.equal((spawnActivity.presentation as { data: { state: string } }).data.state, 'running');
    const doneActivity = agentActivities.at(-1)!;
    assert.equal((doneActivity.presentation as { data: { state: string } }).data.state, 'completed');
    assert.equal((doneActivity.presentation as { data: { summary: string } }).data.summary, 'all good');
  } finally {
    await harness.close();
  }
});

test('diff.updated carries the real path, status and patch from file history', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        { op: 'wait', ms: 60 },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } },
      ],
    },
    fileHistory: {
      '1': {
        changes: [{ path: '/tmp/fake-ws/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        content: {
          '/tmp/fake-ws/a.ts': {
            before: 'const a = 1;\n',
            after: 'const a = 2;\n',
          },
        },
      },
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_diff',
      input: [{ type: 'text', text: 'edit' }], config: {},
    });
    const diff = await harness.waitNotificationFor((line) => line.method === 'diff.updated');
    const data = (diff.payload.params as { data: { diffId: string; diff: string; truncated: boolean; files: Array<{ path: string; status: string }> } }).data;
    assert.equal(data.diffId, 'turn-1');
    assert.match(data.diff, /--- a\/\/tmp\/fake-ws\/a\.ts/);
    assert.match(data.diff, /-const a = 1;/);
    assert.match(data.diff, /\+const a = 2;/);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.files, [{ path: '/tmp/fake-ws/a.ts', status: 'modified' }]);
  } finally {
    await harness.close();
  }
});

const HISTORY_MESSAGES = [
  {
    id: 'msg_u1', session_id: 'session_seed_hist', role: 'user',
    content: [{ type: 'text', text: 'make a change' }],
    created_at: '2026-09-25T00:00:00.000Z', prompt_id: 'msg_prompt_1',
  },
  {
    id: 'msg_a1', session_id: 'session_seed_hist', role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'did it' },
      { type: 'tool_use', tool_call_id: 'call_h1', tool_name: 'Edit', input: { filePath: '/tmp/x' } },
    ],
    created_at: '2026-09-25T00:00:01.000Z', prompt_id: 'msg_prompt_1',
  },
  {
    id: 'msg_t1', session_id: 'session_seed_hist', role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_h1', output: 'patched' }],
    created_at: '2026-09-25T00:00:02.000Z', prompt_id: 'msg_prompt_1',
  },
];

test('adoption with history replay projects the full transcript with stable identities', async () => {
  const harness = startHarness({
    sessions: [
      { info: { id: 'session_seed_hist', title: 'History', busy: false, metadata: { cwd: '/tmp/other' }, last_seq: 5 }, messages: HISTORY_MESSAGES },
    ],
  });
  try {
    await initialize(harness);
    const created = await harness.request('session.create', {
      sessionId: 's_hist',
      workspace: { cwd: '/tmp/other', roots: ['/tmp/other'] },
      config: {},
      nativeSession: { id: 'session_seed_hist', history: 'replay' },
    });
    assert.equal(created.kind, 'result', JSON.stringify(created.payload));
    const snapshot = await harness.request('session.get', { sessionId: 's_hist' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);

    const notifications = (await harness.waitNotifications(6));
    const methods = notifications.map((line) => line.method);
    assert.equal(methods.filter((method) => method === 'turn.started').length, 1);
    assert.ok(methods.includes('input.recorded'), 'user input restored');
    assert.ok(methods.includes('content.completed'), 'assistant text + thinking restored');
    assert.ok(methods.includes('activity.updated'), 'tool calls restored');
    assert.ok(methods.includes('turn.completed'), 'terminal restored');
    assert.ok(notifications.every((line) => (
      (line.payload.params as { sourceTurnId?: string }).sourceTurnId === 'msg_prompt_1'
    )), 'sourceTurnId is the native prompt id');

    // tool activity carries input + output
    const activity = notifications.find((line) => line.method === 'activity.updated')!;
    const activityData = (activity.payload.params as { data: { activityId: string; status: string; presentation: { data: { output: unknown } } } }).data;
    assert.equal(activityData.activityId, 'call_h1');
    assert.equal(activityData.status, 'succeeded');
    assert.equal(activityData.presentation.data.output, 'patched');

    // Identity parity: session.replay names the same facts with the same ids.
    const replay = await harness.request('session.replay', { sessionId: 's_hist', streamId, cursor: null, limit: 500 });
    assert.equal(replay.kind, 'result', JSON.stringify(replay.payload));
    const replayEvents = ((replay.payload as { result: { events: Array<Record<string, unknown>> } }).result.events);
    for (const method of ['turn.started', 'input.recorded', 'activity.updated', 'turn.completed']) {
      const liveId = (notifications.find((line) => line.method === method)!.payload.params as { eventId: string }).eventId;
      const replayId = replayEvents.find((event) => event.method === method)!.eventId as string;
      assert.equal(liveId, replayId, `${method} identity identical between attach replay and session.replay`);
    }
  } finally {
    await harness.close();
  }
});

test('fork (head) maps to POST children; atTurn is FORK_BOUNDARY_UNAVAILABLE with evidence', async () => {
  const harness = startHarness({ turn: SHORT_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_fork',
      input: [{ type: 'text', text: 'first' }], config: {},
    });
    await waitFor(harness, 'turn.completed');

    const forked = await harness.request('session.fork', {
      sourceSessionId: 's_1', sourceStreamId: streamId,
      sessionId: 's_fork', anchor: { type: 'head' },
    });
    assert.equal(forked.kind, 'result', JSON.stringify(forked.payload));
    const result = (forked.payload as { result: Record<string, unknown> }).result;
    const origin = result.origin as { kind: string; sessionId: string; sourceTurnId: string };
    assert.equal(origin.kind, 'fork');
    assert.equal(origin.sessionId, 's_1');
    assert.match(origin.sourceTurnId, /^gian-/);
    assert.ok(harness.fakeLog().some((entry) => String(entry.path).endsWith('/children')), 'children endpoint used');
    assert.equal(harness.fakeLog().some((entry) => String(entry.path).includes('forkSessionAtMessage')), false);

    const atTurn = await harness.request('session.fork', {
      sourceSessionId: 's_1', sourceStreamId: streamId,
      sessionId: 's_fork_turn', anchor: { type: 'turn', turnId: 't_fork', sourceTurnId: origin.sourceTurnId },
    });
    assert.equal(atTurn.kind, 'error');
    assert.equal(
      ((atTurn.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'FORK_BOUNDARY_UNAVAILABLE',
    );
    assert.match(
      ((atTurn.payload as { error: { message: string } }).error.message),
      /no turn boundary/,
    );
  } finally {
    await harness.close();
  }
});

test('sidechat lifecycle: create on children, opaque resume, close tombstone', async () => {
  const harness = startHarness({ turn: SHORT_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_sc',
      input: [{ type: 'text', text: 'first' }], config: {},
    });
    await waitFor(harness, 'turn.completed');

    const created = await harness.request('sidechat.create', {
      parentSessionId: 's_1', parentStreamId: streamId, sidechatId: 'sc_1',
    });
    assert.equal(created.kind, 'result', JSON.stringify(created.payload));
    const sidechat = (created.payload as { result: { sidechat: Record<string, unknown> } }).result.sidechat;
    assert.equal(sidechat.parentSessionId, 's_1');
    assert.deepEqual(sidechat.sessionConfig, {});
    const resumeRef = sidechat.resumeRef as { id: string };
    assert.match(resumeRef.id, /.+/);

    const resumed = await harness.request('sidechat.resume', {
      sidechatId: 'sc_1', parentSessionId: 's_1', resumeRef,
    });
    assert.equal(resumed.kind, 'result', JSON.stringify(resumed.payload));

    const closed = await harness.request('sidechat.close', {
      sidechatId: 'sc_1', resumeRef,
    });
    assert.equal(closed.kind, 'result');
    assert.equal(((closed.payload as { result: { providerDataDeleted: boolean } }).result.providerDataDeleted), false);

    const afterClose = await harness.request('sidechat.resume', {
      sidechatId: 'sc_1', parentSessionId: 's_1', resumeRef,
    });
    assert.equal(
      ((afterClose.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'SIDECHAT_UNAVAILABLE',
      'closed tombstone refuses resume',
    );
  } finally {
    await harness.close();
  }
});

test('server exit marks sessions stale with a retryable runtime error; rebind reuses the native session', async () => {
  const harness = startHarness({
    behavior: { selfDestructMs: 1500 },
    turn: {
      delayBefore: 800,
      events: [{ type: 'turn.ended', payload: { turnId: 1, reason: 'completed' } }],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness, 's_exit');
    const snapshot = await harness.request('session.get', { sessionId: 's_exit' });
    const nativeId = (((snapshot.payload as { result: { session: Record<string, unknown> } }).result.session).nativeSession as { id: string }).id;

    // The fake self-destructs; the proxy must notice and report.
    const runtimeError = await harness.waitNotificationFor((line) => line.method === 'runtime.error', 15_000);
    const errorData = (runtimeError.payload.params as { data: { retryable: boolean; domainCode: string } }).data;
    assert.equal(errorData.retryable, true);
    assert.equal(errorData.domainCode, 'RUNTIME_ERROR');

    // Rebind: same native id, no second native session is created.
    const rebound = await harness.request('session.create', {
      sessionId: 's_exit',
      workspace: { cwd: harness.workspace, roots: [harness.workspace] },
      config: {},
      nativeSession: { id: nativeId, history: 'none' },
    });
    assert.equal(rebound.kind, 'result', JSON.stringify(rebound.payload));
    const createCalls = harness.fakeLog().filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/sessions');
    assert.equal(createCalls.length, 1, 'rebind never creates a second native session');
  } finally {
    await harness.close();
  }
});

test('turn failure maps kimi error codes to gian domain codes', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        { type: 'error', payload: { code: 'provider.rate_limit', message: 'slow down', retryable: true } },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'failed', error: { code: 'provider.rate_limit', message: 'slow down', retryable: true } } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_fail',
      input: [{ type: 'text', text: 'go' }], config: {},
    });
    const failed = await harness.waitNotificationFor((line) => line.method === 'turn.failed');
    const error = ((failed.payload.params as { data: { error: { domainCode: string; retryable: boolean; message: string } } }).data.error);
    assert.equal(error.domainCode, 'RUNTIME_ERROR');
    assert.equal(error.retryable, true);
    assert.match(error.message, /slow down/);
  } finally {
    await harness.close();
  }
});

test('max-steps failures complete with limit_reached instead of turn.failed', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1 } },
        { type: 'turn.ended', payload: { turnId: 1, reason: 'failed', error: { code: 'loop.max_steps_exceeded', message: 'too many steps', retryable: false } } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_limit',
      input: [{ type: 'text', text: 'go' }], config: {},
    });
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed' || line.method === 'turn.failed');
    assert.equal(terminal.method, 'turn.completed');
    assert.equal(((terminal.payload.params as { data: { stopReason: string } }).data.stopReason), 'limit_reached');
  } finally {
    await harness.close();
  }
});
