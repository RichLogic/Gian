/**
 * Side Chat contract suite for the gian.proxy projection: capability gating,
 * idle-only anchors (turn/empty), verbatim config inheritance, method-matrix
 * isolation, sealed-ref resume across a proxy restart, and the close barrier
 * with honest providerDataDeleted convergence — zero model calls.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { resultSchemas } from '@gian/proxy-protocol';

import { DshV2Adapter } from '../src/protocol/v2-adapter.js';

interface FakeBridge {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void): () => void;
  push(method: string, params: Record<string, unknown>): void;
  calls?: Array<{ method: string; params: Record<string, unknown> }>;
}

/** Native sessions of the DSH profile: the disk state a new bridge resumes. */
type NativeStore = Map<string, { cwd: string; roots: string[] }>;

const FORK_CAPS = {
  'session.events.read': 1,
  'session.fork': 1,
  'turn.interrupt': 1,
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
    input: [{ type: 'text' }],
    agentPresets: [{ id: 'coder', label: 'Coder' }],
    defaultAgentPreset: 'coder',
  };
}

function fakeBridge(options: {
  capabilities?: Record<string, number>;
  /** Share the native-session store across "bridge processes". */
  store?: NativeStore;
} = {}): FakeBridge {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let sessionCount = 0;
  const sessions = new Map<string, { nativeId: string; openTurn: number | null; turns: number }>();
  const nativeSessions: NativeStore = options.store ?? new Map();
  return {
    calls,
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
              sessionFormatVersion: 4,
            },
            capabilities: options.capabilities ?? FORK_CAPS,
          };
        case 'catalog.list':
        case 'catalog.resolve':
          return { ...catalogPayload(), resolvedDefaults: { sessionConfig: {}, turnConfig: {} } };
        case 'session.create': {
          sessionCount += 1;
          const nativeId = `native-${sessionCount}`;
          sessions.set(String(params.sessionId), { nativeId, openTurn: null, turns: 0 });
          nativeSessions.set(nativeId, { cwd: '/tmp/p', roots: ['/tmp/p'] });
          return {
            session: {
              id: params.sessionId, nativeId, cwd: '/tmp/p', roots: ['/tmp/p'],
              state: 'idle', config: {}, createdAt: new Date().toISOString(),
            },
          };
        }
        case 'session.resume': {
          const known = nativeSessions.get(String(params.nativeSessionId));
          assert.ok(known, 'resumed native session must exist');
          if (sessions.has(String(params.sessionId))) {
            throw new Error(`CONFLICT: fake session ${params.sessionId} already exists`);
          }
          sessions.set(String(params.sessionId), {
            nativeId: String(params.nativeSessionId), openTurn: null, turns: 0,
          });
          return {
            session: {
              id: params.sessionId, nativeId: params.nativeSessionId,
              cwd: known.cwd, roots: known.roots,
              state: 'idle', config: {}, createdAt: new Date().toISOString(),
            },
          };
        }
        case 'session.fork': {
          const source = sessions.get(String(params.sessionId));
          assert.ok(source, 'fork source must exist');
          sessionCount += 1;
          const childNativeId = `native-${sessionCount}`;
          sessions.set(String(params.newSessionId), {
            nativeId: childNativeId, openTurn: null, turns: source.turns,
          });
          nativeSessions.set(childNativeId, { cwd: '/tmp/p', roots: ['/tmp/p'] });
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
        case 'session.close': {
          sessions.delete(String(params.sessionId));
          return { ok: true };
        }
        case 'interaction.respond':
          return { accepted: true };
        case 'shutdown':
          return { ok: true };
        default:
          throw new Error(`fake bridge unknown method ${method}`);
      }
    },
  };
}

async function setup(bridge: FakeBridge, sessionConfig: Record<string, string | boolean | number | null> = {}) {
  const adapter = new DshV2Adapter(bridge as never, { pluginVersion: '0.3.2' });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  adapter.setEmitSink((method, params) => notifications.push({ method, params }));
  const init = await adapter.dispatch({
    id: 'init', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1.0.0' } },
  });
  assert.equal(init.ok, true);
  const create = await adapter.dispatch({
    id: 'create', method: 'session.create',
    params: { sessionId: 's1', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: sessionConfig },
  });
  assert.equal(create.ok, true);
  const streamId = (create.result as { session: { streamId: string } }).session.streamId;
  return { adapter, notifications, streamId };
}

type SidechatSnapshot = {
  id: string;
  parentSessionId: string;
  streamId: string;
  state: string;
  resumeRef: { id: string };
  anchor: { type: string; turnId?: string; sourceTurnId?: string };
  sessionConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function sidechat(result: unknown): SidechatSnapshot {
  return (result as { sidechat: SidechatSnapshot }).sidechat;
}

async function completeParentTurn(bridge: FakeBridge, adapter: DshV2Adapter, streamId: string): Promise<void> {
  await adapter.dispatch({
    id: 't', method: 'turn.start',
    params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
  });
  bridge.push('session.event', {
    sessionId: 's1', nativeSeq: 99, type: 'turn/end',
    data: { turn: 0, reason: { kind: 'completed' } },
  });
}

describe('sidechat capability gating', () => {
  it('rides on the verified bridge fork surface and gates the method', async () => {
    const narrow = new DshV2Adapter(
      fakeBridge({ capabilities: { 'session.events.read': 1 } }) as never,
      { pluginVersion: '0.3.2' },
    );
    narrow.setEmitSink(() => undefined);
    const init = await narrow.dispatch({
      id: 'i', method: 'initialize',
      params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1' } },
    });
    const caps = (init.result as { capabilities: Record<string, number> }).capabilities;
    assert.equal(caps['sidechat'], undefined);
    const refused = await narrow.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: 'st', sidechatId: 'sc1' },
    });
    assert.equal(refused.error?.data?.domainCode, 'CAPABILITY_NOT_SUPPORTED');
  });

  it('catalog marks sidechat.create supported only with the capability', async () => {
    const supported = new DshV2Adapter(fakeBridge() as never, { pluginVersion: '0.3.2' });
    supported.setEmitSink(() => undefined);
    await supported.dispatch({
      id: 'i', method: 'initialize',
      params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1' } },
    });
    const catalog = resultSchemas['catalog.list'].parse(
      (await supported.dispatch({ id: 'c', method: 'catalog.list', params: {} })).result,
    );
    const action = catalog.actions?.find(entry => entry.id === 'sidechat.create');
    assert.equal(action?.supported, true);
    assert.equal(action?.reason, undefined);
  });
});

describe('sidechat.create', () => {
  it('anchors on the latest terminal turn with the native cut and inherits config verbatim', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge, { agent_preset: 'coder' });
    await completeParentTurn(bridge, adapter, streamId);
    bridge.calls!.length = 0;
    const created = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' },
    });
    assert.equal(created.ok, true);
    const snapshot = resultSchemas['sidechat.create'].parse(created.result).sidechat;
    assert.equal(snapshot.id, 'sc1');
    assert.equal(snapshot.parentSessionId, 's1');
    assert.notEqual(snapshot.streamId, streamId);
    assert.equal(snapshot.state, 'idle');
    assert.ok(snapshot.resumeRef.id.length > 0, 'resumeRef must be present');
    assert.deepEqual(snapshot.anchor, { type: 'turn', turnId: 'turn-1', sourceTurnId: 'native-1:turn:0' });
    assert.deepEqual(snapshot.sessionConfig, { agent_preset: 'coder' }, 'config must be inherited verbatim');
    const forkCall = bridge.calls!.find(call => call.method === 'session.fork');
    assert.equal(forkCall?.params.newSessionId, 'sc1');
    assert.deepEqual(forkCall?.params.anchor, { kind: 'turn', nativeTurn: 0 });
  });

  it('creates an empty-anchored Side Chat for a parent without accepted turns', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    const created = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc-empty' },
    });
    assert.equal(created.ok, true);
    assert.deepEqual(sidechat(created.result).anchor, { type: 'empty' });
    const forkCall = bridge.calls!.find(call => call.method === 'session.fork');
    assert.deepEqual(forkCall?.params.anchor, { kind: 'head' });
  });

  it('refuses a busy parent instead of picking a nearby boundary', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    await adapter.dispatch({
      id: 't', method: 'turn.start',
      params: { sessionId: 's1', streamId, turnId: 'turn-1', input: [{ type: 'text', text: 'go' }], config: { model: 'deepseek-chat' } },
    });
    const busy = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc-busy' },
    });
    assert.equal(busy.error?.data?.domainCode, 'SESSION_BUSY');
  });

  it('is idempotent per sidechatId and conflicts across parents and ordinary sessions', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    await completeParentTurn(bridge, adapter, streamId);
    const params = { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' };
    const first = await adapter.dispatch({ id: 'a', method: 'sidechat.create', params });
    const retry = await adapter.dispatch({ id: 'b', method: 'sidechat.create', params });
    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(sidechat(retry.result).resumeRef.id, sidechat(first.result).resumeRef.id);
    assert.equal(sidechat(retry.result).streamId, sidechat(first.result).streamId);
    const staleStream = await adapter.dispatch({
      id: 'c', method: 'sidechat.create',
      params: { ...params, sidechatId: 'sc-stale', parentStreamId: 'stream-nope' },
    });
    assert.equal(staleStream.error?.data?.domainCode, 'SESSION_STALE');
    const collided = await adapter.dispatch({
      id: 'd', method: 'sidechat.create',
      params: { ...params, sidechatId: 's1' },
    });
    assert.equal(collided.error?.data?.domainCode, 'CONFLICT');
  });
});

describe('sidechat method matrix', () => {
  it('core Session Methods reject sidechatId while the Side Chat route turns', async () => {
    const bridge = fakeBridge();
    const { adapter, notifications, streamId } = await setup(bridge);
    await completeParentTurn(bridge, adapter, streamId);
    const created = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' },
    });
    assert.equal(created.ok, true);
    const sideStreamId = sidechat(created.result).streamId;

    for (const method of ['session.get', 'session.replay', 'session.close']) {
      const rejected = await adapter.dispatch({
        id: `m-${method}`, method,
        params: { sessionId: 'sc1', streamId: sideStreamId },
      });
      assert.equal(rejected.error?.data?.domainCode, 'SESSION_NOT_FOUND', `${method} must reject sidechatId`);
    }
    const forkFromSidechat = await adapter.dispatch({
      id: 'm-fork', method: 'session.fork',
      params: { sourceSessionId: 'sc1', sourceStreamId: sideStreamId, sessionId: 'f1', anchor: { type: 'head' } },
    });
    assert.equal(forkFromSidechat.error?.data?.domainCode, 'SESSION_NOT_FOUND');

    // The Side Chat route itself turns through the standard envelope. Events
    // emitted while the request is in flight ride the dispatch outcome (the
    // CLI writes them after the response, contract §16).
    const turn = await adapter.dispatch({
      id: 'm-turn', method: 'turn.start',
      params: { sessionId: 'sc1', streamId: sideStreamId, turnId: 'sc-turn-1', input: [{ type: 'text', text: 'hi' }], config: { model: 'deepseek-chat' } },
    });
    assert.equal(turn.ok, true);
    const sideStarted = turn.notifications?.find(event => event.method === 'turn.started'
      && event.params.sessionId === 'sc1');
    assert.ok(sideStarted, 'sidechat turn.started must flow under the sidechatId');
    // The fork child inherits the parent's durable turn prefix, so its own
    // first turn continues at the parent's ordinal count.
    bridge.push('session.event', {
      sessionId: 'sc1', nativeSeq: 5, type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    const completed = notifications.filter(event => event.method === 'turn.completed'
      && event.params.sessionId === 'sc1');
    assert.equal(completed.length, 1);
  });
});

describe('sidechat.resume', () => {
  it('re-attaches the sealed native context after a proxy restart with a fresh stream', async () => {
    // A shared plugin data dir is what lets a resumeRef survive the proxy
    // process; the shared native store is the DSH profile persistence, and a
    // second bridge with empty sessions is the respawned bridge process.
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-sidechat-'));
    const nativeStore: NativeStore = new Map();
    const previousDataDir = process.env.GIAN_PLUGIN_DATA_DIR;
    process.env.GIAN_PLUGIN_DATA_DIR = dataDir;
    try {
      const bridge = fakeBridge({ store: nativeStore });
      const first = await setup(bridge);
      await completeParentTurn(bridge, first.adapter, first.streamId);
      const created = await first.adapter.dispatch({
        id: 'sc', method: 'sidechat.create',
        params: { parentSessionId: 's1', parentStreamId: first.streamId, sidechatId: 'sc1' },
      });
      assert.equal(created.ok, true);
      const original = sidechat(created.result);

      // "Restarted" proxy: fresh adapter over a fresh bridge process.
      const restartedBridge = fakeBridge({ store: nativeStore });
      const restarted = new DshV2Adapter(restartedBridge as never, { pluginVersion: '0.3.2' });
      restarted.setEmitSink(() => undefined);
      const init = await restarted.dispatch({
        id: 'init2', method: 'initialize',
        params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'Gian', version: '1.0.0' } },
      });
      assert.equal(init.ok, true);
      const parent = await restarted.dispatch({
        id: 'create2', method: 'session.create',
        params: { sessionId: 's1', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: {} },
      });
      assert.equal(parent.ok, true);

      restartedBridge.calls!.length = 0;
      const resumed = await restarted.dispatch({
        id: 'r', method: 'sidechat.resume',
        params: { sidechatId: 'sc1', parentSessionId: 's1', resumeRef: original.resumeRef },
      });
      assert.equal(resumed.ok, true);
      const snapshot = resultSchemas['sidechat.resume'].parse(resumed.result).sidechat;
      assert.equal(snapshot.id, 'sc1');
      assert.equal(snapshot.parentSessionId, 's1');
      assert.notEqual(snapshot.streamId, original.streamId, 'resume must mint a new attach generation');
      assert.deepEqual(snapshot.anchor, original.anchor);
      assert.equal(snapshot.resumeRef.id, original.resumeRef.id, 'resume keeps the ref without rotation');
      const resumeCall = restartedBridge.calls!.find(call => call.method === 'session.resume');
      assert.equal(resumeCall?.params.nativeSessionId, 'native-2');

      // Identical retry replays the first result instead of re-attaching.
      restartedBridge.calls!.length = 0;
      const retry = await restarted.dispatch({
        id: 'r2', method: 'sidechat.resume',
        params: { sidechatId: 'sc1', parentSessionId: 's1', resumeRef: original.resumeRef },
      });
      assert.equal(sidechat(retry.result).streamId, snapshot.streamId);
      assert.equal(restartedBridge.calls!.filter(call => call.method === 'session.resume').length, 0);
      const foreign = await restarted.dispatch({
        id: 'r3', method: 'sidechat.resume',
        params: { sidechatId: 'sc1', parentSessionId: 'other', resumeRef: original.resumeRef },
      });
      assert.equal(foreign.error?.data?.domainCode, 'CONFLICT');
    } finally {
      if (previousDataDir === undefined) delete process.env.GIAN_PLUGIN_DATA_DIR;
      else process.env.GIAN_PLUGIN_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses to resume without an attached parent Session', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    await completeParentTurn(bridge, adapter, streamId);
    const created = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' },
    });
    const original = sidechat(created.result);
    const orphan = await adapter.dispatch({
      id: 'r', method: 'sidechat.resume',
      params: { sidechatId: 'sc1', parentSessionId: 'ghost-parent', resumeRef: original.resumeRef },
    });
    assert.equal(orphan.error?.data?.domainCode, 'CONFLICT');
  });
});

describe('sidechat.close', () => {
  it('terminalizes the active turn before success and reports provider data honestly', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    await completeParentTurn(bridge, adapter, streamId);
    const created = await adapter.dispatch({
      id: 'sc', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' },
    });
    const original = sidechat(created.result);
    await adapter.dispatch({
      id: 'st', method: 'turn.start',
      params: { sessionId: 'sc1', streamId: original.streamId, turnId: 'sc-turn-1', input: [{ type: 'text', text: 'run' }], config: { model: 'deepseek-chat' } },
    });
    const closed = await adapter.dispatch({
      id: 'x', method: 'sidechat.close',
      params: { sidechatId: 'sc1', streamId: original.streamId, resumeRef: original.resumeRef },
    });
    assert.equal(closed.ok, true);
    assert.deepEqual(closed.result, { ok: true, sidechatId: 'sc1', providerDataDeleted: false });
    // The teardown events ride the close dispatch outcome; the CLI writes
    // them BEFORE the Success response (10.5.4 barrier, wire-verified in the
    // protocol-v2-cli suite).
    const teardown = closed.notifications ?? [];
    const terminal = teardown.find(event => event.method === 'turn.completed'
      && event.params.sessionId === 'sc1');
    assert.ok(terminal, 'the active sidechat turn must reach a terminal event');
    assert.equal((terminal.params.data as { stopReason: string }).stopReason, 'cancelled');
    assert.equal(bridge.calls!.filter(call => call.method === 'session.close'
      && call.params.sessionId === 'sc1').length, 1);
    // The route is gone: turning it again must be SESSION_NOT_FOUND.
    const gone = await adapter.dispatch({
      id: 'st2', method: 'turn.start',
      params: { sessionId: 'sc1', streamId: original.streamId, turnId: 'sc-turn-2', input: [{ type: 'text', text: 'x' }], config: { model: 'deepseek-chat' } },
    });
    assert.equal(gone.error?.data?.domainCode, 'SESSION_NOT_FOUND');
    // Idempotent repeat close returns the same success from the tombstone.
    const repeat = await adapter.dispatch({
      id: 'x2', method: 'sidechat.close',
      params: { sidechatId: 'sc1', resumeRef: original.resumeRef },
    });
    assert.deepEqual(repeat.result, { ok: true, sidechatId: 'sc1', providerDataDeleted: false });
    // Resume after close refuses instead of reviving a deleted conversation.
    const revived = await adapter.dispatch({
      id: 'r', method: 'sidechat.resume',
      params: { sidechatId: 'sc1', parentSessionId: 's1', resumeRef: original.resumeRef },
    });
    assert.equal(revived.error?.data?.domainCode, 'SIDECHAT_UNAVAILABLE');
  });

  it('converges for unknown references and conflicts for foreign ones', async () => {
    const bridge = fakeBridge();
    const { adapter, streamId } = await setup(bridge);
    await completeParentTurn(bridge, adapter, streamId);
    const first = sidechat((await adapter.dispatch({
      id: 'sc1', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc1' },
    })).result);
    const second = sidechat((await adapter.dispatch({
      id: 'sc2', method: 'sidechat.create',
      params: { parentSessionId: 's1', parentStreamId: streamId, sidechatId: 'sc2' },
    })).result);
    const foreign = await adapter.dispatch({
      id: 'x1', method: 'sidechat.close',
      params: { sidechatId: 'sc1', resumeRef: second.resumeRef },
    });
    assert.equal(foreign.error?.data?.domainCode, 'CONFLICT');
    const stale = await adapter.dispatch({
      id: 'x2', method: 'sidechat.close',
      params: { sidechatId: 'sc1', streamId: 'stream-gone', resumeRef: first.resumeRef },
    });
    assert.equal(stale.error?.data?.domainCode, 'SESSION_STALE');
    const unknown = await adapter.dispatch({
      id: 'x3', method: 'sidechat.close',
      params: { sidechatId: 'sc-ghost', resumeRef: { id: 'no-such-ref' } },
    });
    assert.deepEqual(unknown.result, { ok: true, sidechatId: 'sc-ghost', providerDataDeleted: false });
    const live = await adapter.dispatch({
      id: 'x4', method: 'sidechat.close',
      params: { sidechatId: 'sc1', resumeRef: first.resumeRef },
    });
    assert.deepEqual(live.result, { ok: true, sidechatId: 'sc1', providerDataDeleted: false });
  });
});
