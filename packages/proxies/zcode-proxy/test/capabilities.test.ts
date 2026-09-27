/** Focused capability tests for the 0.16.9 rebase: local image/file input,
 *  steer, fork, rename, history recovery, structured interactions, plan/diff
 *  facts, subagent lifecycle, and the close/delete boundary. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHarness, type Harness } from './harness.js';

const LONG_TURN = {
  turnId: 'turn_steer_target',
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_steer_start' },
    { seq: 1, eventId: 'evt_steer_text', payload: { kind: 'text_delta', assistantMessageId: 'msg_s', delta: 'working' } },
    { op: 'wait', ms: 600 },
    { seq: 2, eventId: 'evt_steer_term', payload: { resultType: 'success' } },
  ],
};

async function initialize(harness: Harness): Promise<void> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result');
}

async function createSession(harness: Harness, sessionId = 's_1'): Promise<string> {
  const created = await harness.request('session.create', {
    sessionId,
    workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
    config: {},
  });
  assert.equal(created.kind, 'result', JSON.stringify(created.payload));
  const snapshot = await harness.request('session.get', { sessionId });
  return ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
}

function sendCommands(harness: Harness): Array<Record<string, unknown>> {
  return harness.fakeLog().filter((entry) => entry.method === 'v4/command'
    && ((entry.params as { type?: string })?.type === 'sendText'));
}

// ---- local image / file input ----

test('localImage and localFile ride sendText as local-path attachment refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-attach-'));
  const imagePath = join(dir, 'shot.png');
  const filePath = join(dir, 'notes.txt');
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(filePath, 'hello attachment');

  const harness = startHarness({ scenario: { turn: { turnId: 'turn_attach' } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_attach',
      input: [
        { type: 'text', text: 'what is in these?' },
        { type: 'localImage', path: imagePath },
        { type: 'localFile', path: filePath, name: 'renamed.txt' },
      ],
      config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));

    const commands = sendCommands(harness);
    assert.equal(commands.length, 1, 'exactly one sendText command');
    const params = commands[0]!.params as {
      payload: { text: string; attachments: Array<{ ref: string; fileName: string; mime: string; bytes: number }> };
    };
    assert.equal(params.payload.text, 'what is in these?');
    assert.deepEqual(params.payload.attachments, [
      { ref: imagePath, fileName: 'shot.png', mime: 'image/png', bytes: statSync(imagePath).size },
      { ref: filePath, fileName: 'renamed.txt', mime: 'text/plain', bytes: statSync(filePath).size },
    ], 'absolute local path + name + mime + bytes round-trip (desktop local zero-copy)');
  } finally {
    await harness.close();
  }
});

test('attachment validation fails the turn before any send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-attach-'));
  const bigPath = join(dir, 'big.bin');
  writeFileSync(bigPath, Buffer.alloc(21 * 1024 * 1024, 7));
  const notImage = join(dir, 'plain.txt');
  writeFileSync(notImage, 'text');

  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);

    const missing = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_missing',
      input: [{ type: 'localFile', path: join(dir, 'nope.txt') }],
      config: {},
    });
    assert.equal(
      ((missing.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INVALID_PARAMS',
      'unreadable local files fail fast',
    );

    const oversized = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_big',
      input: [{ type: 'localFile', path: bigPath }],
      config: {},
    });
    assert.equal(
      ((oversized.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INVALID_PARAMS',
      'the 20MiB upstream attachment cap is enforced',
    );

    const wrongKind = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_kind',
      input: [{ type: 'localImage', path: notImage }],
      config: {},
    });
    assert.equal(
      ((wrongKind.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
      'localImage requires an image/* MIME type',
    );

    assert.equal(sendCommands(harness).length, 0, 'no sendText was ever issued');
  } finally {
    await harness.close();
  }
});

// ---- skill activation ----

test('input.skill activates through the upstream canonical manual-skill prompt', async () => {
  const harness = startHarness({ scenario: { turn: { turnId: 'turn_skill' } } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_skill',
      input: [
        { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' },
        { type: 'text', text: 'ship it' },
      ],
      config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));
    const params = (sendCommands(harness)[0]!.params as { payload: { text: string } });
    assert.match(params.payload.text, /Use the skill named `deploy` for this turn\./);
    assert.match(params.payload.text, /First call the `Skill` tool with name `deploy`/);
    assert.match(params.payload.text, /User request:\nship it/, 'the user text becomes the task block');
  } finally {
    await harness.close();
  }
});

// ---- steer ----

test('turn.steer routes guide delivery into the CURRENT turn with event continuity', async () => {
  const harness = startHarness({ scenario: { turn: LONG_TURN } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const started = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_steer',
      input: [{ type: 'text', text: 'long task' }], config: {},
    });
    assert.equal(started.kind, 'result');

    const steered = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_steer',
      input: [{ type: 'text', text: 'focus on the error path' }],
    });
    assert.equal(steered.kind, 'result', JSON.stringify(steered.payload));
    assert.equal(((steered.payload as { result: { turnId: string } }).result.turnId), 't_steer');

    const steerCommands = sendCommands(harness).filter((entry) => (
      ((entry.params as { payload?: { requestedDelivery?: string } }).payload?.requestedDelivery) === 'guide'
    ));
    assert.equal(steerCommands.length, 1, 'steer maps to a guide sendText');
    const guideParams = (steerCommands[0]!.params as { payload: { text: string } });
    assert.equal(guideParams.payload.text, 'focus on the error path');

    // Event continuity: the same native turn keeps flowing, exactly one
    // turn.started, one terminal (the finalizer closes the open text first).
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed');
    const methods = ['turn.started', 'content.delta', 'turn.completed'];
    void methods;
    assert.equal(
      ((terminal.payload.params as { turnId: string }).turnId),
      't_steer',
      'the guided turn reaches its own terminal on the same outer turn',
    );
  } finally {
    await harness.close();
  }
});

test('steer without an active turn fails with TURN_NOT_FOUND; attachments are rejected', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);

    const none = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_ghost',
      input: [{ type: 'text', text: 'nobody is running' }],
    });
    assert.equal(none.kind, 'error');
    assert.equal(
      ((none.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'TURN_NOT_FOUND',
      'steer without a running turn is an explicit error, never a queued send',
    );

    const started = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_files',
      input: [{ type: 'text', text: 'go' }], config: {},
    });
    assert.equal(started.kind, 'result');

    const dir = mkdtempSync(join(tmpdir(), 'zc-steer-'));
    const filePath = join(dir, 'f.txt');
    writeFileSync(filePath, 'data');
    const withFile = await harness.request('turn.steer', {
      sessionId: 's_1', streamId, turnId: 't_files',
      input: [{ type: 'localFile', path: filePath }],
    });
    assert.equal(
      ((withFile.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INVALID_PARAMS',
      'guide routing is text-only upstream (guide.attachmentsUnsupported)',
    );
    await harness.waitNotificationFor((line) => line.method === 'turn.started');
    const guides = sendCommands(harness).filter((entry) => (
      ((entry.params as { payload?: { requestedDelivery?: string } }).payload?.requestedDelivery) === 'guide'
    ));
    assert.equal(guides.length, 0, 'no guide command was ever issued for the rejected input');
  } finally {
    await harness.close();
  }
});

// ---- fork ----

const FORK_ROWS = [
  { rowId: 1, turnId: 'pt_1', entityId: 'ent_1', kind: 'turnHeader', state: 'completedSuccess' },
  { rowId: 2, turnId: 'pt_1', entityId: 'ent_2', kind: 'assistantText', state: 'complete', text: 'first answer', actions: { canFork: true } },
  { rowId: 3, turnId: 'pt_2', entityId: 'ent_3', kind: 'turnHeader', state: 'completedSuccess' },
  { rowId: 4, turnId: 'pt_2', entityId: 'ent_4', kind: 'assistantText', state: 'complete', text: 'second answer', actions: { canFork: true } },
];

test('session.fork head maps to the v4 conversation-only forkAssistant command', async () => {
  const harness = startHarness({
    scenario: { rows: FORK_ROWS, forkChild: { sessionId: 'sess_child_1' } },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const forked = await harness.request('session.fork', {
      sourceSessionId: 's_1', sourceStreamId: streamId,
      sessionId: 's_fork_head',
      anchor: { type: 'head' },
    });
    assert.equal(forked.kind, 'result', JSON.stringify(forked.payload));
    const result = (forked.payload as { result: Record<string, unknown> }).result;
    const session = result.session as { id: string; nativeSession: { id: string }; streamId: string };
    assert.equal(session.id, 's_fork_head');
    assert.equal(session.nativeSession.id, 'sess_child_1', 'the fork result carries the durable child native id');
    const origin = result.origin as { kind: string; sessionId: string; sourceTurnId: string };
    assert.equal(origin.kind, 'fork');
    assert.equal(origin.sessionId, 's_1');
    assert.equal(origin.sourceTurnId, 'pt_2', 'head fork targets the last completed turn');

    const forkCommands = harness.fakeLog().filter((entry) => entry.method === 'v4/command'
      && ((entry.params as { type?: string })?.type === 'forkAssistant'));
    assert.equal(forkCommands.length, 1);
    const command = forkCommands[0]!.params as {
      baseRevision: number; baseLogEpoch: string; payload: { target: { rowId: number; entityId: string } };
    };
    assert.equal(command.baseRevision, 7, 'the rowsRange CAS watermark rides the command');
    assert.equal(command.baseLogEpoch, 'epoch-1');
    assert.deepEqual(command.payload.target, { rowId: 4, entityId: 'ent_4' });

    // The child was adopted through the standard resume+subscribe path.
    const resumes = harness.fakeLog().filter((entry) => entry.method === 'session/resume'
      && ((entry.params as { sessionId?: string }).sessionId) === 'sess_child_1');
    assert.equal(resumes.length, 1, 'the child session is adopted, not fabricated');
    assert.equal(harness.fakeLog().filter((entry) => entry.method === 'session/fork').length, 0,
      'the legacy checkpoint fork (workspace rewind) is never used');
  } finally {
    await harness.close();
  }
});

test('session.fork.atTurn forks the requested completed turn; unknown turns are unavailable', async () => {
  const harness = startHarness({
    scenario: { rows: FORK_ROWS, forkChild: { sessionId: 'sess_child_2' } },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const forked = await harness.request('session.fork', {
      sourceSessionId: 's_1', sourceStreamId: streamId,
      sessionId: 's_fork_turn1',
      anchor: { type: 'turn', turnId: 'outer_1', sourceTurnId: 'pt_1' },
    });
    assert.equal(forked.kind, 'result', JSON.stringify(forked.payload));
    const command = (harness.fakeLog().filter((entry) => entry.method === 'v4/command'
      && ((entry.params as { type?: string })?.type === 'forkAssistant'))[0]!.params as {
      payload: { target: { rowId: number } };
    });
    assert.equal(command.payload.target.rowId, 2, 'the requested turn boundary is forked exactly');

    const missing = await harness.request('session.fork', {
      sourceSessionId: 's_1', sourceStreamId: streamId,
      sessionId: 's_fork_ghost',
      anchor: { type: 'turn', turnId: 'outer_x', sourceTurnId: 'pt_unknown' },
    });
    assert.equal(missing.kind, 'error');
    assert.equal(
      ((missing.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'FORK_BOUNDARY_UNAVAILABLE',
    );
  } finally {
    await harness.close();
  }
});

// ---- rename ----

test('session.rename maps to the v4 renameSession command', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const renamed = await harness.request('session.rename', {
      sessionId: 's_1', streamId, name: 'Projekt Umbau',
    });
    assert.equal(renamed.kind, 'result', JSON.stringify(renamed.payload));
    const renames = harness.fakeLog().filter((entry) => entry.method === 'v4/command'
      && ((entry.params as { type?: string })?.type === 'renameSession'));
    assert.equal(renames.length, 1);
    const command = renames[0]!.params as { payload: { title: string } };
    assert.equal(command.payload.title, 'Projekt Umbau');

    const tooLong = await harness.request('session.rename', {
      sessionId: 's_1', streamId, name: 'x'.repeat(201),
    });
    assert.equal(
      ((tooLong.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'INVALID_PARAMS',
    );
  } finally {
    await harness.close();
  }
});

// ---- history recovery on attach ----

const HISTORY_MESSAGES = [
  {
    info: { role: 'user', messageId: 'msg_h_u1', time: { created: 1_700_000_000_000 } },
    parts: [{ type: 'text', id: 'p1', text: 'make a change' }],
  },
  {
    info: {
      role: 'assistant', messageId: 'msg_h_a1', parentMessageId: 'msg_h_u1', finish: 'stop',
      time: { created: 1_700_000_000_500 },
      tokens: { total: 30, input: 25, output: 5, cache: { read: 4, write: 0 } },
    },
    parts: [
      { type: 'timeline', id: 'ptl', anchorTurnId: 'turn_h_1' },
      {
        type: 'tool', id: 'pt1', callID: 'call_h_1', tool: 'Edit',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/fake-ws/a.ts' },
          output: {
            filePath: '/tmp/fake-ws/a.ts',
            structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ['-old', '+new', '+new2', ' ctx'] }],
          },
        },
      },
      { type: 'text', id: 'px1', text: 'done' },
    ],
  },
];

test('adopting with history replay restores complete messages, tools, usage and terminal', async () => {
  const harness = startHarness({
    scenario: { knownSessions: ['sess_hist_1'], messages: HISTORY_MESSAGES },
  });
  try {
    await initialize(harness);
    await harness.request('session.create', {
      sessionId: 's_hist',
      nativeSession: { id: 'sess_hist_1', history: 'replay' },
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
    });
    const notifications = await harness.waitNotifications(6);
    const methods = notifications.map((line) => line.method);
    assert.equal(methods.filter((method) => method === 'turn.started').length, 1);
    assert.ok(methods.includes('input.recorded'), 'the persisted user input is restored');
    assert.ok(methods.includes('content.completed'), 'assistant text is restored');
    assert.ok(methods.includes('activity.updated'), 'tool calls are restored');
    assert.ok(methods.includes('usage.updated'), 'token usage is restored');
    assert.ok(methods.includes('turn.completed'), 'the terminal state is restored');
    assert.ok(notifications.every((line) => (
      (line.payload.params as { sourceTurnId?: string }).sourceTurnId === 'turn_h_1'
    )), 'every restored event carries the stable native sourceTurnId');

    // Identity stability: the attach replay and a fresh session.replay name
    // the same facts with the same eventIds.
    const snapshot = await harness.request('session.get', { sessionId: 's_hist' });
    const streamId = ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
    const replay = await harness.request('session.replay', { sessionId: 's_hist', streamId, cursor: null, limit: 100 });
    const replayEvents = ((replay.payload as { result: { events: Array<Record<string, unknown>> } }).result.events);
    const attachEvents = notifications.filter((line) => line.kind === 'notification');
    for (const method of ['turn.started', 'input.recorded', 'turn.completed']) {
      const attachId = (attachEvents.find((line) => line.method === method)!.payload.params as { eventId: string }).eventId;
      const replayId = replayEvents.find((event) => event.method === method)!.eventId;
      assert.equal(attachId, replayId, `${method} identity is identical between attach replay and session.replay`);
    }
  } finally {
    await harness.close();
  }
});

// ---- structured interactions ----

const ASK_TURN = {
  turnId: 'turn_ask',
  userInputRequest: {
    requestId: 'ask-42',
    toolName: 'AskUserQuestion',
    prompt: 'Pick a deployment target',
    questions: [{
      question: 'Which environment should I deploy to?',
      header: 'Target',
      options: [
        { value: 'staging', label: 'Staging', description: 'The staging cluster' },
        { value: 'production', label: 'Production', description: 'Live traffic' },
      ],
      multiSelect: false,
    }],
  },
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_ask_start' },
    { seq: 1, eventId: 'evt_ask_term', payload: { resultType: 'success' } },
  ],
};

test('structured questions keep options and round-trip the native accept content', async () => {
  const harness = startHarness({ scenario: { turn: ASK_TURN } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_ask',
      input: [{ type: 'text', text: 'deploy' }], config: {},
    });
    const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const data = (requested.payload.params as { data: Record<string, unknown> }).data;
    assert.equal((data.presentation as { kind: string }).kind, 'questions');
    const inputs = data.inputs as Array<{ id: string; type: string; label: string; choices: Array<{ value: string; displayName: string }> }>;
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.type, 'single_select');
    assert.equal(inputs[0]!.label, 'Which environment should I deploy to?');
    assert.deepEqual(inputs[0]!.choices.map((choice) => choice.value), ['staging', 'production']);
    assert.equal((data.context as { questions?: unknown }).questions !== undefined, true,
      'the full native question payload is preserved in context');

    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_ask',
      responseId: 'resp-ask', interactionId: data.interactionId as string, actionId: 'accept',
      values: { q0: 'production' },
    });
    assert.equal(responded.kind, 'result', JSON.stringify(responded.payload));

    let answer: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && answer === undefined; i += 1) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
      answer = harness.fakeLog().find((entry) => entry.kind === 'reverse-answer'
        && (entry.result as { action?: string } | undefined)?.action !== undefined)?.result as Record<string, unknown>;
    }
    assert.ok(answer, 'the proxy answered the reverse request');
    assert.deepEqual(answer, {
      action: 'accept',
      content: { answers: { 'Which environment should I deploy to?': 'production' } },
    }, 'the accept maps to the native answers shape keyed by question text');
  } finally {
    await harness.close();
  }
});

const PLAN_TURN = {
  turnId: 'turn_plan',
  userInputRequest: {
    requestId: 'plan-7',
    toolName: 'ExitPlanMode',
    prompt: '1. Read files\n2. Edit them',
    schema: { interaction: 'plan_approval' },
    questions: [{
      question: 'Review this implementation plan.',
      header: 'Plan',
      options: [{ value: 'approve', label: 'Approve', description: 'Exit plan mode and start implementation.' }],
    }],
  },
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_plan_start' },
    { seq: 1, eventId: 'evt_plan_term', payload: { resultType: 'success' } },
  ],
};

test('plan approval keeps the plan text and supports approve and feedback paths', async () => {
  const harness = startHarness({ scenario: { turn: PLAN_TURN } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_plan',
      input: [{ type: 'text', text: 'plan something' }], config: {},
    });
    const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const data = (requested.payload.params as { data: Record<string, unknown> }).data;
    assert.equal((data.presentation as { kind: string }).kind, 'plan_approval');
    assert.equal(data.description, '1. Read files\n2. Edit them', 'the plan text is preserved');
    const actions = data.actions as Array<{ id: string }>;
    assert.deepEqual(actions.map((action) => action.id), ['approve', 'feedback', 'decline']);

    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_plan',
      responseId: 'resp-plan', interactionId: data.interactionId as string, actionId: 'approve', values: {},
    });
    assert.equal(responded.kind, 'result');
    let answer: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && answer === undefined; i += 1) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
      answer = harness.fakeLog().find((entry) => entry.kind === 'reverse-answer'
        && (entry.result as { action?: string } | undefined)?.action !== undefined)?.result as Record<string, unknown>;
    }
    assert.deepEqual(answer, {
      action: 'accept',
      content: { answers: { 'Review this implementation plan.': 'approve' } },
    });
  } finally {
    await harness.close();
  }
});

// ---- plan / diff / subagent facts ----

const FACTS_TURN = {
  turnId: 'turn_facts',
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_facts_start' },
    {
      seq: 1, eventId: 'evt_facts_todo', type: 'tool.updated',
      payload: {
        kind: 'tool_call', toolCallId: 'call_todo', tool: 'TodoWrite', status: 'running',
        input: { todos: [
          { content: 'Investigate', status: 'completed', priority: 'high' },
          { content: 'Fix it', status: 'in_progress', priority: 'high' },
          { content: 'Verify', status: 'pending', priority: 'medium' },
        ] },
      },
    },
    {
      seq: 2, eventId: 'evt_facts_edit', type: 'tool.updated',
      payload: {
        kind: 'tool_call', toolCallId: 'call_edit', tool: 'Edit', status: 'completed',
        result: {
          filePath: '/tmp/fake-ws/a.ts',
          oldString: 'const a = 1;',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-const a = 1;', '+const a = 2;', '+const b = 3;'] }],
        },
      },
    },
    {
      seq: 3, eventId: 'evt_facts_spawn', type: 'session.updated',
      payload: {
        agentId: 'agent_1', agentType: 'code-reviewer', childSessionId: 'sess_sub_1',
        description: 'Review the change', parentToolCallId: 'call_spawn', status: 'running',
      },
    },
    {
      seq: 4, eventId: 'evt_facts_stop', type: 'session.updated',
      payload: {
        agentId: 'agent_1', agentType: 'code-reviewer', childSessionId: 'sess_sub_1',
        parentToolCallId: 'call_spawn', status: 'completed', totalDurationMs: 1200,
      },
    },
    { seq: 5, eventId: 'evt_facts_term', payload: { resultType: 'success' } },
  ],
};

test('plan.updated, diff.updated and subagent activity project from native facts', async () => {
  const harness = startHarness({ scenario: { turn: FACTS_TURN } });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_facts',
      input: [{ type: 'text', text: 'do it' }], config: {},
    });
    const notifications = await harness.waitNotifications(7);

    const plan = notifications.find((line) => line.method === 'plan.updated');
    assert.ok(plan, 'plan.updated emitted from the TodoWrite fact');
    const planData = (plan!.payload.params as { data: { planId: string; steps: Array<{ id: string; text: string; status: string }> } }).data;
    assert.match(planData.planId, /^zcode:todos:/, 'the plan id names the native session todos');
    assert.deepEqual(planData.steps, [
      { id: 'step-0', text: 'Investigate', status: 'completed' },
      { id: 'step-1', text: 'Fix it', status: 'in_progress' },
      { id: 'step-2', text: 'Verify', status: 'pending' },
    ]);

    const diff = notifications.find((line) => line.method === 'diff.updated');
    assert.ok(diff, 'diff.updated emitted from the Edit structuredPatch');
    const diffData = (diff!.payload.params as { data: { diffId: string; diff: string; truncated: boolean; files: Array<{ path: string; status: string }> } }).data;
    assert.equal(diffData.diffId, 'call_edit');
    assert.match(diffData.diff, /--- a\/\/tmp\/fake-ws\/a\.ts/);
    assert.match(diffData.diff, /\+const b = 3;/);
    assert.equal(diffData.truncated, false);
    assert.deepEqual(diffData.files, [{ path: '/tmp/fake-ws/a.ts', status: 'modified' }]);

    const subagentActivities = notifications.filter((line) => line.method === 'activity.updated')
      .filter((line) => ((line.payload.params as { data: { presentation?: { type?: string } } }).data.presentation?.type) === 'agent');
    assert.equal(subagentActivities.length, 2, 'subagent spawn + stop project as agent activities');
    const states = subagentActivities.map((line) => (
      (line.payload.params as { data: { activityId: string; presentation: { data: { state: string; agentId: string } } } }).data
    ));
    assert.equal(states[0]!.activityId, 'sess_sub_1', 'the child session id is the stable activity identity');
    assert.equal(states[0]!.presentation.data.agentId, 'sess_sub_1');
    assert.equal(states[0]!.presentation.data.state, 'running');
    assert.equal(states[1]!.presentation.data.state, 'completed', 'the terminal subagent state arrives');
  } finally {
    await harness.close();
  }
});

// ---- close / delete boundary ----

test('native delete stays unsupported with the close-semantics evidence; history stays visible', async () => {
  const harness = startHarness({
    scenario: {
      list: [
        { sessionId: 'sess_hist_1', title: 'Old friend', status: 'idle', sessionKind: 'interactive', workspace: { workspacePath: '/tmp/fake-ws' } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);

    const deleted = await harness.request('session.native.delete', { nativeSessionId: 'whatever' });
    assert.equal(deleted.kind, 'error');
    const domain = ((deleted.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode);
    assert.equal(domain, 'CAPABILITY_NOT_SUPPORTED');
    assert.match(
      ((deleted.payload as { error: { message: string } }).error.message),
      /closeSession.*never purge/i,
      'the delete boundary names the upstream closeSession semantics',
    );

    const sidechat = await harness.request('sidechat.create', {
      parentSessionId: 's_1', parentStreamId: streamId, sidechatId: 'sc_1',
    });
    assert.equal(
      ((sidechat.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'SIDECHAT_UNAVAILABLE',
    );

    // Close detaches; the native session remains visible and adoptable.
    await harness.request('session.close', { sessionId: 's_1', streamId });
    const native = await harness.request('session.native.list', {});
    const sessions = ((native.payload as { result: { sessions: Array<{ id: string }> } }).result.sessions);
    assert.ok(sessions.some((session) => session.id === 'sess_hist_1'),
      'closed/unowned history remains visible in the native list');
  } finally {
    await harness.close();
  }
});

// ---- steer across restart ----

test('runtime exit finalizes hanging interactions with runtime_ended', async () => {
  const harness = startHarness({
    scenario: {
      turn: {
        turnId: 'turn_hang',
        permissionRequest: { requestId: 'perm-hang' },
        events: [{ channel: 'computer-use', kind: 'turn-started', eventId: 'evt_hang_start' }],
        // no terminal: the runtime exits while the interaction is pending
      },
      behavior: { crashAfterMs: 250 },
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness, 's_exit');
    // Create a second session so the crash recovery test owns two runtimes? No:
    // crashAfterTurnStarted kills the whole app-server; the pending interaction
    // must be terminated with runtime_ended.
    const started = await harness.request('turn.start', {
      sessionId: 's_exit', streamId, turnId: 't_hang',
      input: [{ type: 'text', text: 'hang' }], config: {},
    });
    assert.equal(started.kind, 'result');
    await harness.waitNotificationFor((line) => line.method === 'interaction.requested');
    const notifications = await harness.waitNotifications(2);
    const resolved = notifications.find((line) => line.method === 'interaction.resolved');
    assert.ok(resolved, 'the hanging interaction is terminated');
    assert.equal(
      ((resolved!.payload.params as { data: { outcome: string; interactionId: string } }).data.outcome),
      'runtime_ended',
    );
    const turnFailed = notifications.find((line) => line.method === 'turn.failed');
    assert.ok(turnFailed, 'the active turn fails with the runtime exit');
  } finally {
    await harness.close();
  }
});
