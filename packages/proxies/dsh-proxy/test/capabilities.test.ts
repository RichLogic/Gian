/**
 * Capability completion suite for the gian.proxy projection: capability
 * narrowing from bridge facts, strict steering, native fork, native session
 * list, responseId idempotency, plan/diff projections, live/replay identity
 * parity, and shared-runtime crash terminalization — zero model calls.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DshV2Adapter } from '../src/protocol/v2-adapter.js';
import { DshProxyService, diffsFromMeta, unifiedDiff } from '../src/core/service.js';

interface FakeBridge {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void): () => void;
  push(method: string, params: Record<string, unknown>): void;
  onExit?(listener: () => void): () => void;
  exits?: Array<() => void>;
  calls?: Array<{ method: string; params: Record<string, unknown> }>;
}

const BRIDGE_CAPS = {
  'session.events.read': 1,
  'session.fork': 1,
  'session.native.list': 1,
  'turn.interrupt': 1,
  'turn.steer': 1,
  'input.attachments': 1,
  'input.skill': 1,
  'customization.skill': 1,
  interaction: 1,
  'event.step': 1,
  'event.request': 1,
  'event.usage': 1,
};

function catalogPayload() {
  return {
    catalogRevision: 'fake-1',
    providers: [{ id: 'deepseek', label: 'DeepSeek' }],
    defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    models: [{ id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' }],
    input: [{ type: 'text' }, { type: 'localFile' }, { type: 'localImage' }, { type: 'skill' }],
    permissionPresets: [
      { id: 'workspace-write', label: 'Workspace Write', approvalPolicy: 'ask' },
    ],
    defaultPermissionPreset: 'workspace-write',
  };
}

function fakeBridge(options: {
  formatVersion?: number;
  capabilities?: Record<string, number>;
} = {}): FakeBridge {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  const exits: Array<() => void> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sessionCount = 0;
  const sessions = new Map<string, {
    nativeId: string;
    openTurn: number | null;
    turns: number;
    steers: Array<Record<string, unknown>>;
  }>();
  return {
    calls,
    exits,
    onExit(listener) {
      exits.push(listener);
      return () => exits.splice(exits.indexOf(listener), 1);
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(method, params) {
      for (const listener of listeners) listener({ method, params });
    },
    async request(method, params) {
      calls.push({ method, params });
      switch (method) {
        case 'initialize':
          return {
            protocol: { name: 'gian.dsh.bridge', version: '1.0' },
            plugin: { id: 'ai.deepseek.harness', bundle: '@gian/dsh-bridge', version: '0.1.6' },
            runtime: {
              id: 'deepseek-harness',
              package: '@deepseek-ai/dsh',
              version: '0.2.0-rc.2',
              sessionFormatVersion: options.formatVersion ?? 4,
            },
            capabilities: options.capabilities ?? BRIDGE_CAPS,
          };
        case 'catalog.list':
        case 'catalog.resolve':
          return { ...catalogPayload(), resolvedDefaults: { sessionConfig: {}, turnConfig: {} } };
        case 'session.create': {
          sessionCount += 1;
          const nativeId = `native-${sessionCount}`;
          sessions.set(String(params.sessionId), {
            nativeId, openTurn: null, turns: 0, steers: [],
          });
          return {
            session: {
              id: params.sessionId, nativeId, cwd: '/tmp/p', roots: ['/tmp/p'],
              state: 'idle', config: {}, createdAt: new Date().toISOString(),
            },
          };
        }
        case 'session.fork': {
          sessionCount += 1;
          const source = sessions.get(String(params.sessionId));
          assert.ok(source, 'fork source must exist');
          if (params.anchor && (params.anchor as { kind?: string }).kind === 'turn'
            && (params.anchor as { nativeTurn?: number }).nativeTurn === 99) {
            throw Object.assign(
              new Error('FORK_BOUNDARY_UNAVAILABLE: no verifiable turn/end boundary'),
              { domainCode: 'FORK_BOUNDARY_UNAVAILABLE' },
            );
          }
          const childNativeId = `native-${sessionCount}`;
          sessions.set(String(params.newSessionId), {
            nativeId: childNativeId, openTurn: null, turns: source.turns, steers: [],
          });
          return {
            session: {
              id: params.newSessionId, nativeId: childNativeId, cwd: '/tmp/p', roots: ['/tmp/p'],
              state: 'idle', config: {}, createdAt: new Date().toISOString(),
            },
            parentNativeId: source.nativeId,
            atSeq: 7,
            seedEventCount: 8,
            inheritedEventCount: 8,
          };
        }
        case 'session.native.list':
          return {
            sessions: [{ id: 'native-1', cwd: '/tmp/p', updatedAt: new Date().toISOString() }],
            nextCursor: null,
          };
        case 'session.events.read':
          return { sessionId: params.sessionId, formatVersion: 4, events: [], cursor: null };
        case 'turn.start': {
          const state = sessions.get(String(params.sessionId));
          assert.ok(state);
          const turn = state.turns;
          state.turns += 1;
          state.openTurn = turn;
          for (const listener of listeners) {
            listener({ method: 'session.event', params: {
              sessionId: params.sessionId, nativeSeq: state.turns * 10, type: 'turn/start', data: { turn },
            } });
            listener({ method: 'agent.status', params: {
              sessionId: params.sessionId, nativeId: state.nativeId, status: 'running', turn,
            } });
          }
          return { accepted: true };
        }
        case 'turn.steer': {
          const state = sessions.get(String(params.sessionId));
          assert.ok(state);
          assert.notEqual(state.openTurn, null, 'bridge refuses steering without an open turn');
          state.steers.push(params.input as Record<string, unknown>);
          return { accepted: true, openTurn: state.openTurn };
        }
        case 'turn.end': {
          const state = sessions.get(String(params.sessionId));
          if (state) state.openTurn = null;
          return { accepted: true };
        }
        case 'session.close': {
          sessions.delete(String(params.sessionId));
          return { ok: true };
        }
        case 'interaction.respond':
          return { accepted: true };
        case 'customization.list':
          return {
            kind: params.kind,
            status: params.kind === 'skill' ? 'ok' : 'provider_unsupported',
            completeness: params.kind === 'skill' ? 'effective' : 'none',
            observedAt: new Date().toISOString(),
            items: params.kind === 'skill' ? [{ id: 'ci1_x', kind: 'skill', name: 'x' }] : [],
            truncated: false,
            diagnostics: [],
          };
        case 'shutdown':
          return { ok: true };
        default:
          throw new Error(`fake bridge unknown method ${method}`);
      }
    },
  };
}

async function setup(bridge: FakeBridge, protocol: '2.1' | '2.3' = '2.1') {
  const adapter = new DshV2Adapter(bridge as never, { pluginVersion: '0.3.2' });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  adapter.setEmitSink((method, params) => notifications.push({ method, params }));
  const init = await adapter.dispatch({
    id: 'init', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: [protocol] }, host: { name: 'Gian', version: '1.0.0' } },
  });
  assert.equal(init.ok, true);
  const create = await adapter.dispatch({
    id: 'create', method: 'session.create',
    params: { sessionId: 's1', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: {} },
  });
  assert.equal(create.ok, true);
  const streamId = (create.result as { session: { streamId: string } }).session.streamId;
  return { adapter, notifications, streamId };
}

/* ------------------------------ Capabilities ------------------------------ */

test('capabilities narrow to exactly what the connected bridge verified', async () => {
  const adapter = new DshV2Adapter(fakeBridge() as never, { pluginVersion: '0.3.2' });
  adapter.setEmitSink(() => undefined);
  const init = await adapter.dispatch({
    id: 'i', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1' } },
  });
  const caps = (init.result as { capabilities: Record<string, number> }).capabilities;
  assert.equal(caps['turn.steer'], 1);
  assert.equal(caps['input.localFile'], 1);
  assert.equal(caps['input.localImage'], 1);
  assert.equal(caps['input.skill'], 1);
  assert.equal(caps['session.fork'], 1);
  assert.equal(caps['session.fork.atTurn'], 1);
  assert.equal(caps['sidechat'], 1);
  assert.equal(caps['session.native.list'], 1);
  assert.equal(caps['event.plan'], 1);
  assert.equal(caps['event.diff'], 1);
  assert.equal(caps['session.rename'], undefined);
  assert.equal(caps['session.native.delete'], undefined);
  assert.equal(caps['integration.mcp.streamableHttp'], undefined);
});

test('older session formats keep structured plan/diff unadvertised', async () => {
  for (const formatVersion of [0, 3]) {
    const adapter = new DshV2Adapter(fakeBridge({ formatVersion }) as never, { pluginVersion: '0.3.2' });
    adapter.setEmitSink(() => undefined);
    const init = await adapter.dispatch({
      id: 'i', method: 'initialize',
      params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1' } },
    });
    const caps = (init.result as { capabilities: Record<string, number> }).capabilities;
    assert.equal(caps['event.plan'], undefined, `format ${formatVersion}`);
    assert.equal(caps['event.diff'], undefined, `format ${formatVersion}`);
  }
});

/* -------------------------------- Steering -------------------------------- */

test('turn.steer only applies to the active turn and retried input stays idempotent', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  const noTurn = await adapter.dispatch({
    id: 's0', method: 'turn.steer',
    params: { sessionId: 's1', streamId, turnId: 'ghost', input: [{ type: 'text', text: 'x' }] },
  });
  assert.equal(noTurn.error?.data?.domainCode, 'TURN_NOT_FOUND');
  const steerParams = { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'left' }] };
  const first = await adapter.dispatch({ id: 's1', method: 'turn.steer', params: steerParams });
  assert.equal(first.ok, true);
  const retry = await adapter.dispatch({ id: 's2', method: 'turn.steer', params: steerParams });
  assert.equal(retry.ok, true);
  const fresh = await adapter.dispatch({
    id: 's3', method: 'turn.steer',
    params: { ...steerParams, input: [{ type: 'text', text: 'right' }] },
  });
  assert.equal(fresh.ok, true);
  const steerCalls = bridge.calls!.filter(call => call.method === 'turn.steer');
  assert.equal(steerCalls.length, 2, 'identical retry is absorbed; new content delivers again');
});

/* ------------------------------ Fork and list ----------------------------- */

test('session.fork attaches the child with native lineage and reports the origin', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  // Close the native turn so a head fork has a verifiable anchor.
  bridge.push('session.event', {
    sessionId: 's1', nativeSeq: 99, type: 'turn/end',
    data: { turn: 0, reason: { kind: 'completed' } },
  });
  bridge.calls!.length = 0;
  const forked = await adapter.dispatch({
    id: 'f', method: 'session.fork',
    params: {
      sourceSessionId: 's1', sourceStreamId: streamId, sessionId: 'fork-1',
      anchor: { type: 'head' },
    },
  });
  assert.equal(forked.ok, true);
  const result = forked.result as {
    session: { id: string; nativeSession: { id: string } };
    origin: { kind: string; sessionId: string; turnId: string; sourceTurnId: string };
  };
  assert.equal(result.session.id, 'fork-1');
  assert.equal(result.origin.kind, 'fork');
  assert.equal(result.origin.sessionId, 's1');
  const forkCall = bridge.calls!.find(call => call.method === 'session.fork');
  assert.deepEqual(forkCall?.params.anchor, { kind: 'head' });
});

test('turn-anchored fork resolves sourceTurnId to a native turn and refuses unknown bounds', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  const anchored = await adapter.dispatch({
    id: 'f', method: 'session.fork',
    params: {
      sourceSessionId: 's1', sourceStreamId: streamId, sessionId: 'fork-at',
      anchor: { type: 'turn', turnId: 'turn-1', sourceTurnId: 'native-1:turn:0' },
    },
  });
  assert.equal(anchored.ok, true);
  const foreign = await adapter.dispatch({
    id: 'f2', method: 'session.fork',
    params: {
      sourceSessionId: 's1', sourceStreamId: streamId, sessionId: 'fork-foreign',
      anchor: { type: 'turn', turnId: 'turn-1', sourceTurnId: 'other-native:turn:0' },
    },
  });
  assert.equal(foreign.error?.data?.domainCode, 'FORK_BOUNDARY_UNAVAILABLE');
  const unknown = await adapter.dispatch({
    id: 'f3', method: 'session.fork',
    params: {
      sourceSessionId: 's1', sourceStreamId: streamId, sessionId: 'fork-unknown',
      anchor: { type: 'turn', turnId: 'turn-1', sourceTurnId: 'native-1:turn:99' },
    },
  });
  assert.equal(unknown.error?.data?.domainCode, 'FORK_BOUNDARY_UNAVAILABLE');
});

test('session.native.list is advertised from the bridge and rename/delete stay refused', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  const list = await adapter.dispatch({
    id: 'l', method: 'session.native.list', params: { limit: 50 },
  });
  assert.equal(list.ok, true);
  assert.equal((list.result as { sessions: unknown[] }).sessions.length, 1);
  for (const method of ['session.rename', 'session.native.delete']) {
    const refused = await adapter.dispatch({
      id: `x-${method}`, method, params: { sessionId: 's1', streamId, name: 'n', nativeSessionId: 'n' },
    });
    assert.equal(refused.error?.data?.domainCode, 'CAPABILITY_NOT_SUPPORTED');
  }
  const narrow = new DshV2Adapter(fakeBridge({ capabilities: { 'session.events.read': 1 } }) as never, { pluginVersion: '0.3.2' });
  narrow.setEmitSink(() => undefined);
  await narrow.dispatch({
    id: 'i', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1' } },
  });
  const gate = await narrow.dispatch({ id: 'l2', method: 'session.native.list', params: {} });
  assert.equal(gate.error?.data?.domainCode, 'CAPABILITY_NOT_SUPPORTED');
});

/* --------------------------- Interaction idempotency ---------------------- */

test('identical responseId replays are absorbed and changed answers conflict', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  bridge.push('interaction.requested', {
    sessionId: 's1', interactionId: 'ix-1', kind: 'approval', title: 'Approve bash',
    inputs: [], actions: [{ id: 'allow-once', label: 'Allow', style: 'primary' }],
  });
  const respond = { sessionId: 's1', streamId, turnId: 'turn-1', interactionId: 'ix-1', actionId: 'allow-once', responseId: 'resp-1', values: {} };
  const first = await adapter.dispatch({ id: 'r1', method: 'interaction.respond', params: respond });
  assert.equal(first.ok, true);
  const retry = await adapter.dispatch({ id: 'r2', method: 'interaction.respond', params: respond });
  assert.equal(retry.ok, true);
  assert.equal((retry.result as { accepted: boolean }).accepted, true);
  const conflict = await adapter.dispatch({
    id: 'r3', method: 'interaction.respond',
    params: { ...respond, actionId: 'reject' },
  });
  assert.equal(conflict.error?.data?.domainCode, 'CONFLICT');
});

/* ------------------------------- Plan and diff ---------------------------- */

test('todo/write projects plan.updated with a stable planId and durable step ids', async () => {
  const bridge = fakeBridge();
  const { adapter, notifications, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  bridge.push('session.event', {
    sessionId: 's1', nativeSeq: 4, type: 'todo/write',
    data: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }] },
  });
  bridge.push('session.event', {
    sessionId: 's1', nativeSeq: 5, type: 'todo/write',
    data: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'completed' }] },
  });
  const plans = notifications.filter(event => event.method === 'plan.updated');
  assert.equal(plans.length, 2);
  const first = plans[0]!.params.data as { planId: string; steps: Array<{ id: string; status: string }> };
  const second = plans[1]!.params.data as { planId: string; steps: Array<{ id: string; status: string }> };
  assert.equal(first.planId, `plan-native-1`);
  assert.equal(second.planId, first.planId);
  assert.deepEqual(first.steps.map(step => step.id), second.steps.map(step => step.id));
  assert.equal(first.steps[1]?.status, 'in_progress');
  assert.equal(second.steps[1]?.status, 'completed');
});

test('tool/result meta projects diff.updated with stable diffId and file statuses', async () => {
  const bridge = fakeBridge();
  const { adapter, notifications, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  bridge.push('session.event', {
    sessionId: 's1', nativeSeq: 6, type: 'tool/result',
    data: {
      turn: 0, step: 0,
      message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
      meta: { diffs: [
        { path: 'a.txt', oldText: 'one\n', newText: 'ONE\n' },
        { path: 'new.txt', oldText: null, newText: 'created\n' },
      ] },
    },
  });
  const diffs = notifications.filter(event => event.method === 'diff.updated');
  assert.equal(diffs.length, 2);
  const first = diffs[0]!.params.data as { diffId: string; diff: string; truncated: boolean; files: Array<{ path: string; status: string }> };
  const second = diffs[1]!.params.data as { diffId: string; files: Array<{ path: string; status: string }> };
  assert.equal(first.files[0]?.status, 'modified');
  assert.equal(second.files[0]?.status, 'added');
  assert.match(first.diff, /^--- a\/a\.txt/);
  assert.equal(first.truncated, false);
  assert.notEqual(first.diffId, second.diffId);
});

test('tool results without diff meta never fabricate a diff', () => {
  assert.equal(diffsFromMeta(undefined), null);
  assert.equal(diffsFromMeta({ diffs: [] }), null);
  assert.equal(diffsFromMeta({ diffs: [{ path: 'x' }] }), null);
  const diffs = diffsFromMeta({ diffs: [{ path: 'x', oldText: null, newText: 'y' }] });
  assert.equal(diffs?.length, 1);
  assert.match(unifiedDiff(diffs![0]!), /\+y/);
});

/* --------------------------- Crash terminalization ------------------------ */

test('runtime exit fails open turns, settles interactions as runtime_ended, and errors sessions', async () => {
  const bridge = fakeBridge();
  const { adapter, notifications, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  bridge.push('interaction.requested', {
    sessionId: 's1', interactionId: 'ix-crash', kind: 'approval', title: 'Approve',
    inputs: [], actions: [{ id: 'allow-once', label: 'Allow', style: 'primary' }],
  });
  for (const exit of bridge.exits ?? []) exit();
  const failed = notifications.find(event => event.method === 'turn.failed');
  assert.ok(failed, 'the open turn must reach a terminal failure');
  const error = failed.params.data as { error: { domainCode: string; details: { runtimeExited: boolean } } };
  assert.equal(error.error.domainCode, 'RUNTIME_ERROR');
  assert.equal(error.error.details.runtimeExited, true);
  const resolved = notifications.find(event => event.method === 'interaction.resolved');
  assert.equal((resolved?.params.data as { outcome: string }).outcome, 'runtime_ended');
  const updated = notifications.filter(event => event.method === 'session.updated');
  const last = updated[updated.length - 1]?.params.data as { state: string };
  assert.equal(last.state, 'error');
});

/* --------------------------- Live/replay identity ------------------------- */

test('replay projects durable events with live-identical content and usage identity', async () => {
  const bridge = fakeBridge();
  const { adapter, streamId } = await setup(bridge);
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  (bridge as unknown as {
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }).request = async (method, params) => {
    if (method === 'session.events.read') {
      return {
        sessionId: params.sessionId, formatVersion: 4,
        events: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
          { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
          { type: 'assistant/message', seq: 2, time: 3, data: {
            turn: 0, step: 0,
            message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
            usage: { inputTokens: 5, outputTokens: 2 },
          } },
          { type: 'todo/write', seq: 3, time: 4, data: { todos: [{ content: 'Only step', status: 'pending' }] } },
          { type: 'tool/result', seq: 4, time: 5, data: {
            turn: 0, step: 0,
            message: { role: 'tool', content: [] },
            meta: { diffs: [{ path: 'z.txt', oldText: null, newText: 'hi\n' }] },
          } },
          { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'no' } } },
          { type: 'turn/end', seq: 6, time: 7, data: { turn: 0, reason: { kind: 'completed' } } },
        ],
        cursor: null,
      };
    }
    throw new Error(`unexpected replay-time bridge method ${method} (${String(params.sessionId)})`);
  };
  const replay = await adapter.dispatch({
    id: 'rp', method: 'session.replay',
    params: { sessionId: 's1', streamId, cursor: null, limit: 100 },
  });
  assert.equal(replay.ok, true);
  const events = (replay.result as { events: Array<{ method: string; data: Record<string, unknown> }> }).events;
  const methods = events.map(event => event.method);
  assert.ok(methods.includes('turn.started'));
  assert.ok(methods.includes('content.completed'));
  assert.equal(methods.includes('content.delta'), false, 'transient chunks are never replayed');
  assert.ok(methods.includes('plan.updated'));
  assert.ok(methods.includes('diff.updated'));
  assert.ok(methods.includes('turn.completed'));
  const content = events.find(event => event.method === 'content.completed')!.data as { contentId: string; content: string };
  assert.equal(content.content, 'answer');
  assert.match(content.contentId, /^assistant-native-1:turn:0:step:0$/);
  const plan = events.find(event => event.method === 'plan.updated')!.data as { planId: string };
  assert.equal(plan.planId, 'plan-native-1');
});
