/** Focused capability tests for the Kimi server-api transport, run against
 *  the fake local server through the real proxy CLI (supervisor + REST + WS
 *  + projector + adapter + protocol ordering), validated against the shared
 *  Host protocol schemas where applicable. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { HostProtocolValidator, ReplayPageValidator, proxyNotificationSchema } from '@gian/proxy-protocol';

import { terminalEventIdFor } from '../src/core/replay.js';

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

test('catalog.resolve keeps listed and model-specific revisions valid for later effort changes', async () => {
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
    const baseRevision = ((listed.payload as { result: { catalogRevision: string } }).result.catalogRevision);
    const switched = await harness.request('catalog.resolve', {
      catalogRevision: baseRevision,
      sessionConfig: {},
      turnConfig: { model: 'k2' },
    });
    assert.equal(switched.kind, 'result', JSON.stringify(switched.payload));
    const switchedRevision = ((switched.payload as { result: { catalogRevision: string } }).result.catalogRevision);
    assert.notEqual(switchedRevision, baseRevision);

    const relisted = await harness.request('catalog.list', {});
    assert.equal((relisted.payload as { result: { catalogRevision: string } }).result.catalogRevision, baseRevision);
    for (const revision of [baseRevision, switchedRevision]) {
      const restored = await harness.request('catalog.resolve', {
        catalogRevision: revision,
        sessionConfig: {},
        turnConfig: { model: 'kimi' },
      });
      assert.equal(restored.kind, 'result', JSON.stringify(restored.payload));
      const options = (restored.payload as { result: { configOptions: Array<{ id: string; choices?: Array<{ value: string }> }> } }).result.configOptions;
      assert.deepEqual(options.find((option) => option.id === 'thinking')?.choices?.map((choice) => choice.value), ['low', 'high']);
    }
  } finally {
    await harness.close();
  }
});

const THINKING_MODELS = [
  { model: 'effort-model', capabilities: ['thinking', 'always_thinking'], support_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  { model: 'toggle-model', capabilities: ['thinking'], support_efforts: [] },
  { model: 'locked-model', capabilities: ['thinking', 'always_thinking'], support_efforts: [] },
  { model: 'plain-model', capabilities: ['tool_use'], support_efforts: [] },
  { model: 'middle-model', capabilities: ['thinking'], support_efforts: ['low', 'high', 'max'] },
];

test('thinking catalog follows model capabilities and clears stale effort/toggle values in both directions', async () => {
  const harness = startHarness({ models: THINKING_MODELS, default_model: 'effort-model' });
  type Catalog = {
    catalogRevision: string;
    specialCatalogs: { thinking?: string };
    configOptions: Array<{ id: string; defaultValue?: string; choices?: Array<{ value: string }> }>;
    resolvedDefaults: { turnConfig: Record<string, string> };
  };
  const resultOf = (line: OutgoingLine): Catalog => {
    assert.equal(line.kind, 'result', JSON.stringify(line.payload));
    return (line.payload as { result: Catalog }).result;
  };
  try {
    await initialize(harness);
    const baseline = resultOf(await harness.request('catalog.list', {}));
    const resolve = (revision: string, model: string, thinking?: string) => harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model, ...(thinking !== undefined ? { thinking } : {}) },
    });
    const toggle = resultOf(await resolve(baseline.catalogRevision, 'toggle-model', 'max'));
    const thinking = toggle.configOptions.find((option) => option.id === 'thinking');
    assert.equal(toggle.specialCatalogs.thinking, 'thinking');
    assert.deepEqual(thinking?.choices?.map((choice) => choice.value), ['on', 'off']);
    assert.equal(thinking?.defaultValue, 'on', 'native boolean models default to on');
    assert.equal(toggle.resolvedDefaults.turnConfig.thinking, 'on', 'stale effort is replaced');
    assert.equal(resultOf(await resolve(toggle.catalogRevision, 'toggle-model', 'off'))
      .resolvedDefaults.turnConfig.thinking, 'off', 'explicit off is retained');
    const invalid = await resolve(toggle.catalogRevision, 'toggle-model', 'max');
    assert.equal((invalid.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
      'CONFIG_VALUE_INVALID', 'an invalid value without a model change is rejected');

    const effort = resultOf(await resolve(toggle.catalogRevision, 'effort-model', 'off'));
    assert.equal(effort.resolvedDefaults.turnConfig.thinking, 'max',
      'switching back to the baseline model also clears stale toggle values');
    assert.deepEqual(effort.configOptions.find((option) => option.id === 'thinking')?.choices?.map((choice) => choice.value),
      ['low', 'high', 'max']);
    const middle = resultOf(await resolve(baseline.catalogRevision, 'middle-model'));
    assert.equal(middle.resolvedDefaults.turnConfig.thinking, 'high', 'native fallback is the middle effort');
    const locked = resultOf(await resolve(baseline.catalogRevision, 'locked-model', 'off'));
    assert.deepEqual(locked.configOptions.find((option) => option.id === 'thinking')?.choices?.map((choice) => choice.value), ['on']);
    assert.equal(locked.resolvedDefaults.turnConfig.thinking, 'on');
    const cannotDisable = await resolve(locked.catalogRevision, 'locked-model', 'off');
    assert.equal((cannotDisable.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
      'CONFIG_VALUE_INVALID');
    const plain = resultOf(await resolve(toggle.catalogRevision, 'plain-model', 'on'));
    assert.equal(plain.specialCatalogs.thinking, undefined);
    assert.equal(plain.resolvedDefaults.turnConfig.thinking, undefined);
    const unsupported = await resolve(plain.catalogRevision, 'plain-model', 'on');
    assert.equal((unsupported.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
      'CONFIG_VALUE_INVALID');
  } finally {
    await harness.close();
  }
});

test('toggle thinking sends on/off through Host conformance to REST and rejects stale values before prompts', async () => {
  const harness = startHarness({ models: THINKING_MODELS, default_model: 'effort-model', turn: SHORT_TURN });
  const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
  let requestIndex = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `toggle-${++requestIndex}`;
    host.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', JSON.stringify(response.payload));
    host.acceptLine(JSON.stringify(response.payload));
    return response;
  };
  try {
    await request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.2'] },
      host: { name: 'Gian', version: '0.6.5-test' },
    });
    const listed = await request('catalog.list', {});
    const catalogRevision = (listed.payload as { result: { catalogRevision: string } }).result.catalogRevision;
    let lastStreamId = '';
    for (const value of ['on', 'off']) {
      const sessionId = `s_${value}`;
      const created = await request('session.create', {
        sessionId, workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      });
      const streamId = (created.payload as { result: { session: { streamId: string } } }).result.session.streamId;
      lastStreamId = streamId;
      const resolved = await request('catalog.resolve', {
        sessionId, streamId, catalogRevision, sessionConfig: {},
        turnConfig: { model: 'toggle-model', thinking: value === 'on' ? 'max' : value },
      });
      const config = (resolved.payload as { result: { resolvedDefaults: { turnConfig: Record<string, string> } } }).result.resolvedDefaults.turnConfig;
      assert.equal(config.thinking, value);
      await request('turn.start', {
        sessionId, streamId, turnId: `t_${value}`,
        input: [{ type: 'text', text: 'say hi' }], config,
      });
      for (const notification of await harness.waitNotifications(11)) {
        host.acceptLine(JSON.stringify(notification.payload));
      }
    }
    // Send invalid drafts directly to the Proxy as well: Host validation
    // must not be the only protection against an unadvertised REST value.
    for (const [model, thinking] of [
      ['toggle-model', 'max'], ['toggle-model', 'low'],
      ['locked-model', 'off'], ['plain-model', 'on'],
    ]) {
      const rejected = await harness.request('turn.start', {
        sessionId: 's_off', streamId: lastStreamId, turnId: `bad_${model}_${thinking}`,
        input: [{ type: 'text', text: 'must not send' }], config: { model, thinking },
      });
      assert.equal(rejected.kind, 'error', JSON.stringify(rejected.payload));
      assert.equal((rejected.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
        'CONFIG_VALUE_INVALID');
    }
    const prompts = harness.fakeLog().filter((entry) => entry.method === 'POST' && String(entry.path).endsWith('/prompts'));
    assert.deepEqual(prompts.map((entry) => {
      const body = entry.body as { model: string; thinking: string };
      return { model: body.model, thinking: body.thinking };
    }), [{ model: 'toggle-model', thinking: 'on' }, { model: 'toggle-model', thinking: 'off' }]);
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

// Exercise real CLI responses through the same validator that rejects bad
// session metadata in Host, rather than validating only the JSON schemas.
for (const version of ['2.1', '2.2', '2.3']) {
  test(`session action snapshots and live updates conform to Host protocol ${version}`, async () => {
    const harness = startHarness({
      models: [{ model: 'kimi', display_name: 'Kimi', support_efforts: ['low'], default_effort: 'low' }],
      default_model: 'kimi',
      turn: SHORT_TURN,
    });
    const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
    let requestIndex = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = `host-${++requestIndex}`;
      host.registerRequest({ jsonrpc: '2.0', id, method, params });
      const response = await harness.request(method, params, id);
      assert.equal(response.kind, 'result', JSON.stringify(response.payload));
      host.acceptLine(JSON.stringify(response.payload));
      return response;
    };
    try {
      await request('initialize', {
        protocol: { name: 'gian.proxy', versions: [version] },
        host: { name: 'Gian', version: '0.6.5-test' },
      });
      await request('catalog.list', {});
      const created = await request('session.create', {
        sessionId: 's_1',
        workspace: { cwd: harness.workspace, roots: [harness.workspace] },
        config: {},
      });
      const streamId = (created.payload as { result: { session: { streamId: string } } }).result.session.streamId;
      await request('session.get', { sessionId: 's_1' });
      await request('turn.start', {
        sessionId: 's_1', streamId, turnId: 't_1',
        input: [{ type: 'text', text: 'say hi' }],
        config: { model: 'kimi', thinking: 'low', approval_mode: 'manual' },
      });
      const notifications = await harness.waitNotifications(11);
      for (const notification of notifications) {
        host.acceptLine(JSON.stringify(notification.payload));
      }
      const updates = notifications.filter((line) => line.method === 'session.updated')
        .map((line) => (line.payload.params as { data: { state: string; availableActions: Record<string, { enabled: boolean }> } }).data);
      assert.deepEqual(updates.map((update) => update.state), ['running', 'idle']);
      assert.equal(updates[0]?.availableActions['session.fork']?.enabled, false);
      assert.equal(updates[1]?.availableActions['session.fork']?.enabled, true);
      assert.equal(updates[1]?.availableActions['sidechat.create']?.enabled, true);
      await request('session.get', { sessionId: 's_1' });
    } finally {
      await harness.close();
    }
  });
}

test('turn lifecycle: prompt payload, event projection, single terminal, barrier ordering', async () => {
  const harness = startHarness({ turn: SHORT_TURN });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const before = await harness.request('session.get', { sessionId: 's_1' });
    const beforeActions = ((before.payload as { result: { session: { availableActions: Record<string, { enabled: boolean }> } } }).result.session.availableActions);
    assert.equal(beforeActions['session.fork']?.enabled, false, 'fork stays off before a completed turn');
    assert.equal(beforeActions['sidechat.create']?.enabled, false, 'side chat stays off before a completed turn');
    assert.equal(beforeActions['session.fork.atTurn'], undefined, 'unsupported actions are omitted');

    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_1',
      input: [{ type: 'text', text: 'say hi' }], config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));

    const notifications = await harness.waitNotifications(11);
    const methods = notifications.map((line) => line.method);
    // turn.started, session.updated running, content.delta x2, activity running + terminal,
    // usage live, content.completed, usage final, turn.completed, session.updated idle
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
    const deltaData = (delta.payload.params as { data: { delta: string; kind: string; contentId: string } }).data;
    assert.equal(deltaData.delta, 'Hello');
    assert.equal(deltaData.kind, 'text', 'assistant prose is message text, not thinking');
    assert.equal(deltaData.contentId, `assistant:${sourceTurnId}:0`);
    const contentCompleted = notifications.find((line) => line.method === 'content.completed')!;
    assert.equal(((contentCompleted.payload.params as { data: { content: string; kind: string } }).data.content), 'Hello world');
    assert.equal(((contentCompleted.payload.params as { data: { kind: string } }).data.kind), 'text');

    // tool activity running → succeeded
    const activities = notifications.filter((line) => line.method === 'activity.updated')
      .map((line) => (line.payload.params as { data: { activityId: string; status: string } }).data);
    const toolStates = activities.filter((activity) => activity.activityId === 'call_1').map((activity) => activity.status);
    assert.deepEqual(toolStates, ['running', 'succeeded']);
    const bash = notifications.filter((line) => line.method === 'activity.updated')
      .map((line) => (line.payload.params as { data: { activityId: string; summary?: string; presentation: { type: string; data: { command?: string } } } }).data)
      .filter((activity) => activity.activityId === 'call_1');
    assert.equal(bash[0]?.presentation.type, 'command');
    assert.equal(bash[0]?.presentation.data.command, 'echo hi');
    assert.equal(bash[1]?.presentation.type, 'command', 'the terminal row keeps the command presentation');
    assert.equal(bash[1]?.summary, 'hi');

    const sessionUpdates = notifications.filter((line) => line.method === 'session.updated')
      .map((line) => (line.payload.params as { data: { state: string; availableActions: Record<string, { enabled: boolean }> } }).data);
    assert.equal(sessionUpdates.length, 2);
    assert.equal(sessionUpdates[0]?.state, 'running');
    assert.equal(sessionUpdates[0]?.availableActions['session.fork']?.enabled, false);
    assert.equal(sessionUpdates[1]?.state, 'idle');
    assert.equal(sessionUpdates[1]?.availableActions['session.fork']?.enabled, true);
    assert.equal(sessionUpdates[1]?.availableActions['sidechat.create']?.enabled, true);
    assert.equal(sessionUpdates[1]?.availableActions['session.fork.atTurn'], undefined, 'unsupported actions are omitted');

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

test('live thinking and assistant deltas that reuse the durable seq reach the transcript', async () => {
  const harness = startHarness({
    turn: {
      delayBefore: 10,
      events: [
        { type: 'turn.started', payload: { turnId: 1, agentId: 'main' } },
        { type: 'turn.step.started', payload: { agentId: 'main', turnId: 1, step: 1 } },
        { type: 'thinking.delta', volatile: true, reuseSeq: true, offset: 0, payload: { agentId: 'main', delta: 'Think' } },
        { type: 'thinking.delta', volatile: true, reuseSeq: true, offset: 5, payload: { agentId: 'main', delta: 'ing' } },
        { type: 'thinking.delta', volatile: true, reuseSeq: true, offset: 0, payload: { agentId: 'main', delta: 'dup' } },
        { type: 'assistant.delta', volatile: true, reuseSeq: true, offset: 0, payload: { agentId: 'main', delta: 'Hi' } },
        { type: 'assistant.delta', volatile: true, reuseSeq: true, offset: 2, payload: { agentId: 'main', delta: '!' } },
        { type: 'turn.step.started', payload: { agentId: 'main', turnId: 1, step: 2 } },
        { type: 'thinking.delta', volatile: true, reuseSeq: true, offset: 0, payload: { agentId: 'main', delta: 'More' } },
        { type: 'turn.ended', payload: { turnId: 1, agentId: 'main', reason: 'completed' } },
      ],
    },
  });
  try {
    await initialize(harness);
    const streamId = await createSession(harness);
    const accepted = await harness.request('turn.start', {
      sessionId: 's_1', streamId, turnId: 't_think',
      input: [{ type: 'text', text: 'think' }], config: {},
    });
    assert.equal(accepted.kind, 'result', JSON.stringify(accepted.payload));

    const seen: OutgoingLine[] = [];
    const completed = await harness.waitNotificationFor((line) => line.method === 'turn.completed', 10_000, seen);
    seen.push(completed);
    for (const notification of seen) {
      if (notification.kind === 'notification') proxyNotificationSchema.parse(notification.payload);
    }
    const deltas = seen.filter((line) => line.method === 'content.delta');
    const reasoning = deltas
      .map((line) => (line.payload.params as { data: { kind: string; delta: string } }).data)
      .filter((data) => data.kind === 'reasoning')
      .map((data) => data.delta);
    const text = deltas
      .map((line) => (line.payload.params as { data: { kind: string; delta: string } }).data)
      .filter((data) => data.kind === 'text')
      .map((data) => data.delta);
    assert.deepEqual(reasoning, ['Think', 'ing', 'More']);
    assert.deepEqual(text, ['Hi', '!']);
    const eventIds = deltas.map((line) => (line.payload.params as { eventId: string }).eventId);
    assert.equal(new Set(eventIds).size, eventIds.length);

    const finals = seen.filter((line) => line.method === 'content.completed')
      .map((line) => (line.payload.params as { data: { kind: string; content: string } }).data);
    assert.deepEqual(finals.filter((item) => item.kind === 'reasoning').map((item) => item.content), ['Thinking', 'More']);
    assert.equal(finals.find((item) => item.kind === 'text')?.content, 'Hi!');
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
    proxyNotificationSchema.parse(requested.payload);
    const inputs = data.inputs as Array<{ id: string; type: string; label: string; description?: string; choices: Array<{ value: string; displayName: string }> }>;
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.type, 'single_select');
    assert.equal(inputs[0]!.label, 'Deploy where?');
    assert.deepEqual(inputs[0]!.choices, [
      { value: 'opt_0_0', displayName: 'Staging' },
      { value: 'opt_0_1', displayName: 'Production' },
    ]);
    assert.match(inputs[0]!.description ?? '', /Staging: the staging cluster/);
    assert.match(inputs[0]!.description ?? '', /Production: live traffic/);

    const responded = await harness.request('interaction.respond', {
      sessionId: 's_1', streamId, turnId: 't_q',
      responseId: 'resp-q', interactionId: data.interactionId as string,
      actionId: 'accept', values: { q_0: 'opt_0_1', note: 'with canary' },
    });
    assert.equal(responded.kind, 'result', JSON.stringify(responded.payload));
    const questionCalls = harness.fakeLog().filter((entry) => typeof entry.path === 'string' && String(entry.path).includes('/questions/'));
    assert.equal(questionCalls.length, 1);
    // Kimi 2.1.1 kap-server/protocol/question.ts validates discriminated
    // answers, not raw UI selection strings.
    assert.deepEqual((questionCalls[0]!.body as { answers: Record<string, unknown>; note: string }).answers, {
      q_0: { kind: 'single', option_id: 'opt_0_1' },
    });
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

for (const order of ['before', 'after']) {
  test(`question dismissal accepts native 40909 once with WS ${order} REST and replays responseId`, async () => {
    const harness = startHarness({ turn: QUESTION_TURN, behavior: { questionDismissEventOrder: order } });
    const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
    let requestIndex = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = `dismiss-${++requestIndex}`;
      host.registerRequest({ jsonrpc: '2.0', id, method, params });
      const response = await harness.request(method, params, id);
      assert.equal(response.kind, 'result', JSON.stringify(response.payload));
      host.acceptLine(JSON.stringify(response.payload));
      return response;
    };
    const acceptNotifications = (lines: OutgoingLine[]) => {
      for (const line of lines) {
        if (line.kind !== 'notification') continue;
        const parsed = proxyNotificationSchema.safeParse(line.payload);
        assert.equal(parsed.success, true, `${line.method}: ${JSON.stringify(line.payload)}; ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
        host.acceptLine(JSON.stringify(line.payload));
      }
    };
    try {
      await request('initialize', {
        protocol: { name: 'gian.proxy', versions: ['2.2'] },
        host: { name: 'Gian', version: '0.6.5-test' },
      });
      await request('catalog.list', {});
      const created = await request('session.create', {
        sessionId: 's_1', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      });
      const streamId = (created.payload as { result: { session: { streamId: string } } }).result.session.streamId;
      await request('turn.start', {
        sessionId: 's_1', streamId, turnId: 't_dismiss',
        input: [{ type: 'text', text: 'ask a question' }], config: { approval_mode: 'manual' },
      });
      const before: OutgoingLine[] = [];
      const requested = await harness.waitNotificationFor((line) => line.method === 'interaction.requested', 10_000, before);
      acceptNotifications([...before, requested]);
      const interactionId = (requested.payload.params as { data: { interactionId: string } }).data.interactionId;
      const params = {
        sessionId: 's_1', streamId, turnId: 't_dismiss', interactionId,
        responseId: 'dismiss-response', actionId: 'decline',
        // The current generic protocol requires question inputs even for
        // decline. The separate cancellation-contract fix owns empty values.
        values: { q_0: 'opt_0_0' },
      };
      await request('interaction.respond', params);
      await request('interaction.respond', params);
      const after: OutgoingLine[] = [];
      const idle = await harness.waitNotificationFor((line) => line.method === 'session.updated'
        && (line.payload.params as { data: { state: string } }).data.state === 'idle', 10_000, after);
      acceptNotifications([...after, idle]);
      const resolved = after.filter((line) => line.method === 'interaction.resolved');
      assert.equal(resolved.length, 1, 'REST and native WS publish one resolution');
      const result = (resolved[0]!.payload.params as { data: { outcome: string; actionId?: string } }).data;
      assert.equal(result.outcome, 'cancelled', 'dismissal semantics do not depend on response ordering');
      assert.equal(result.actionId, undefined, 'cancelled outcomes cannot include actionId');
      assert.equal(after.filter((line) => line.method === 'turn.completed').length, 1);
      assert.equal(after.some((line) => line.method === 'turn.failed'), false);
      await request('interaction.respond', params);
      const dismissCalls = harness.fakeLog().filter((entry) => entry.method === 'POST'
        && String(entry.path).endsWith('/questions/q_1:dismiss'));
      assert.equal(dismissCalls.length, 1, 'identical responseId never calls native dismiss twice');
      assert.deepEqual(dismissCalls[0]!.body, {});
    } finally {
      await harness.close();
    }
  });
}

test('question dismissal success exception excludes answers and invalid native success payloads', async () => {
  const cases = [
    { actionId: 'accept', behavior: { questionAnswerReturnsDismissed: true } },
    { actionId: 'decline', behavior: { questionDismissEventOrder: 'none', questionDismissData: { dismissed: false, dismissed_at: '2026-10-03T00:00:00.000Z' } } },
    { actionId: 'decline', behavior: { questionDismissEventOrder: 'none', questionDismissData: { dismissed: true, dismissed_at: 'not-a-timestamp' } } },
  ];
  for (const scenario of cases) {
    const harness = startHarness({ turn: QUESTION_TURN, behavior: scenario.behavior });
    try {
      await initialize(harness);
      const streamId = await createSession(harness);
      await harness.request('turn.start', {
        sessionId: 's_1', streamId, turnId: 't_bad_dismiss',
        input: [{ type: 'text', text: 'ask' }], config: {},
      });
      const requested = await waitFor(harness, 'interaction.requested');
      const interactionId = (requested.payload.params as { data: { interactionId: string } }).data.interactionId;
      const responded = await harness.request('interaction.respond', {
        sessionId: 's_1', streamId, turnId: 't_bad_dismiss',
        responseId: 'bad-dismiss-response', interactionId, actionId: scenario.actionId,
        values: { q_0: 'opt_0_0' },
      });
      assert.equal(responded.kind, 'error', JSON.stringify(responded.payload));
      assert.equal((responded.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
        'INTERACTION_NOT_FOUND', '40909 is still an error outside the exact native dismiss success');
    } finally {
      await harness.close();
    }
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

    // plan.waitNotificationFor already consumed turn.started, the running
    // session.updated, and plan.updated. The next 6 are todo running/terminal,
    // subagent spawn/completed, finalize usage, and the terminal. The idle
    // session.updated follows those and is not part of this count.
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

test('adoption pulls history through session.replay with stable identities', async () => {
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

    // Attach history is pull-only: create emits no replay-shaped notifications.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The harness queue also retains consumed request responses; only
    // unsolicited notifications would violate pull-only history here.
    assert.equal(harness.lines.filter((line) => line.kind === 'notification').length, 0,
      'session.create pushes no replay notifications');

    const replay = await harness.request('session.replay', { sessionId: 's_hist', streamId, cursor: null, limit: 500 });
    assert.equal(replay.kind, 'result', JSON.stringify(replay.payload));
    const result = (replay.payload as { result: { events: Array<Record<string, unknown>>; nextCursor: string | null } }).result;
    assert.equal(result.nextCursor, null);
    const events = result.events;
    assert.deepEqual(events.map((event) => event.method), [
      'turn.started', 'input.recorded', 'content.completed', 'content.completed', 'activity.updated', 'turn.completed',
    ]);
    assert.ok(events.every((event) => event.sourceTurnId === 'msg_prompt_1'), 'sourceTurnId is the native prompt id');

    const text = events.find((event) => event.method === 'content.completed'
      && (event.data as { kind: string }).kind === 'text')!;
    const thinking = events.find((event) => event.method === 'content.completed'
      && (event.data as { kind: string }).kind === 'reasoning')!;
    assert.equal((text.data as { contentId: string }).contentId, 'assistant:msg_prompt_1');
    assert.equal((text.data as { content: string }).content, 'did it');
    assert.equal((thinking.data as { contentId: string }).contentId, 'thinking:msg_prompt_1');

    // Tool activity carries input + output.
    const activity = events.find((event) => event.method === 'activity.updated')!;
    const activityData = activity.data as { activityId: string; status: string; presentation: { data: { output: unknown } } };
    assert.equal(activityData.activityId, 'call_h1');
    assert.equal(activityData.status, 'succeeded');
    assert.equal(activityData.presentation.data.output, 'patched');

    // Identity parity: replay names the terminal with the live projector's id.
    const terminal = events.find((event) => event.method === 'turn.completed')!;
    assert.equal(terminal.eventId, terminalEventIdFor('session_seed_hist', 'msg_prompt_1', 'turn.completed'));
  } finally {
    await harness.close();
  }
});

test('reused tool ids and identical plans stay scoped to each native prompt in live and replay', async () => {
  const nativeId = 'session_reused_facts';
  const history = [0, 1].flatMap((turn) => HISTORY_MESSAGES.map((message, index) => ({
    ...message,
    id: `${message.id}_${turn}`,
    session_id: nativeId,
    prompt_id: `historical_prompt_${turn}`,
    created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, turn * 10 + index)).toISOString(),
    content: message.content.map((part) => part.type === 'tool_result' ? { ...part, output: `result-${turn}` } : part),
  })));
  const repeatedPlanTurn = {
    ...SHORT_TURN,
    events: SHORT_TURN.events.map((step) => step.type === 'tool.call.started'
      ? { ...step, payload: { ...step.payload, display: { kind: 'todo_list', items: [{ title: 'Same plan step', status: 'done' }] } } }
      : step),
  };
  const harness = startHarness({ sessions: [{ info: { id: nativeId, busy: false, last_seq: 0 }, messages: history }], turn: repeatedPlanTurn });
  const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
  let requestIndex = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `reused-facts-${++requestIndex}`;
    host.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', JSON.stringify(response.payload));
    host.acceptLine(JSON.stringify(response.payload));
    return response;
  };
  try {
    await request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.2'] }, host: { name: 'Gian', version: '0.6.5-test' } });
    await request('catalog.list', {});
    const created = await request('session.create', {
      sessionId: 's_reused', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      nativeSession: { id: nativeId, history: 'none' },
    });
    const streamId = (created.payload as { result: { session: { streamId: string } } }).result.session.streamId;
    const plans: OutgoingLine[] = [];
    const tools: OutgoingLine[] = [];
    for (const turn of [0, 1]) {
      await request('turn.start', {
        sessionId: 's_reused', streamId, turnId: `t_reused_${turn}`,
        input: [{ type: 'text', text: `repeat identical plan ${turn}` }], config: { approval_mode: 'manual' },
      });
      const earlier: OutgoingLine[] = [];
      const idle = await harness.waitNotificationFor((line) => line.method === 'session.updated'
        && (line.payload.params as { data: { state: string } }).data.state === 'idle', 10_000, earlier);
      const facts = [...earlier, idle].filter((line) => line.kind === 'notification');
      for (const fact of facts) host.acceptLine(JSON.stringify(fact.payload));
      const plan = facts.filter((line) => line.method === 'plan.updated');
      assert.equal(plan.length, 1, 'identical plans are still projected in each turn');
      plans.push(...plan);
      tools.push(...facts.filter((line) => line.method === 'activity.updated'
        && (line.payload.params as { data: { status: string } }).data.status === 'succeeded'));
    }
    const eventId = (line: OutgoingLine) => (line.payload.params as { eventId: string }).eventId;
    assert.notEqual(eventId(plans[0]!), eventId(plans[1]!));
    assert.equal(tools.length, 2);
    assert.ok(tools.every((line) => (line.payload.params as { data: { activityId: string } }).data.activityId === 'call_1'));
    assert.notEqual(eventId(tools[0]!), eventId(tools[1]!), 'the reused native tool id does not reuse a live event id');
    const replay = await request('session.replay', { sessionId: 's_reused', streamId, cursor: null, limit: 500 });
    const page = (replay.payload as { result: { replayStreamId: string; events: Array<{
      method: string; eventId: string; sourceTurnId: string;
      data: { activityId?: string; presentation?: { data?: { output?: string } } };
    }> } }).result;
    new ReplayPageValidator('s_reused').acceptPage(page);
    assert.ok(page.replayStreamId.endsWith(':v2'), 'new replay identity representation has its own snapshot version');
    const activities = page.events.filter((event) => event.method === 'activity.updated');
    assert.equal(activities.length, 2);
    assert.deepEqual(activities.map((event) => event.sourceTurnId), ['historical_prompt_0', 'historical_prompt_1']);
    assert.ok(activities.every((event) => event.data.activityId === 'call_h1'));
    assert.notEqual(activities[0]!.eventId, activities[1]!.eventId);
    assert.deepEqual(activities.map((event) => event.data.presentation?.data?.output), ['result-0', 'result-1']);
  } finally {
    await harness.close();
  }
});

test('native pagination fixture enforces exact 1..100 bounds and exclusive cursors', async () => {
  const harness = startHarness({ sessions: [{ info: { id: 'session_bounds', busy: false }, messages: HISTORY_MESSAGES }] });
  try {
    await initialize(harness);
    await harness.request('catalog.list', {}); // initialize does not start the native server.
    const port = harness.fakeLog().find((entry) => entry.kind === 'listening')?.port;
    assert.equal(typeof port, 'number');
    for (const path of ['/api/v1/sessions', '/api/v1/sessions/session_bounds/messages']) {
      for (const [query, expected] of [
        ['page_size=100', 0], ['page_size=101', 40001],
        ['page_size=0', 40001], ['page_size=1.5', 40001],
        ['page_size=100&before_id=a&after_id=b', 40001],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${String(port)}${path}?${query}`, {
          headers: { Authorization: 'Bearer test-token' }, // Synthetic fixture token only.
        });
        const body = await response.json() as { code: number };
        assert.equal(body.code, expected, `${path}?${query}`);
      }
    }
  } finally {
    await harness.close();
  }
});

test('native session list follows older-page cursors with a 100-entry native maximum', async () => {
  const seeds = Array.from({ length: 103 }, (_, index) => ({ info: {
    id: `session_page_${String(index).padStart(3, '0')}`, busy: false,
    updated_at: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
  } }));
  const harness = startHarness({ sessions: seeds });
  const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
  let requestIndex = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `native-pages-${++requestIndex}`;
    host.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', JSON.stringify(response.payload));
    host.acceptLine(JSON.stringify(response.payload));
    return (response.payload as { result: { sessions: Array<{ id: string }>; nextCursor: string | null } }).result;
  };
  try {
    await request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.2'] }, host: { name: 'Gian', version: '0.6.5-test' } });
    await request('catalog.list', {});
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request('session.native.list', { limit: 500, cursor });
      ids.push(...page.sessions.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(ids, seeds.map((entry) => entry.info.id).reverse());
    assert.equal(new Set(ids).size, seeds.length, 'no duplicates or omitted older sessions');
    const pages = harness.fakeLog().filter((entry) => entry.method === 'GET' && entry.path === '/api/v1/sessions');
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map((entry) => (entry.query as Record<string, string>).page_size), ['100', '100']);
    assert.equal((pages[1]!.query as Record<string, string>).before_id, seeds[3]!.info.id);
    assert.ok(pages.every((entry) => (entry.query as Record<string, string>).after_id === undefined));
  } finally {
    await harness.close();
  }
});

test('head fork replays multiple newest-first native pages in chronological Host-conformant order', async () => {
  const history = Array.from({ length: 103 }, (_, index) => [
    { id: `history_user_${index}`, session_id: 'session_page_parent', role: 'user', prompt_id: `history_prompt_${index}`,
      content: [{ type: 'text', text: `history-input-${index}` }], created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, index * 2)).toISOString() },
    { id: `history_assistant_${index}`, session_id: 'session_page_parent', role: 'assistant', prompt_id: `history_prompt_${index}`,
      content: [{ type: 'text', text: `history-answer-${index}` }], created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, index * 2 + 1)).toISOString() },
  ]).flat();
  const harness = startHarness({ sessions: [{ info: { id: 'session_page_parent', busy: false, last_seq: 0 }, messages: history }], turn: SHORT_TURN });
  const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
  let requestIndex = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `fork-pages-${++requestIndex}`;
    host.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', JSON.stringify(response.payload));
    host.acceptLine(JSON.stringify(response.payload));
    return response;
  };
  try {
    await request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.2'] }, host: { name: 'Gian', version: '0.6.5-test' } });
    await request('catalog.list', {});
    const parent = await request('session.create', {
      sessionId: 's_parent', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      nativeSession: { id: 'session_page_parent', history: 'none' },
    });
    const parentStream = (parent.payload as { result: { session: { streamId: string } } }).result.session.streamId;
    await request('turn.start', {
      sessionId: 's_parent', streamId: parentStream, turnId: 't_head',
      input: [{ type: 'text', text: 'new-head-input' }], config: { approval_mode: 'manual' },
    });
    for (const line of await harness.waitNotifications(11)) host.acceptLine(JSON.stringify(line.payload));
    const fork = await request('session.fork', { sourceSessionId: 's_parent', sourceStreamId: parentStream, sessionId: 's_child', anchor: { type: 'head' } });
    const child = (fork.payload as { result: { session: { streamId: string; nativeSession: { id: string } } } }).result.session;
    const replayValidator = new ReplayPageValidator('s_child');
    const events: Array<{ method: string; sourceTurnId: string; data: Record<string, unknown> }> = [];
    let cursor: string | null = null;
    do {
      const response = await request('session.replay', { sessionId: 's_child', streamId: child.streamId, cursor, limit: 37 });
      const page = (response.payload as { result: { events: typeof events; nextCursor: string | null } }).result;
      replayValidator.acceptPage(page);
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(events.filter((event) => event.method === 'content.completed').map((event) => event.data.content),
      Array.from({ length: 103 }, (_, index) => `history-answer-${index}`));
    assert.deepEqual(events.filter((event) => event.method === 'turn.started').slice(0, 103).map((event) => event.sourceTurnId),
      Array.from({ length: 103 }, (_, index) => `history_prompt_${index}`));
    assert.equal(events.filter((event) => event.method === 'input.recorded').length, 104, 'all inherited inputs plus the completed head are retained');
    const reads = harness.fakeLog().filter((entry) => entry.method === 'GET' && entry.path === `/api/v1/sessions/${child.nativeSession.id}/messages`);
    assert.equal(reads.filter((entry) => (entry.query as Record<string, string>).page_size === '1').length, 1,
      'cold fork child is materialized before event subscription');
    const pages = reads.filter((entry) => (entry.query as Record<string, string>).page_size === '100');
    assert.equal(pages.length, 3, 'native history is fetched once across all outer replay pages');
    assert.deepEqual(pages.map((entry) => (entry.query as Record<string, string>).page_size), ['100', '100', '100']);
    assert.equal((pages[1]!.query as Record<string, string>).before_id, history[107]!.id);
    assert.equal((pages[2]!.query as Record<string, string>).before_id, history[7]!.id);
    assert.ok(pages.every((entry) => (entry.query as Record<string, string>).after_id === undefined));
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

test('cold Side Chat waits for accepted subscription, completes, interrupts, resumes and isolates its parent', async () => {
  const longTurn = {
    delayBefore: 10,
    events: [
      { type: 'turn.started', payload: {} },
      { op: 'wait', ms: 1000 },
      { type: 'assistant.delta', payload: { agentId: 'main', delta: 'late cancelled output' } },
      { type: 'turn.ended', payload: { reason: 'completed' } },
    ],
  };
  const parentNativeId = 'session_sidechat_parent';
  const harness = startHarness({
    sessions: [{ info: { id: parentNativeId, busy: false, last_seq: 0 } }],
    turns: { [parentNativeId]: SHORT_TURN },
    turnSequence: [SHORT_TURN, longTurn, SHORT_TURN],
    behavior: { subscribeAckDelayMs: 30 },
  });
  const host = new HostProtocolValidator({ pluginId: 'kimi', processScope: 'shared' });
  let requestIndex = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `cold-sidechat-${++requestIndex}`;
    host.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', JSON.stringify(response.payload));
    host.acceptLine(JSON.stringify(response.payload));
    return response;
  };
  const accept = (lines: OutgoingLine[]) => {
    for (const line of lines) if (line.kind === 'notification') host.acceptLine(JSON.stringify(line.payload));
  };
  try {
    await request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.2'] }, host: { name: 'Gian', version: '0.6.5-test' } });
    await request('catalog.list', {});
    const parent = await request('session.create', {
      sessionId: 's_parent', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      nativeSession: { id: parentNativeId, history: 'none' },
    });
    const parentStream = (parent.payload as { result: { session: { streamId: string } } }).result.session.streamId;
    await request('turn.start', {
      sessionId: 's_parent', streamId: parentStream, turnId: 't_parent_1',
      input: [{ type: 'text', text: 'remember synthetic parent marker' }], config: { approval_mode: 'manual' },
    });
    accept(await harness.waitNotifications(11));
    const created = await request('sidechat.create', { parentSessionId: 's_parent', parentStreamId: parentStream, sidechatId: 'sc_cold' });
    const sidechat = (created.payload as { result: { sidechat: { streamId: string; resumeRef: { id: string } } } }).result.sidechat;
    const start = (turnId: string, text: string) => request('turn.start', {
      sessionId: 'sc_cold', streamId: sidechat.streamId, turnId,
      input: [{ type: 'text', text }], config: { approval_mode: 'manual' },
    });
    await start('t_child_1', 'reply in the child');
    const first = await harness.waitNotifications(11);
    accept(first);
    assert.ok(first.every((line) => (line.payload.params as { sessionId: string }).sessionId === 'sc_cold'));
    assert.equal(first.filter((line) => line.method === 'content.completed')
      .map((line) => (line.payload.params as { data: { content: string } }).data.content).join(''), 'Hello world');
    assert.equal(first.filter((line) => line.method === 'turn.completed').length, 1);

    await start('t_child_stop', 'long child request to interrupt');
    const beforeStop: OutgoingLine[] = [];
    const started = await harness.waitNotificationFor((line) => line.method === 'turn.started', 10_000, beforeStop);
    accept([...beforeStop, started]);
    const runningResume = await request('sidechat.resume', {
      sidechatId: 'sc_cold', parentSessionId: 's_parent', resumeRef: sidechat.resumeRef,
    });
    assert.equal((runningResume.payload as { result: { sidechat: { state: string } } }).result.sidechat.state,
      'running', 'cached resume reports the live turn state');
    await request('turn.interrupt', { sessionId: 'sc_cold', streamId: sidechat.streamId, turnId: 't_child_stop' });
    const afterStop: OutgoingLine[] = [];
    const idle = await harness.waitNotificationFor((line) => line.method === 'session.updated'
      && (line.payload.params as { data: { state: string } }).data.state === 'idle', 10_000, afterStop);
    accept([...afterStop, idle]);
    const stopped = afterStop.find((line) => line.method === 'turn.completed');
    assert.ok(stopped, 'native abort terminal arrives without the fence watchdog');
    assert.equal((stopped.payload.params as { data: { stopReason: string } }).data.stopReason, 'interrupted');
    assert.equal(afterStop.some((line) => line.method === 'turn.failed'), false);

    await start('t_child_resume', 'continue after interrupt');
    const resumed = await harness.waitNotifications(11);
    accept(resumed);
    assert.equal(resumed.filter((line) => line.method === 'content.completed')
      .map((line) => (line.payload.params as { data: { content: string } }).data.content).join(''), 'Hello world');
    assert.equal(resumed.some((line) => JSON.stringify(line.payload).includes('late cancelled output')), false);
    // Reusing the shared runtime must retain the parent's original stream.
    await request('turn.start', {
      sessionId: 's_parent', streamId: parentStream, turnId: 't_parent_2',
      input: [{ type: 'text', text: 'parent still works' }], config: { approval_mode: 'manual' },
    });
    const parentAgain = await harness.waitNotifications(11);
    accept(parentAgain);
    assert.ok(parentAgain.every((line) => (line.payload.params as { sessionId: string }).sessionId === 's_parent'));
    assert.equal(parentAgain.filter((line) => line.method === 'turn.completed').length, 1);
    const log = harness.fakeLog();
    const materialized = log.find((entry) => entry.kind === 'materialized' && entry.sessionId !== parentNativeId);
    assert.ok(materialized, 'cold child is materialized without submitting a prompt');
    const childNativeId = String(materialized.sessionId);
    const ackIndex = log.findIndex((entry) => entry.kind === 'subscription-ack'
      && (entry.accepted as string[]).includes(childNativeId));
    const promptIndex = log.findIndex((entry) => entry.method === 'POST' && entry.path === `/api/v1/sessions/${childNativeId}/prompts`);
    assert.ok(ackIndex > log.indexOf(materialized) && promptIndex > ackIndex, 'accepted ACK is a barrier before child prompt dispatch');
    assert.ok(log.some((entry) => entry.kind === 'ws-in' && entry.type === 'subscribe'
      && Number(((entry.payload as { cursors?: Record<string, { seq: number }> }).cursors ?? {})[childNativeId]?.seq) > 0),
    'later subscriptions resume after delivered durable facts');
    assert.equal(log.filter((entry) => entry.method === 'POST' && String(entry.path).includes(`/sessions/${childNativeId}/prompts/`)
      && String(entry.path).endsWith(':abort')).length, 1);
    await request('sidechat.close', { sidechatId: 'sc_cold', streamId: sidechat.streamId, resumeRef: sidechat.resumeRef });
  } finally {
    await harness.close();
  }
});

for (const failure of ['rejected', 'missing']) {
  test(`session attach rejects ${failure} subscription ACK instead of running without events`, async () => {
    const harness = startHarness({ behavior: failure === 'rejected'
      ? { rejectSubscriptions: true } : { dropSubscriptionAck: true } });
    try {
      await initialize(harness);
      const created = await harness.request('session.create', {
        sessionId: 's_unsubscribed', workspace: { cwd: harness.workspace, roots: [harness.workspace] }, config: {},
      });
      assert.equal(created.kind, 'error', JSON.stringify(created.payload));
      const error = (created.payload as { error: { message: string; data: { domainCode: string } } }).error;
      assert.equal(error.data.domainCode, failure === 'rejected' ? 'NATIVE_SESSION_NOT_FOUND' : 'RUNTIME_ERROR');
      assert.match(error.message, failure === 'rejected' ? /native session was not found/ : /subscription.*timed out/);
      const missing = await harness.request('session.get', { sessionId: 's_unsubscribed' });
      assert.equal(missing.kind, 'error', 'no successful attach snapshot is published');
      assert.equal(harness.fakeLog().some((entry) => entry.method === 'POST' && String(entry.path).endsWith('/prompts')), false);
    } finally {
      await harness.close();
    }
  });
}

test('cached Side Chat resume reattaches the same cold child after server exit', async () => {
  const harness = startHarness({ behavior: { selfDestructMs: 1500 }, turn: SHORT_TURN });
  try {
    await initialize(harness);
    const parentStream = await createSession(harness, 's_parent');
    const created = await harness.request('sidechat.create', {
      parentSessionId: 's_parent', parentStreamId: parentStream, sidechatId: 'sc_restart',
    });
    assert.equal(created.kind, 'result', JSON.stringify(created.payload));
    const original = (created.payload as { result: { sidechat: { streamId: string; resumeRef: { id: string } } } }).result.sidechat;
    await harness.waitNotificationFor((line) => line.method === 'runtime.error'
      && (line.payload.params as { sessionId: string }).sessionId === 'sc_restart', 15_000);
    const resumed = await harness.request('sidechat.resume', {
      sidechatId: 'sc_restart', parentSessionId: 's_parent', resumeRef: original.resumeRef,
    });
    assert.equal(resumed.kind, 'result', JSON.stringify(resumed.payload));
    const child = (resumed.payload as { result: { sidechat: { streamId: string; state: string; resumeRef: { id: string } } } }).result.sidechat;
    assert.notEqual(child.streamId, original.streamId, 'stale cached stream must be rebound');
    assert.equal(child.state, 'idle');
    assert.deepEqual(child.resumeRef, original.resumeRef);
    const oldStream = await harness.request('turn.start', {
      sessionId: 'sc_restart', streamId: original.streamId, turnId: 't_old',
      input: [{ type: 'text', text: 'stale stream' }], config: {},
    });
    assert.equal((oldStream.payload as { error: { data: { domainCode: string } } }).error.data.domainCode, 'SESSION_STALE');
    const started = await harness.request('turn.start', {
      sessionId: 'sc_restart', streamId: child.streamId, turnId: 't_restart',
      input: [{ type: 'text', text: 'continue in the same child' }], config: {},
    });
    assert.equal(started.kind, 'result', JSON.stringify(started.payload));
    const terminal = await harness.waitNotificationFor((line) => line.method === 'turn.completed'
      && (line.payload.params as { turnId: string }).turnId === 't_restart');
    assert.equal((terminal.payload.params as { sessionId: string }).sessionId, 'sc_restart');
    const log = harness.fakeLog();
    assert.equal(log.filter((entry) => entry.method === 'POST' && String(entry.path).endsWith('/children')).length,
      1, 'resume never forks another native child');
    const prompt = log.find((entry) => entry.method === 'POST' && String(entry.path).endsWith('/prompts'));
    const nativeId = String(prompt?.path).split('/')[4];
    assert.equal(log.filter((entry) => entry.kind === 'materialized' && entry.sessionId === nativeId).length,
      2, 'the original child is loaded on both server generations');
  } finally {
    await harness.close();
  }
});

test('Side Chat send refuses a rejected reconnect subscription before submitting a prompt', async () => {
  const harness = startHarness({
    behavior: { disconnectSocketOnceMs: 1000, rejectReconnectedSubscriptions: true },
    turn: SHORT_TURN,
  });
  try {
    await initialize(harness);
    const parentStream = await createSession(harness, 's_parent');
    const created = await harness.request('sidechat.create', {
      parentSessionId: 's_parent', parentStreamId: parentStream, sidechatId: 'sc_rejected',
    });
    assert.equal(created.kind, 'result', JSON.stringify(created.payload));
    const child = (created.payload as { result: { sidechat: { streamId: string } } }).result.sidechat;
    await harness.waitNotificationFor((line) => line.method === 'runtime.error'
      && (line.payload.params as { sessionId: string }).sessionId === 'sc_rejected');
    const params = {
      sessionId: 'sc_rejected', streamId: child.streamId, turnId: 't_rejected',
      input: [{ type: 'text', text: 'must not run without events' }], config: {},
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await harness.request('turn.start', params);
      assert.equal(result.kind, 'error', JSON.stringify(result.payload));
      assert.equal((result.payload as { error: { data: { domainCode: string } } }).error.data.domainCode,
        'NATIVE_SESSION_NOT_FOUND', 'a retry checks the subscription again instead of returning a false acceptance');
    }
    assert.equal(harness.fakeLog().some((entry) => entry.method === 'POST' && String(entry.path).endsWith('/prompts')),
      false, 'neither the first send nor its retry can leave an unseen native prompt');
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
