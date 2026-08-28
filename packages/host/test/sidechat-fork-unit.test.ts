import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProxyProtocolError, requestViolation, redactSensitiveProtocolValue } from '@gian/proxy-protocol';
import { openDatabase } from '../src/storage/db.js';
import {
  assertInheritedSessionConfig,
  persistedForkBoundaries,
  resolveForkAnchor,
} from '../src/session/fork.js';
import {
  SidechatTransientStore,
  publicSidechatState,
  toPublicSidechat,
  type SidechatRecord,
} from '../src/session/sidechat-store.js';
import { SidechatCoordinator } from '../src/session/sidechat-coordinator.js';
import { deriveSidechatAgentTitle } from '../src/session/sidechat-title.js';
import { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';

const options = [{
  id: 'execution_mode',
  displayName: 'Mode',
  binding: 'session' as const,
  control: 'select' as const,
  required: true,
  defaultValue: 'agent',
  choices: [
    { value: 'agent', displayName: 'Agent' },
    { value: 'plan', displayName: 'Plan' },
  ],
}];

function record(overrides: Partial<SidechatRecord> = {}): SidechatRecord {
  return {
    sidechatId: 'sc_1',
    parentSessionId: 's1',
    ordinal: 1,
    name: null,
    parentStreamId: 'stream-1',
    streamId: 'stream-sc',
    streamGeneration: 1,
    resumeRefId: 'opaque-ref',
    status: 'open',
    anchor: { type: 'empty' },
    sessionConfig: {},
    turnConfig: {},
    turnConfigOptions: [],
    turnConfigRevision: null,
    publicState: 'idle',
    events: [],
    userInputs: [],
    lastError: null,
    uncertainTurnId: null,
    closeResult: null,
    createFingerprint: 's1\u0000stream-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sidechat-unit-'));
  const db = openDatabase(dir);
  return {
    dir,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Side Chat title prefers an Agent heading and falls back from generic replies', () => {
  const titled = record({
    events: [{
      method: 'content.completed',
      params: {
        turnId: 'turn-1',
        data: {
          kind: 'text',
          content: '## Diagnose Fork cleanup\n\nThe durable boundary used the wrong id.',
        },
      },
    }],
    userInputs: [{
      turnId: 'turn-1',
      input: [{ type: 'text', text: 'Why does Fork cleanup fail?' }],
      createdAt: '2026-08-26T08:00:00.000Z',
    }],
  });
  assert.equal(deriveSidechatAgentTitle(titled, 'turn-1'), 'Diagnose Fork cleanup');

  titled.events = [{
    method: 'content.completed',
    params: { turnId: 'turn-1', data: { kind: 'text', content: 'Done.' } },
  }];
  assert.equal(deriveSidechatAgentTitle(titled, 'turn-1'), 'Why does Fork cleanup fail?');
});

test('listing legacy open Side Chats backfills a missing completed-turn title', () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record({
      name: null,
      events: [{
        method: 'content.completed',
        params: {
          turnId: 'turn-1',
          data: { kind: 'text', content: '# Recover Side Chat titles' },
        },
      }, {
        method: 'turn.completed',
        params: { turnId: 'turn-1', data: { stopReason: 'completed' } },
      }],
      userInputs: [{
        turnId: 'turn-1',
        input: [{ type: 'text', text: 'Recover this title' }],
        createdAt: '2026-08-26T08:00:00.000Z',
      }],
    }));
    const coordinator = new SidechatCoordinator(
      store,
      { get() { return undefined; } } as never,
      { broadcast() {} } as never,
    );
    assert.equal(coordinator.listPublic()[0]?.name, 'Recover Side Chat titles');
    assert.equal(store.get('sc_1')?.name, 'Recover Side Chat titles');
  } finally {
    ctx.close();
  }
});

test('fork head and atTurn require an exact terminal Turn', () => {
  const ctx = tempDb();
  try {
    ctx.db.prepare(
      `INSERT INTO workspaces (id, name, path) VALUES ('ws', 'ws', '/tmp/ws')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO sessions (id, workspace_id, executor, native_session_id, created_at, updated_at)
       VALUES ('s1', 'ws', 'claude', 'native-1', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run();

    assert.throws(
      () => resolveForkAnchor(ctx.db, 's1', { type: 'head' }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'FORK_BOUNDARY_UNAVAILABLE',
    );

    ctx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at)
       VALUES ('t1', 's1', 1, 'completed', '2026-08-20T00:00:00.000Z')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
       VALUES ('s1', 'src-1', 't1')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at)
       VALUES ('t2', 's1', 2, 'error', '2026-08-20T00:01:00.000Z'),
              ('t3', 's1', 3, 'running', '2026-08-20T00:02:00.000Z')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
       VALUES ('s1', 'src-2', 't2'), ('s1', 'src-3', 't3')`,
    ).run();

    assert.deepEqual(persistedForkBoundaries(ctx.db, 's1'), [
      { turnId: 't1', sourceTurnId: 'src-1' },
      { turnId: 't2', sourceTurnId: 'src-2' },
    ]);

    assert.deepEqual(resolveForkAnchor(ctx.db, 's1', { type: 'head' }), {
      turnId: 't2',
      sourceTurnId: 'src-2',
    });
    assert.deepEqual(
      resolveForkAnchor(ctx.db, 's1', { type: 'turn', turnId: 't1', sourceTurnId: 'src-1' }),
      { turnId: 't1', sourceTurnId: 'src-1' },
    );
    assert.throws(
      () => resolveForkAnchor(ctx.db, 's1', { type: 'turn', turnId: 't1', sourceTurnId: 'adjacent' }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'FORK_BOUNDARY_UNAVAILABLE',
    );
  } finally {
    ctx.close();
  }
});

test('fork inherits session-bound config without defaults or silent repair', () => {
  const mixed = [
    ...options,
    {
      id: 'effort',
      displayName: 'Effort',
      binding: 'turn' as const,
      control: 'select' as const,
      required: false,
      defaultValue: 'medium',
      choices: [
        { value: 'low', displayName: 'Low' },
        { value: 'medium', displayName: 'Medium' },
      ],
    },
  ];
  assert.throws(
    () => assertInheritedSessionConfig(mixed, { execution_mode: 'agent', effort: 'low' }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_BINDING_INVALID',
  );
  assert.throws(
    () => assertInheritedSessionConfig(options, {}),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_REQUIRED',
  );
  assert.throws(
    () => assertInheritedSessionConfig(options, { execution_mode: 'broken' }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_VALUE_INVALID',
  );
  assert.throws(
    () => assertInheritedSessionConfig(options, {
      execution_mode: 'agent',
      retired_session_flag: true,
    }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_VALUE_INVALID',
  );
});

test('unknown resumeRef close converges and never claims Provider deletion', async () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    const coordinator = new SidechatCoordinator(store, {
      get() { return undefined; },
    } as never, { broadcast() {} } as never);

    const unknown = await coordinator.close('sc_ghost');
    assert.deepEqual(unknown, {
      ok: true,
      sidechatId: 'sc_ghost',
      providerDataDeleted: false,
    });

    store.upsert(record({
      sidechatId: 'sc_live',
      resumeRefId: 'opaque-ref-other',
    }));
    store.upsert(record({
      sidechatId: 'sc_close',
      streamId: 'stream-sc-2',
      resumeRefId: 'opaque-ref-other',
    }));
    await assert.rejects(
      coordinator.close('sc_close'),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
    assert.equal(store.get('sc_live')?.status, 'open');
    assert.equal(store.get('sc_close')?.status, 'open');
  } finally {
    ctx.close();
  }
});

test('unknown resumeRef close of a live record converges without claiming deletion', async () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record({ sidechatId: 'sc_gone' }));
    const coordinator = new SidechatCoordinator(store, {
      get() {
        return {
          protocolV2: true,
          closeSidechat() {
            throw requestViolation('SESSION_NOT_FOUND', 'unknown resumeRef');
          },
        };
      },
    } as never, { broadcast() {} } as never);
    const result = await coordinator.close('sc_gone');
    assert.deepEqual(result, {
      ok: true,
      sidechatId: 'sc_gone',
      providerDataDeleted: false,
    });
    assert.equal(store.get('sc_gone'), null);
  } finally {
    ctx.close();
  }
});

test('uncertain Side Chat close keeps closing and does not delete the record', async () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record({ sidechatId: 'sc_runtime' }));
    const missingParent = new SidechatCoordinator(store, {
      get() { return undefined; },
    } as never, { broadcast() {} } as never);
    await assert.rejects(
      missingParent.close('sc_runtime'),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'RUNTIME_ERROR',
    );
    assert.equal(store.get('sc_runtime')?.status, 'closing');

    store.upsert(record({ sidechatId: 'sc_err', resumeRefId: 'opaque-err' }));
    const failingParent = new SidechatCoordinator(store, {
      get() {
        return {
          protocolV2: true,
          closeSidechat() {
            throw requestViolation('RUNTIME_ERROR', 'proxy disconnected');
          },
        };
      },
    } as never, { broadcast() {} } as never);
    await assert.rejects(
      failingParent.close('sc_err'),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'RUNTIME_ERROR',
    );
    assert.equal(store.get('sc_err')?.status, 'closing');
  } finally {
    ctx.close();
  }
});

test('public Side Chat snapshots and ordinary projections never include resumeRef', () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record({
      resumeRefId: 'opaque-secret-ref',
      sessionConfig: { execution_mode: 'agent' },
      events: [{ params: { resumeRef: 'opaque-secret-ref' } }],
      userInputs: [{
        turnId: 't1',
        input: { resume_ref_id: 'opaque-secret-ref' },
        createdAt: '2026-08-20T00:00:00.000Z',
      }],
      createFingerprint: 's1',
    }));
    const publicSnapshot = toPublicSidechat(store.get('sc_1')!);
    assert.equal(publicSnapshot.user_inputs.length, 1);
    assert.equal(publicSnapshot.user_inputs[0]?.turn_id, 't1');
    assert.equal('resumeRef' in publicSnapshot, false);
    assert.equal('resume_ref' in publicSnapshot, false);
    assert.doesNotMatch(JSON.stringify(publicSnapshot), /opaque-secret-ref/);
    assert.equal(
      (redactSensitiveProtocolValue({ resumeRef: 'opaque-secret-ref' }) as { resumeRef: string }).resumeRef,
      '[REDACTED]',
    );

    const sessions = ctx.db.prepare('SELECT id FROM sessions').all();
    const events = ctx.db.prepare('SELECT id FROM events').all();
    const traces = ctx.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='trace_events'",
    ).all();
    assert.deepEqual(sessions, []);
    assert.deepEqual(events, []);
    assert.ok(Array.isArray(traces));
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sidechat_transients').get() as { n: number }).n,
      1,
    );
  } finally {
    ctx.close();
  }
});

test('forkSession unregisters the child when replay fails after attach', async () => {
  const registered = new Map<string, ProtocolV2SessionClient>();
  const requests: string[] = [];
  const host = {
    async request(method: string) {
      requests.push(method);
      if (method === 'session.fork') {
        return {
          session: {
            id: 'fork-1',
            streamId: 'stream-fork',
            state: 'idle',
            nativeSession: { id: 'native-fork-1' },
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
          origin: {
            kind: 'fork',
            sessionId: 's1',
            turnId: 't1',
            sourceTurnId: 'src-1',
          },
        };
      }
      if (method === 'session.replay') throw new Error('replay exploded');
      if (method === 'session.close') return {};
      throw new Error(`unexpected ${method}`);
    },
    createSessionClient(sessionId: string) {
      const existing = registered.get(sessionId);
      if (existing) return existing;
      const client = new ProtocolV2SessionClient(this as never, sessionId);
      registered.set(sessionId, client);
      return client;
    },
    unregister(sessionId: string, session: ProtocolV2SessionClient) {
      if (registered.get(sessionId) === session) registered.delete(sessionId);
    },
  };
  const parent = host.createSessionClient('s1');
  parent.attachFromSnapshot('stream-1');
  await assert.rejects(
    parent.forkSession({ sessionId: 'fork-1', anchor: { type: 'head' } }),
    /replay exploded/,
  );
  assert.equal(registered.has('fork-1'), false);
  assert.ok(requests.includes('session.close'));
});

test('forkSession reports leftover Provider resources when cleanup fails', async () => {
  const registered = new Map<string, ProtocolV2SessionClient>();
  const host = {
    async request(method: string) {
      if (method === 'session.fork') {
        return {
          session: {
            id: 'fork-1',
            streamId: 'stream-fork',
            state: 'idle',
            nativeSession: { id: 'native-fork-1' },
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
          origin: {
            kind: 'fork',
            sessionId: 's1',
            turnId: 't1',
            sourceTurnId: 'src-1',
          },
        };
      }
      if (method === 'session.replay') throw new Error('replay exploded');
      if (method === 'session.close') throw new Error('close blocked');
      if (method === 'session.native.delete') throw new Error('native still live');
      throw new Error(`unexpected ${method}`);
    },
    createSessionClient(sessionId: string) {
      const existing = registered.get(sessionId);
      if (existing) return existing;
      const client = new ProtocolV2SessionClient(this as never, sessionId);
      registered.set(sessionId, client);
      return client;
    },
    unregister(sessionId: string, session: ProtocolV2SessionClient) {
      if (registered.get(sessionId) === session) registered.delete(sessionId);
    },
    deleteNativeSession() {
      return this.request('session.native.delete');
    },
  };
  const parent = host.createSessionClient('s1');
  parent.attachFromSnapshot('stream-1');
  await assert.rejects(
    parent.forkSession({ sessionId: 'fork-1', anchor: { type: 'head' } }),
    (error: unknown) => (
      error instanceof ProxyProtocolError
      && error.code === 'RUNTIME_ERROR'
      && /session.close failed/.test(error.message)
      && /session.native.delete failed/.test(error.message)
    ),
  );
  assert.equal(registered.has('fork-1'), false);
});

test('forkSession refuses a Result without durable nativeSession', async () => {
  const registered = new Map<string, ProtocolV2SessionClient>();
  const host = {
    async request(method: string) {
      if (method === 'session.fork') {
        return {
          session: {
            id: 'fork-1',
            streamId: 'stream-fork',
            state: 'idle',
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
          origin: {
            kind: 'fork',
            sessionId: 's1',
            turnId: 't1',
            sourceTurnId: 'src-1',
          },
        };
      }
      if (method === 'session.close') return {};
      throw new Error(`unexpected ${method}`);
    },
    createSessionClient(sessionId: string) {
      const existing = registered.get(sessionId);
      if (existing) return existing;
      const client = new ProtocolV2SessionClient(this as never, sessionId);
      registered.set(sessionId, client);
      return client;
    },
    unregister(sessionId: string, session: ProtocolV2SessionClient) {
      if (registered.get(sessionId) === session) registered.delete(sessionId);
    },
  };
  const parent = host.createSessionClient('s1');
  parent.attachFromSnapshot('stream-1');
  await assert.rejects(
    parent.forkSession({ sessionId: 'fork-1', anchor: { type: 'head' } }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'INTERNAL',
  );
  assert.equal(registered.has('fork-1'), false);
});

test('public Side Chat state is persisted and survives event-buffer eviction', () => {
  assert.equal(publicSidechatState(record({ status: 'closing' })), 'stale');
  assert.equal(publicSidechatState(record({ status: 'unavailable' })), 'error');
  assert.equal(toPublicSidechat(record({ status: 'closing' })).state, 'stale');

  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record());
    store.appendEvent('sc_1', { method: 'turn.started', params: { turnId: 't1' } });
    assert.equal(publicSidechatState(store.get('sc_1')!), 'running');
    store.appendEvent('sc_1', { method: 'interaction.requested', params: { turnId: 't1' } });
    assert.equal(publicSidechatState(store.get('sc_1')!), 'waiting_interaction');
    store.appendEvent('sc_1', { method: 'interaction.resolved', params: { turnId: 't1' } });
    assert.equal(publicSidechatState(store.get('sc_1')!), 'running');
    store.appendEvent('sc_1', { method: 'turn.failed', params: { turnId: 't1' } });
    assert.equal(publicSidechatState(store.get('sc_1')!), 'error');

    store.appendEvent('sc_1', { method: 'turn.started', params: { turnId: 't2' } });
    for (let index = 0; index < 200; index += 1) {
      store.appendEvent('sc_1', {
        method: 'activity.updated',
        params: {
          turnId: 't2',
          data: { activityId: `activity-${index}`, status: 'succeeded' },
        },
      });
    }
    const persisted = store.get('sc_1')!;
    assert.equal(persisted.events.some((event) => eventMethod(event) === 'turn.started'), false);
    assert.equal(publicSidechatState(persisted), 'running');
    assert.equal(toPublicSidechat(persisted).state, 'running');
  } finally {
    ctx.close();
  }
});

test('Side Chat event compaction preserves the first assistant turn while the second turn streams', () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record());
    store.appendEvent('sc_1', {
      method: 'content.completed',
      params: {
        turnId: 't1',
        data: { contentId: 'answer-1', kind: 'text', content: 'first answer' },
      },
    });
    store.appendEvent('sc_1', { method: 'turn.completed', params: { turnId: 't1' } });
    store.appendEvent('sc_1', { method: 'turn.started', params: { turnId: 't2' } });
    for (let index = 0; index < 250; index += 1) {
      store.appendEvent('sc_1', {
        method: 'usage.updated',
        params: { turnId: 't2', data: { context: { used: index } } },
      });
      store.appendEvent('sc_1', {
        method: 'step.updated',
        params: { turnId: 't2', data: { stepId: `step-${index}` } },
      });
      store.appendEvent('sc_1', {
        method: 'content.delta',
        params: {
          turnId: 't2',
          data: { contentId: 'answer-2', kind: 'text', delta: String(index % 10) },
        },
      });
    }

    const persisted = store.get('sc_1')!;
    assert.equal(persisted.events.length, 4);
    assert.equal(
      persisted.events.some((event) => (
        eventMethod(event) === 'content.completed'
        && eventData(event).content === 'first answer'
      )),
      true,
    );
    const second = persisted.events.find((event) => eventMethod(event) === 'content.delta');
    assert.equal(String(eventData(second).delta).length, 250);
  } finally {
    ctx.close();
  }
});

function eventMethod(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const method = (event as { method?: unknown }).method;
  return typeof method === 'string' ? method : null;
}

function eventData(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {};
  const params = (event as { params?: { data?: unknown } }).params;
  return params?.data && typeof params.data === 'object'
    ? params.data as Record<string, unknown>
    : {};
}

test('Side Chat user inputs append across turns and appear on the public snapshot', () => {
  const ctx = tempDb();
  try {
    const store = new SidechatTransientStore(ctx.db);
    store.upsert(record());
    store.appendUserInput('sc_1', 't1', [{ type: 'text', text: 'first' }]);
    store.appendUserInput('sc_1', 't2', [{ type: 'text', text: 'second' }]);
    const persisted = store.get('sc_1')!;
    assert.equal(persisted.userInputs.length, 2);
    assert.equal(persisted.userInputs[0]?.turnId, 't1');
    assert.equal(persisted.userInputs[1]?.turnId, 't2');
    const publicSnapshot = toPublicSidechat(persisted);
    assert.deepEqual(publicSnapshot.user_inputs.map((entry) => entry.turn_id), ['t1', 't2']);
    assert.deepEqual(publicSnapshot.user_inputs[0]?.input, [{ type: 'text', text: 'first' }]);
    assert.deepEqual(publicSnapshot.user_inputs[1]?.input, [{ type: 'text', text: 'second' }]);
  } finally {
    ctx.close();
  }
});
